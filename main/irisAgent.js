/*
 * main/irisAgent.js  —  the privileged half of the Iris AI agent.
 *
 * This file is concatenated into main.build.js (it shares scope with Min's other main
 * process modules, so `settings`, `windows`, `viewMap`, `getView` and `ipc` are available).
 *
 * It owns exactly three privileged capabilities, and nothing else:
 *
 *   1. SEE      — webContents.capturePage()  → a PNG/JPEG of the tab, in device pixels
 *   2. ACT      — webContents.sendInputEvent() → real mouse / wheel / key events
 *   3. REPORT   — page load state, url, and "a human touched the page" counters
 *
 * It never evaluates JavaScript in the page, never touches the DOM, and never speaks a
 * automation protocol. All of the thinking lives in iris/agent/*, which is Electron-free.
 */

const { desktopCapturer, webContents: allWebContents } = require('electron')
const irisActionSchema = require('./iris/agent/actionSchema.js')
const irisMapper = require('./iris/agent/coordinateMapper.js')
const irisInputPlan = require('./iris/agent/inputPlan.js')
const irisLoop = require('./iris/agent/agentLoop.js')
const irisModelClient = require('./iris/agent/modelClient.js')

const IRIS_DEFAULT_SETTINGS = {
  baseUrl: 'http://192.168.1.252:13305/v1',
  model: 'Qwen3.8-Flash-Next-GGUF-IQ4_NL',
  apiKey: '',
  maxSteps: 25,
  temperature: 0.2,
  maxTokens: 700,
  modelTimeoutMs: 90000,
  keepImages: 2,
  screenshotMaxDimension: 1568,
  screenshotQuality: 72,
  markerEnabled: true,
  autoPauseOnUserInput: true,
  allowSensitiveActions: false
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms || 0))



function irisSettings () {
  const stored = settings.get('irisAI') || {}
  return Object.assign({}, IRIS_DEFAULT_SETTINGS, stored)
}

/* ------------------------------------------------------------------ *
 * The "computer": what the agent can see and do
 * ------------------------------------------------------------------ */

function IrisComputer (tabId, config, onInject, viewBounds) {
  this.tabId = tabId
  // the browser UI tells us where the page area is, so a tab whose view has not been
  // attached yet (a fresh tab, the new-tab page) can still be captured
  this.fallbackBounds = viewBounds || null
  this.config = config
  this.onInject = onInject || function () {}
  this.takeoverCount = 0
  this.injectingUntil = 0
  this.lastError = null
}

IrisComputer.prototype.view = function () {
  const view = getView(this.tabId)
  if (!view || !view.webContents || view.webContents.isDestroyed()) {
    throw new Error('the tab the agent is working in is gone')
  }
  return view
}

const DEBUG_LOG = process.env.IRIS_AGENT_DEBUG || ''
function DBUG (m) {
  if (!DEBUG_LOG) return
  try { require('fs').appendFileSync(DEBUG_LOG, new Date().toISOString() + ' ' + m + '\n') } catch (e) { /* logging must never break the agent */ }
}

/*
 * Capturing what the user sees.
 *
 * webContents.capturePage() on a WebContentsView is unreliable on macOS (it can reject with
 * UnknownVizError or never settle at all, which would stall the whole agent), so Iris grabs
 * the window's own composited image through desktopCapturer and crops it to the tab's view
 * rectangle. Same pixels, same device-pixel scale, no dependency on the view's compositor.
 *
 * The mapping never assumes a scale factor: the image size and the view size are carried
 * separately and the coordinate mapper derives the ratio (see iris/agent/coordinateMapper.js).
 */
/**
 * Which BrowserWindow hosts a given WebContentsView's contents. Min's own
 * windowFromContents() only ever looks at the window's primary contents, so Iris walks the
 * whole view tree instead.
 */
