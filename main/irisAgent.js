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

const { webContents: allWebContents } = require('electron') // nativeImage comes from main.js (shared scope)
const irisActionSchema = require('./iris/agent/actionSchema.js')
const irisMapper = require('./iris/agent/coordinateMapper.js')
const irisInputPlan = require('./iris/agent/inputPlan.js')
const irisLoop = require('./iris/agent/agentLoop.js')
const irisModelClient = require('./iris/agent/modelClient.js')

const IRIS_SETTINGS_VERSION = 2

const IRIS_DEFAULT_SETTINGS = {
  settingsVersion: IRIS_SETTINGS_VERSION,
  baseUrl: 'http://192.168.1.252:13305/v1',
  model: 'Qwen3.8-Flash-Next-GGUF-IQ4_NL',
  apiKey: '',
  thinking: 'low', // off | low | medium | full
  maxSteps: 40,
  maxMinutes: 20,
  temperature: 0.2,
  modelTimeoutMs: 180000,
  keepImages: 1,
  screenshotMaxDimension: 1280,
  screenshotQuality: 82,
  markerEnabled: true,
  autoPauseOnUserInput: true,
  allowSensitiveActions: false
}

/* settings from before v2 had limits tuned for the cloud (90 s, 700 tokens, 2 images); keep only who/where */
const IRIS_KEEP_FROM_V1 = ['baseUrl', 'model', 'apiKey', 'markerEnabled', 'autoPauseOnUserInput', 'allowSensitiveActions']

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms || 0))

function irisSettings () {
  let stored = settings.get('irisAI') || {}
  if (stored.settingsVersion !== IRIS_SETTINGS_VERSION) {
    const kept = { settingsVersion: IRIS_SETTINGS_VERSION }
    IRIS_KEEP_FROM_V1.forEach(function (k) { if (stored[k] !== undefined && stored[k] !== '') kept[k] = stored[k] })
    stored = kept
    try { settings.set('irisAI', stored) } catch (e) { /* settings may not be ready yet */ }
  }
  return Object.assign({}, IRIS_DEFAULT_SETTINGS, stored)
}

const DEBUG_LOG = process.env.IRIS_AGENT_DEBUG || ''
function DBUG (m) {
  if (!DEBUG_LOG) return
  try { require('fs').appendFileSync(DEBUG_LOG, new Date().toISOString() + ' ' + m + '\n') } catch (e) { /* logging must never break the agent */ }
}

function withTimeout (promise, ms, message) {
  let timer = null
  return Promise.race([
    promise.finally(function () { clearTimeout(timer) }),
    new Promise(function (resolve, reject) { timer = setTimeout(function () { reject(new Error(message)) }, ms) })
  ])
}

/* ------------------------------------------------------------------ *
 * The "computer": what the agent can see and do
 * ------------------------------------------------------------------ */

function IrisComputer (tabId, config, onInject, viewBounds) {
  this.tabId = tabId
  // where the browser UI draws the page; used when the tab has no attached view yet
  this.fallbackBounds = viewBounds || null
  this.config = config
  this.onInject = onInject || function () {}
  this.takeoverCount = 0
  this.injecting = false
  this.injectingUntil = 0
  this.lastError = null
}

IrisComputer.prototype.view = function () {
  const view = getView(this.tabId)
  if (!view || !view.webContents || view.webContents.isDestroyed()) {
    throw new Error('the tab Iris is working in was closed')
  }
  return view
}

/** The browser window this tab's view lives in (attached or not). */
IrisComputer.prototype.window = function () {
  const view = this.view()
  const all = windows.getAll()
  for (let i = 0; i < all.length; i++) {
    if (all[i].getContentView().children.indexOf(view) !== -1) return all[i]
  }
  for (let i = 0; i < all.length; i++) {
    if (String(windows.getState(all[i]).selectedView) === String(this.tabId)) return all[i]
  }
  return windows.getCurrent()
}

IrisComputer.prototype.isAttached = function () {
  const view = this.view()
  return windows.getAll().some(function (win) { return win.getContentView().children.indexOf(view) !== -1 })
}

/* 32x20 grey thumbnail: enough to tell "blank" and "nothing changed" apart from real pages. */
function imageSignature (image) {
  const small = image.resize({ width: 32, height: 20, quality: 'good' })
  const bmp = small.toBitmap()
  const lum = []
  for (let i = 0; i + 3 < bmp.length; i += 4) lum.push((bmp[i] * 0.114 + bmp[i + 1] * 0.587 + bmp[i + 2] * 0.299))
  const mean = lum.reduce(function (a, b) { return a + b }, 0) / (lum.length || 1)
  const variance = lum.reduce(function (a, b) { return a + (b - mean) * (b - mean) }, 0) / (lum.length || 1)
  return {
    blank: Math.sqrt(variance) < 2.5,
    fingerprint: lum.map(function (v) { return Math.round(v / 16).toString(16) }).join('')
  }
}