function findWindowForWebContents (webContents) {
  const wins = windows.openWindows || []
  for (let i = 0; i < wins.length; i++) {
    const win = wins[i].win
    if (!win || win.isDestroyed()) continue
    const children = win.getContentView().children || []
    for (let j = 0; j < children.length; j++) {
      const child = children[j]
      if (child && child.webContents && !child.webContents.isDestroyed() && child.webContents.id === webContents.id) {
        return win
      }
    }
  }
  return null
}

async function captureWindowOf (win) {
  DBUG('captureWindowOf:enter')
  const frame = win.getBounds()
  DBUG('captureWindowOf:frame ' + JSON.stringify(frame))
  const scale = win.getContentBounds().width ? Math.max(1, Math.round((win.getContentBounds().width * 2) / frame.width)) : 2

  DBUG('captureWindowOf: asking desktopCapturer for ' + frame.width + 'x' + frame.height)
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: Math.round(frame.width * scale), height: Math.round(frame.height * scale) },
    fetchWindowIcons: false
  })

  const title = win.getTitle()
  let source = sources.find(function (s) { return s.name === title && title })

  if (!source) {
    source = sources.find(function (s) {
      const size = s.thumbnail.getSize()
      return size.width > 0 && !/marker/i.test(s.name)
    })
  }

  DBUG('capture getSources -> ' + sources.length + ' sources')
  if (!source) throw new Error('could not capture the browser window')

  return { image: source.thumbnail, frame: frame, scale: source.thumbnail.getSize().width / frame.width }
}

IrisComputer.prototype.capture = async function (wc) {
  const view = this.view()
  const parent = findWindowForWebContents(wc) || windows.getCurrent()
  if (!parent || parent.isDestroyed()) {
    throw new Error('cannot capture: this tab has no window')
  }

  const viewBounds = view.getBounds()
  const bounds = viewBounds.width && viewBounds.height ? viewBounds : this.fallbackBounds
  if (!bounds || !bounds.width || !bounds.height) {
    throw new Error('the page has not painted yet')
  }

  const captured = await captureWindowOf(parent)
  const cb = parent.getContentBounds()
  const scale = captured.scale

  const image = captured.image.crop({
    x: Math.max(0, Math.round((cb.x - captured.frame.x + bounds.x) * scale)),
    y: Math.max(0, Math.round((cb.y - captured.frame.y + bounds.y) * scale)),
    width: Math.max(1, Math.round(bounds.width * scale)),
    height: Math.max(1, Math.round(bounds.height * scale))
  })

  const size = image.getSize()
  if (!size.width || !size.height) {
    throw new Error('the page has not painted yet')
  }

  DBUG('capture ok ' + JSON.stringify(size) + ' scale ' + scale + ' url ' + wc.getURL())
  return image
}

IrisComputer.prototype.screenshot = async function () {
  const view = this.view()
  const wc = view.webContents
  const bounds = view.getBounds()
  if (bounds.width && bounds.height) {
    this.fallbackBounds = bounds
  }

  let image
  try {
    image = await this.capture(wc)
  } catch (err) {
    DBUG('screenshot attempt failed: ' + err.message + ' — retrying')
    // A tab that has never painted yields an empty image; give it a moment and retry once.
    await sleep(250)
    image = await this.capture(wc)
  }

  const size = image.getSize()
  if (!size.width || !size.height) {
    throw new Error('the page has not painted yet')
  }

  return this.finishCapture(image, size, bounds, wc)
}

IrisComputer.prototype.finishCapture = function (image, size, bounds, wc) {
  const maxDim = this.config.screenshotMaxDimension
  const fitted = irisMapper.fitDimensions(size.width, size.height, maxDim)

  let payload = image
  if (fitted.width !== size.width || fitted.height !== size.height) {
    payload = image.resize({ width: fitted.width, height: fitted.height, quality: this.config.screenshotQuality })
  }

  return {
    dataUrl: payload.toDataURL(),
    width: fitted.width,
    height: fitted.height,
    captureWidth: size.width,
    captureHeight: size.height,
    viewWidth: bounds.width,
    viewHeight: bounds.height,
    devicePixelRatio: bounds.width ? size.width / bounds.width : 1,
    url: wc.getURL(),
    title: wc.getTitle(),
    loading: wc.isLoading()
  }
}

/**
 * Inject one action as a sequence of real input events.
 * The action arrives already in view-space CSS pixels.
 */
IrisComputer.prototype.act = async function (action) {
  const view = this.view()
  const wc = view.webContents

  if (action.type === 'navigate') {
    const url = /^https?:\/\//i.test(action.url) ? action.url : 'https://' + action.url.replace(/^\/+/, '')
    await wc.loadURL(url)
    return { ok: true }
  }
  if (action.type === 'wait') {
    await sleep(action.ms || 500)
    return { ok: true }
  }

  const plan = irisInputPlan.planInputEvents(action)

  // Mark "we are driving" so genuine human input can be told apart from our own events.
  this.injectingUntil = Date.now() + irisInputPlan.planDuration(plan) + 250

  for (const step of plan) {
    wc.sendInputEvent(step.event)
    if (step.delayMs) await sleep(step.delayMs)
  }

  this.injectingUntil = 0
  this.onInject(action, plan.length)
  return { ok: true, events: plan.length }
}

IrisComputer.prototype.state = function () {
  try {
    const view = this.view()
    return {
      url: view.webContents.getURL(),
      title: view.webContents.getTitle(),
      loading: view.webContents.isLoading(),
      takeoverCount: this.takeoverCount,
      canGoBack: view.webContents.navigationHistory ? view.webContents.navigationHistory.canGoBack() : false
    }
  } catch (err) {
    return { url: '', loading: false, takeoverCount: this.takeoverCount }
  }
}

IrisComputer.prototype.noteHumanInput = function (info) {
  if (Date.now() < this.injectingUntil) return false
  this.takeoverCount++
  this.lastTakeover = info
  return true
}

/* ------------------------------------------------------------------ *
 * Marker overlay — a click-through window floating exactly over the tab
 * ------------------------------------------------------------------ */

var overlayWindow = null

function ensureOverlay () {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow

  overlayWindow = new BrowserWindow({
    width: 200,
    height: 200,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    fullscreenable: false,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      // This window only ever loads Iris' own local marker page (never remote content, and
      // navigation away from that file is blocked below), so it may use a plain renderer.
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false,
      spellcheck: false
    }
  })

  overlayWindow.webContents.on('will-navigate', function (e) {
    e.preventDefault()
  })
  overlayWindow.setMenuBarVisibility(false)
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  // forward:true means mouse events keep travelling to the window underneath, so the page
  // the marker is drawn on still receives every real click.
  overlayWindow.setIgnoreMouseEvents(true, { forward: true })
  overlayWindow.loadURL('file://' + __dirname + '/pages/irisOverlay.html')

  return overlayWindow
}

function positionOverlay (tabId, fallbackBounds) {
  const view = getView(tabId)
  if (!view) return null

  const parent = findWindowForWebContents(view.webContents) || windows.getCurrent()
  if (!parent || parent.isDestroyed()) return null

  const viewBounds = view.getBounds()
  const bounds = viewBounds.width && viewBounds.height ? viewBounds : fallbackBounds
  if (!bounds || !bounds.width || !bounds.height) return null

  // view bounds are relative to the window's content view; convert to screen coordinates
  const contentOrigin = parent.getContentBounds()

  return {
    x: Math.round(contentOrigin.x + bounds.x),
    y: Math.round(contentOrigin.y + bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  }
}

function showOverlay (tabId, fallbackBounds) {
  const cfg = irisSettings()
  if (!cfg.markerEnabled) { DBUG('overlay: markers disabled in settings'); return }
  const bounds = positionOverlay(tabId, fallbackBounds)
  if (!bounds) { DBUG('overlay: no bounds for tab ' + tabId); return }
  const overlay = ensureOverlay()
  overlay.setBounds(bounds)
  if (!overlay.isVisible()) overlay.showInactive()
  DBUG('overlay: shown ' + JSON.stringify(bounds) + ' destroyed=' + overlay.isDestroyed())
}

function hideOverlay () {
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
    overlayWindow.hide()
  }
}