/*
 * Seeing the page: the tab's own webContents.capturePage(). It shows exactly the tab, at the
 * device scale, needs no screen-recording permission, and can never pick up another window
 * or another app. It is bounded by a timeout and retried, because a view that has just been
 * attached may not have painted its first frame yet.
 */
IrisComputer.prototype.screenshot = async function () {
  const view = this.view()
  const wc = view.webContents
  const url = wc.getURL()
  const viewBounds = view.getBounds()
  const bounds = viewBounds.width && viewBounds.height ? viewBounds : this.fallbackBounds
  if (viewBounds.width && viewBounds.height) this.fallbackBounds = viewBounds
  if (!bounds || !bounds.width || !bounds.height) throw new Error('the tab has no size yet')

  // a brand-new tab has no page at all: describe it instead of photographing nothing
  if (!url || url === 'about:blank' || /^min:\/\/newtab/.test(url)) {
    return this.emptyTabObservation(bounds)
  }

  if (!this.isAttached()) {
    // the address bar or a menu put Min into placeholder mode; ask the UI to show the page again
    broadcast('iris-agent-need-view', { tabId: this.tabId })
    await sleep(300)
    if (!this.isAttached()) throw new Error('the page is hidden behind the address bar or a menu')
  }

  let image = null
  let lastError = null
  let sig = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      image = await withTimeout(wc.capturePage(), 4000, 'capturing the page timed out')
      if (image && !image.isEmpty()) {
        sig = imageSignature(image)
        if (!sig.blank || attempt === 3) break
        lastError = new Error('the page looked blank')
      } else {
        lastError = new Error('the page has not painted yet')
      }
    } catch (err) {
      lastError = err
    }
    DBUG('capture attempt ' + attempt + ' failed: ' + (lastError && lastError.message))
    image = null
    try { wc.invalidate() } catch (e) { /* view going away */ }
    await sleep(250 * attempt)
  }
  if (!image) throw lastError || new Error('could not capture the page')

  const size = image.getSize()
  DBUG('capture ok ' + JSON.stringify(size) + ' view ' + bounds.width + 'x' + bounds.height + ' url ' + url + (sig.blank ? ' (blank)' : ''))
  return this.finishCapture(image, size, bounds, wc, sig)
}

IrisComputer.prototype.emptyTabObservation = function (bounds) {
  const fitted = irisMapper.fitDimensions(bounds.width, bounds.height, this.config.screenshotMaxDimension)
  const buf = Buffer.alloc(fitted.width * fitted.height * 4, 255)
  const image = nativeImage.createFromBitmap(buf, { width: fitted.width, height: fitted.height })
  return {
    dataUrl: 'data:image/jpeg;base64,' + image.toJPEG(70).toString('base64'),
    width: fitted.width,
    height: fitted.height,
    viewWidth: bounds.width,
    viewHeight: bounds.height,
    devicePixelRatio: fitted.width / bounds.width,
    url: '',
    title: 'New tab',
    loading: false,
    emptyTab: true,
    fingerprint: 'empty-tab'
  }
}

IrisComputer.prototype.finishCapture = function (image, size, bounds, wc, sig) {
  const fitted = irisMapper.fitDimensions(size.width, size.height, this.config.screenshotMaxDimension)
  let payload = image
  if (fitted.width !== size.width || fitted.height !== size.height) {
    payload = image.resize({ width: fitted.width, height: fitted.height, quality: 'better' })
  }
  return {
    dataUrl: 'data:image/jpeg;base64,' + payload.toJPEG(this.config.screenshotQuality || 82).toString('base64'),
    width: fitted.width,
    height: fitted.height,
    captureWidth: size.width,
    captureHeight: size.height,
    viewWidth: bounds.width,
    viewHeight: bounds.height,
    devicePixelRatio: bounds.width ? size.width / bounds.width : 1,
    url: wc.getURL(),
    title: wc.getTitle(),
    loading: wc.isLoading(),
    blank: !!(sig && sig.blank),
    fingerprint: sig ? sig.fingerprint : null
  }
}

/* Plain words → a web search; anything that looks like an address → that address. */
function irisResolveUrl (text) {
  const t = String(text || '').trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t
  if (/^[^\s]+\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(t) || /^localhost(:\d+)?(\/|$)/i.test(t)) return 'https://' + t.replace(/^\/+/, '')
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(t)
}