function overlaySend (payload) {
  if (!overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.webContents) {
    DBUG('overlay: send dropped, no window')
    return
  }
  // the page must have finished loading the marker page or the message is lost
  overlayWindow.webContents.send('iris-overlay', payload)
  DBUG('overlay: sent ' + (payload && payload.kind) + ' anchor=' + JSON.stringify(payload && payload.anchor))
}

/* ------------------------------------------------------------------ *
 * Agent manager: one running task per browser window
 * ------------------------------------------------------------------ */

var irisAgent = null
var irisAgentState = {
  status: 'idle',
  task: null,
  tabId: null,
  reason: null,
  answer: null,
  steps: 0
}

function broadcast (channel, payload) {
  const all = allWebContents.getAllWebContents()
  var sent = 0
  for (var i = 0; i < all.length; i++) {
    const contents = all[i]
    if (!contents || contents.isDestroyed()) continue
    // browser UI windows only (not the tab contents, not the marker overlay)
    if (contents.getType && contents.getType() !== 'window') continue
    try {
      contents.send(channel, payload)
      sent++
    } catch (e) {
      DBUG('broadcast send failed: ' + e.message)
    }
  }
  DBUG('broadcast ' + channel + ' -> ' + sent + ' of ' + all.length + ' webContents')
}

function broadcastEvent (payload) {
  broadcast('iris-agent-event', payload)
}

function currentTabId () {
  return irisAgentState.tabId
}

function startAgent (task, options, senderContents) {
  if (!task || !task.trim()) {
    return { ok: false, error: 'Type a task for Iris first.' }
  }
  if (irisAgent && (irisAgentState.status === 'running' || irisAgentState.status === 'paused')) {
    return { ok: false, error: 'Iris is already working. Stop it first.' }
  }

  const cfg = irisSettings()
  const tabId = options && options.tabId

  if (!tabId) return { ok: false, error: 'No active tab to work in.' }

  const computer = new IrisComputer(tabId, cfg, function (action, eventCount) {
    overlaySend({ kind: 'pulse', action: action, at: Date.now() })
  }, options && options.viewBounds)

  // genuine human input in the tab → pause the agent so the user can take over
  const view = getView(tabId)
  const onInput = function (event, input) {
    if (input.type === 'keyDown' && input.key === 'Escape') return
    const accepted = computer.noteHumanInput({
      kind: input.type === 'keyDown' ? 'keydown' : (input.type === 'mouseDown' ? 'click' : input.type),
      at: input.x !== undefined ? { x: input.x, y: input.y } : null
    })
    if (accepted && irisAgent && irisAgentState.autoPause !== false) {
      irisAgent.pause('human-input')
      broadcastEvent({ type: 'takeover', info: computer.lastTakeover })
    }
  }
  if (cfg.autoPauseOnUserInput) {
    view.webContents.on('before-input-event', onInput)
    irisAgentState.detachInput = function () {
      try { view.webContents.removeListener('before-input-event', onInput) } catch (e) { /* already gone */ }
    }
  }

  irisAgentState = {
    status: 'running',
    task: task,
    tabId: tabId,
    reason: null,
    answer: null,
    steps: 0,
    startedAt: Date.now(),
    autoPause: cfg.autoPauseOnUserInput
  }

  const useFakeModel = !!process.env.IRIS_FAKE_MODEL || !!cfg.useFakeModel
  const model = useFakeModel
    ? require('./iris/agent/fakeModel.js').createFakeModel({})
    : irisModelClient.createModelClient({
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      apiKey: cfg.apiKey,
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      timeoutMs: cfg.modelTimeoutMs
    })

  irisAgent = irisLoop.createAgent({
    model: model,
    computer: computer,
    safety: {
      maxSteps: cfg.maxSteps,
      allowSensitiveActions: cfg.allowSensitiveActions,
      maxModelMsPerStep: cfg.modelTimeoutMs
    },
    history: { keepImages: cfg.keepImages },
    log: DBUG,
    onEvent: function (type, payload) {
      DBUG('event ' + type + ' ' + JSON.stringify(payload && (payload.status || payload.description || payload.error || '') || ''))
      if (type === 'run:end') {
        irisAgentState.status = payload.status
        irisAgentState.answer = payload.answer
        irisAgentState.reason = payload.reason
        irisAgentState.steps = payload.steps
        hideOverlay()
        if (irisAgentState.detachInput) {
          irisAgentState.detachInput()
          irisAgentState.detachInput = null
        }
      } else if (type === 'action') {
        irisAgentState.steps = payload.step
        if (payload.anchor && cfg.markerEnabled) {
          showOverlay(tabId, computer.fallbackBounds)
          overlaySend({
            kind: payload.automatic ? 'wait' : 'pulse',
            action: payload.action,
            anchor: payload.anchor,
            description: payload.description,
            at: Date.now()
          })
        }
      } else if (type === 'status') {
        irisAgentState.status = payload.status
      }
      broadcastEvent(Object.assign({ type: type }, payload))
    }
  })

  irisAgent.run(task).then(function (result) {
    irisAgentState.status = result.status
    irisAgentState.answer = result.answer
    irisAgentState.reason = result.reason
  }).catch(function (err) {
    DBUG('run rejected ' + err.stack)
    irisAgentState.status = 'failed'
    irisAgentState.reason = err.message
    broadcastEvent({ type: 'run:end', status: 'failed', reason: err.message })
  })

  return { ok: true }
}

function agentStatus () {
  return Object.assign({
    ok: true,
    running: !!(irisAgent && (irisAgentState.status === 'running' || irisAgentState.status === 'paused')),
    settings: irisSettings(),
    defaults: IRIS_DEFAULT_SETTINGS
  }, irisAgentState, { detachInput: undefined })
}

ipc.on('iris-agent-start', function (event, data) {
  var result
  try {
    result = startAgent(data.task, data, event.sender)
  } catch (err) {
    DBUG('start threw ' + err.stack)
    result = { ok: false, error: err.message }
  }
  event.reply('iris-agent-start-reply', result)
})

ipc.on('iris-agent-pause', function (event) {
  if (irisAgent) irisAgent.pause('panel')
  event.reply('iris-agent-control-reply', { ok: true, status: irisAgentState.status })
})

ipc.on('iris-agent-resume', function (event) {
  if (irisAgent) irisAgent.resume()
  event.reply('iris-agent-control-reply', { ok: true, status: irisAgentState.status })
})

ipc.on('iris-agent-stop', function (event) {
  if (irisAgent) irisAgent.stop('stopped from the panel')
  hideOverlay()
  event.reply('iris-agent-control-reply', { ok: true, status: irisAgentState.status })
})

ipc.on('iris-agent-status', function (event) {
  event.reply('iris-agent-status-reply', agentStatus())
})

ipc.on('iris-agent-probe', async function (event, data) {
  const cfg = irisSettings()
  const result = await irisModelClient.probeServer({ baseUrl: (data && data.baseUrl) || cfg.baseUrl, apiKey: cfg.apiKey })
  event.reply('iris-agent-probe-reply', result)
})

ipc.on('iris-overlay-sync', function (e, data) {
  // the overlay window reports itself ready: re-place it over the tab being automated
  if (data && data.tabId) showOverlay(data.tabId)
})

ipc.on('iris-agent-settings-changed', function (event) {
  broadcast('iris-agent-settings', irisSettings())
})

/* the model config can change while a run is idle; pick it up immediately */
settings.listen('irisAI', function () {
  broadcast('iris-agent-settings', irisSettings())
})