/**
 * Inject one action as a sequence of real input events.
 * The action arrives already in view-space CSS pixels.
 */
IrisComputer.prototype.act = async function (action) {
  const view = this.view()
  const wc = view.webContents

  if (action.type === 'navigate') {
    const url = irisResolveUrl(action.url)
    // Min's own loader: attaches a new tab's view to the window, exactly like typing a URL
    loadURLInView(this.tabId, url, this.window())
    return { ok: true, url: url }
  }
  if (action.type === 'back') {
    const nav = wc.navigationHistory
    if (!nav || !nav.canGoBack()) return { ok: false, error: 'there is no previous page in this tab' }
    nav.goBack()
    return { ok: true }
  }
  if (action.type === 'wait') {
    await sleep(action.ms || 500)
    return { ok: true }
  }

  const plan = irisInputPlan.planInputEvents(action)

  // Mark "we are driving" so genuine human input can be told apart from our own events.
  this.injecting = true
  try {
    for (const step of plan) {
      wc.sendInputEvent(step.event)
      if (step.delayMs) await sleep(step.delayMs)
    }
  } finally {
    this.injecting = false
    this.injectingUntil = Date.now() + 400
  }

  this.onInject(action, plan.length)
  return { ok: true, events: plan.length }
}

/** Wait for the page to react to an action: navigation, loading, then one paint. */
IrisComputer.prototype.settle = async function (action) {
  let wc
  try { wc = this.view().webContents } catch (e) { return }
  const started = Date.now()
  const mayNavigate = action && (action.type === 'navigate' || action.type === 'back' || action.type === 'click' ||
    action.type === 'key' || (action.type === 'type' && action.enter))
  await sleep(mayNavigate ? 400 : 180)
  while (wc.isLoading() && Date.now() - started < 12000) {
    await sleep(150)
  }
  if (action && action.type === 'scroll') await sleep(200) // smooth scrolling
  await sleep(150)
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
  if (this.injecting || Date.now() < this.injectingUntil) return false
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

  const parent = windows.getAll().find(function (win) { return win.getContentView().children.indexOf(view) !== -1 }) || windows.getCurrent()
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

  // genuine human input in the tab (a click or a key press) → pause so the user can take over
  const view = getView(tabId)
  if (!view) return { ok: false, error: 'This tab is not ready yet. Try again in a moment.' }
  const onInput = function (event, input) {
    const type = input && input.type
    if (type !== 'mouseDown' && type !== 'keyDown' && type !== 'rawKeyDown') return
    if (input.key === 'Escape' || input.keyCode === 'Escape') return
    const accepted = computer.noteHumanInput({
      kind: type === 'mouseDown' ? 'click' : 'keydown',
      at: input.x !== undefined ? { x: input.x, y: input.y } : null
    })
    if (accepted && irisAgent && irisAgentState.autoPause !== false && irisAgentState.status === 'running') {
      irisAgent.pause('human-input')
      broadcastEvent({ type: 'takeover', info: computer.lastTakeover })
    }
  }
  let detachInput = null
  if (cfg.autoPauseOnUserInput) {
    view.webContents.on('input-event', onInput)
    detachInput = function () {
      try { view.webContents.removeListener('input-event', onInput) } catch (e) { /* already gone */ }
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
    autoPause: cfg.autoPauseOnUserInput,
    detachInput: detachInput
  }

  const useFakeModel = !!process.env.IRIS_FAKE_MODEL || !!cfg.useFakeModel
  const model = useFakeModel
    ? require('./iris/agent/fakeModel.js').createFakeModel({})
    : irisModelClient.createModelClient({
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      apiKey: cfg.apiKey,
      temperature: cfg.temperature,
      thinking: cfg.thinking,
      timeoutMs: cfg.modelTimeoutMs
    })

  irisAgent = irisLoop.createAgent({
    model: model,
    computer: computer,
    safety: {
      maxSteps: cfg.maxSteps,
      allowSensitiveActions: cfg.allowSensitiveActions,
      maxModelMsPerStep: cfg.modelTimeoutMs + 5000,
      maxWallClockMs: Math.max(1, cfg.maxMinutes) * 60 * 1000
    },
    history: { keepImages: cfg.keepImages },
    log: DBUG,
    onEvent: function (type, payload) {
      if (type !== 'model:progress') DBUG('event ' + type + ' ' + JSON.stringify(payload && (payload.status || payload.description || payload.error || payload.thought || '') || ''))
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
  if (irisAgent) irisAgent.stop('Stopped by you')
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
