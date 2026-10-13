/*
 * main/irisAgent.js  —  the privileged half of the Iris AI agent.
 *
 * This file is concatenated into main.build.js (it shares scope with Min's other main
 * process modules, so `settings`, `windows`, `getView`, `loadURLInView`, `ipc`, `fs`, `path`,
 * `safeStorage`, `nativeImage` and `userDataPath` are available).
 *
 * Iris works the way a person does: it looks at the tab (a screenshot) and acts with real
 * mouse and keyboard events. It never evaluates JavaScript in a page and never touches the
 * DOM. All of the thinking lives in iris/agent/*, which is Electron-free.
 *
 * This file owns:
 *   • SEE / ACT     the "computer": capture, input events, tabs, zoom, settle
 *   • PROFILE       the user's details for forms and logins; secrets are encrypted with the
 *                   macOS keychain and only ever reach the page as typed keystrokes
 *   • SESSIONS      every chat is saved and can be reopened and continued
 *   • RUN MODES     once, non-stop, repeat every N minutes, and scheduled tasks
 */

const { webContents: allWebContents } = require('electron') // nativeImage comes from main.js (shared scope)
const irisActionSchema = require('./iris/agent/actionSchema.js')
const irisMapper = require('./iris/agent/coordinateMapper.js')
const irisInputPlan = require('./iris/agent/inputPlan.js')
const irisLoop = require('./iris/agent/agentLoop.js')
const irisModelClient = require('./iris/agent/modelClient.js')
const irisPrompts = require('./iris/agent/prompts.js')

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
  autoPauseOnUserInput: true
}

/* settings from before v2 had limits tuned for the cloud (90 s, 700 tokens, 2 images); keep only who/where */
const IRIS_KEEP_FROM_V1 = ['baseUrl', 'model', 'apiKey', 'markerEnabled', 'autoPauseOnUserInput']

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
  try { fs.appendFileSync(DEBUG_LOG, new Date().toISOString() + ' ' + m + '\n') } catch (e) { /* logging must never break the agent */ }
}

function withTimeout (promise, ms, message) {
  let timer = null
  return Promise.race([
    promise.finally(function () { clearTimeout(timer) }),
    new Promise(function (resolve, reject) { timer = setTimeout(function () { reject(new Error(message)) }, ms) })
  ])
}

/* ------------------------------------------------------------------ *
 * Profile: what Iris knows about the user
 * ------------------------------------------------------------------ */

const IRIS_DEFAULT_PROFILE = [
  { label: 'Full name', value: '', secret: false },
  { label: 'Email', value: '', secret: false },
  { label: 'Phone', value: '', secret: false },
  { label: 'Address', value: '', secret: false },
  { label: 'Username', value: '', secret: false },
  { label: 'Password', value: '', secret: true }
]

function irisProfilePath () {
  return path.join(userDataPath, 'iris-profile.json')
}

function irisEncrypt (text) {
  if (!text) return ''
  try {
    if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(text).toString('base64')
  } catch (e) { DBUG('profile encrypt failed: ' + e.message) }
  return 'plain:' + text
}

function irisDecrypt (stored) {
  if (!stored) return ''
  if (stored.indexOf('enc:') === 0) {
    try { return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64')) } catch (e) { DBUG('profile decrypt failed: ' + e.message); return '' }
  }
  if (stored.indexOf('plain:') === 0) return stored.slice(6)
  return stored
}

/** Full profile with secrets decrypted. Main process only. */
function irisProfileLoad () {
  try {
    const raw = JSON.parse(fs.readFileSync(irisProfilePath(), 'utf8'))
    if (Array.isArray(raw.fields)) {
      return raw.fields.map(function (f) {
        return { label: String(f.label || '').trim(), secret: !!f.secret, value: f.secret ? irisDecrypt(f.value) : String(f.value || '') }
      }).filter(function (f) { return f.label })
    }
  } catch (e) { /* no profile yet */ }
  return IRIS_DEFAULT_PROFILE.map(function (f) { return Object.assign({}, f) })
}

function irisProfileSave (fields) {
  const previous = irisProfileLoad()
  const out = (fields || []).map(function (f) {
    const label = String(f.label || '').trim().slice(0, 60)
    if (!label) return null
    let value = String(f.value || '')
    // the settings page never receives secrets; an untouched secret field means "keep it"
    if (f.secret && !value && f.keep) {
      const old = previous.find(function (p) { return p.label === label && p.secret })
      value = old ? old.value : ''
    }
    return { label: label, secret: !!f.secret, value: f.secret ? irisEncrypt(value) : value.slice(0, 2000) }
  }).filter(Boolean)
  fs.writeFileSync(irisProfilePath(), JSON.stringify({ version: 1, fields: out }, null, 1), { mode: 0o600 })
}

/** For the settings page: secrets are never sent back, only whether one is saved. */
function irisProfileForPage () {
  return irisProfileLoad().map(function (f) {
    return f.secret ? { label: f.label, secret: true, value: '', hasValue: !!f.value } : f
  })
}

/** For the model: plain values, and placeholders instead of secrets. */
function irisProfileForPrompt () {
  return irisProfileLoad().filter(function (f) { return f.value }).map(function (f) {
    return f.secret ? { label: f.label, secret: true } : { label: f.label, value: f.value }
  })
}

/** Swap {{Label}} placeholders for the real secret right before typing. */
function irisFillSecrets (text) {
  if (!text || text.indexOf('{{') === -1) return text
  const profile = irisProfileLoad()
  return text.replace(/\{\{\s*([^}]+?)\s*\}\}/g, function (all, name) {
    const key = name.toLowerCase()
    const hit = profile.find(function (f) { return f.label.toLowerCase() === key })
    return hit && hit.value ? hit.value : all
  })
}

/* ------------------------------------------------------------------ *
 * Tabs, as the browser UI reports them
 * ------------------------------------------------------------------ */

var irisTabs = { selected: null, tabs: [] }

ipc.on('iris-tabs-state', function (e, data) {
  if (data && data.tabs) irisTabs = data
})

function irisTabInfo (id) {
  return irisTabs.tabs.find(function (t) { return String(t.id) === String(id) }) || null
}

function irisTabList () {
  return irisTabs.tabs.map(function (t) {
    return { id: t.id, title: t.title, url: t.url, active: String(t.id) === String(irisTabs.selected) }
  })
}

/** Ask the browser UI to change tabs, then wait until it has. */
async function irisTabCommand (command, waitFor) {
  broadcast('iris-agent-tab-action', command)
  const started = Date.now()
  while (Date.now() - started < 3000) {
    await sleep(80)
    if (!waitFor || waitFor()) return true
  }
  return false
}

/* ------------------------------------------------------------------ *
 * The "computer": what the agent can see and do
 * ------------------------------------------------------------------ */

function IrisComputer (tabId, config, hooks, viewBounds) {
  this.tabId = tabId
  // where the browser UI draws the page; used when the tab has no attached view yet
  this.fallbackBounds = viewBounds || null
  this.config = config
  this.hooks = hooks || {}
  this.takeoverCount = 0
  this.injecting = false
  this.injectingUntil = 0
  this.pointer = null
  this.pendingZoom = null
  this.tabNote = null
}

/* Iris always works in the tab you can see: a link that opens a new tab takes Iris with it. */
IrisComputer.prototype.currentTabId = function () {
  const selected = irisTabs.selected
  if (selected && String(selected) !== String(this.tabId) && getView(selected)) {
    const tabs = irisTabList()
    const index = tabs.findIndex(function (t) { return String(t.id) === String(selected) })
    const info = tabs[index]
    this.tabNote = 'You are now in tab ' + (index + 1) + (info && info.title ? ' ("' + info.title.slice(0, 60) + '")' : '') + '.'
    this.tabId = selected
    this.pointer = null
    if (this.hooks.onTabChange) this.hooks.onTabChange(selected)
  }
  return this.tabId
}

IrisComputer.prototype.view = function () {
  const view = getView(this.currentTabId())
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

  const info = irisTabInfo(this.tabId)
  const tabNote = this.tabNote
  this.tabNote = null

  // a brand-new tab has no page at all: describe it instead of photographing nothing
  if (!url || url === 'about:blank' || /^min:\/\/newtab/.test(url)) {
    if (info && info.url && !/^min:\/\/newtab/.test(info.url) && (wc.isLoading() || !url)) {
      this.tabNote = tabNote
      throw new Error('the new tab is still opening')
    }
    return Object.assign(this.emptyTabObservation(bounds), { tabs: irisTabList(), tabChanged: tabNote })
  }

  if (!this.isAttached()) {
    // the address bar or a menu put Min into placeholder mode; ask the UI to show the page again
    broadcast('iris-agent-need-view', { tabId: this.tabId })
    await sleep(300)
    if (!this.isAttached()) {
      this.tabNote = tabNote
      throw new Error('the page is hidden behind the address bar or a menu')
    }
  }

  // a requested close-up: capture just that region at full device resolution
  let crop = null
  if (this.pendingZoom) {
    const z = this.pendingZoom
    this.pendingZoom = null
    const w = Math.round(bounds.width / 2)
    const h = Math.round(bounds.height / 2)
    crop = {
      x: Math.max(0, Math.min(bounds.width - w, Math.round(z.x - w / 2))),
      y: Math.max(0, Math.min(bounds.height - h, Math.round(z.y - h / 2))),
      width: w,
      height: h
    }
  }

  let image = null
  let lastError = null
  let sig = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      image = await withTimeout(crop ? wc.capturePage(crop) : wc.capturePage(), 4000, 'capturing the page timed out')
      if (image && !image.isEmpty()) {
        sig = imageSignature(image)
        if (!sig.blank || attempt === 3 || crop) break
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
  if (!image) {
    this.tabNote = tabNote
    throw lastError || new Error('could not capture the page')
  }

  const size = image.getSize()
  DBUG('capture ok ' + JSON.stringify(size) + (crop ? ' crop ' + JSON.stringify(crop) : ' view ' + bounds.width + 'x' + bounds.height) + ' url ' + url)
  const obs = this.finishCapture(image, size, crop || bounds, wc, sig)
  obs.tabs = irisTabList()
  if (tabNote) obs.tabChanged = tabNote
  if (crop) {
    obs.crop = crop
    obs.fingerprint = null
  }
  return obs
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
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^(about|data|mailto):/i.test(t)) return t
  if (/^[^\s]+\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(t) || /^localhost(:\d+)?(\/|$)/i.test(t)) return (/^localhost/i.test(t) ? 'http://' : 'https://') + t.replace(/^\/+/, '')
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(t)
}

/**
 * Carry out one action. Coordinates arrive in view-space CSS pixels.
 */
IrisComputer.prototype.act = async function (action) {
  const self = this
  const view = this.view()
  const wc = view.webContents

  switch (action.type) {
    case 'navigate': {
      const url = irisResolveUrl(action.url)
      // Min's own loader: attaches a new tab's view to the window, exactly like typing a URL
      loadURLInView(this.tabId, url, this.window())
      return { ok: true, url: url }
    }
    case 'back': {
      const nav = wc.navigationHistory
      if (!nav || !nav.canGoBack()) return { ok: false, error: 'there is no previous page in this tab' }
      nav.goBack()
      return { ok: true }
    }
    case 'wait':
      await sleep(action.ms || 500)
      return { ok: true }
    case 'zoom':
      this.pendingZoom = { x: action.x, y: action.y }
      return { ok: true }
    case 'switch_tab': {
      const tab = irisTabList()[action.tab - 1]
      if (!tab) return { ok: false, error: 'there is no tab ' + action.tab + ' (there are ' + irisTabs.tabs.length + ')' }
      await irisTabCommand({ op: 'switch', id: tab.id }, function () { return String(irisTabs.selected) === String(tab.id) })
      return { ok: true, pageChanged: true }
    }
    case 'new_tab': {
      const before = irisTabs.selected
      await irisTabCommand({ op: 'new', url: action.url ? irisResolveUrl(action.url) : '' }, function () { return irisTabs.selected && String(irisTabs.selected) !== String(before) })
      return { ok: true, pageChanged: true }
    }
    case 'close_tab': {
      const list = irisTabList()
      const tab = action.tab ? list[action.tab - 1] : list.find(function (t) { return t.active })
      if (!tab) return { ok: false, error: 'there is no tab ' + action.tab }
      if (list.length <= 1) return { ok: false, error: 'this is the only tab; open another first' }
      await irisTabCommand({ op: 'close', id: tab.id }, function () { return !irisTabInfo(tab.id) })
      return { ok: true, pageChanged: true }
    }
  }

  // secrets are filled in here, at the last moment: the model and the panel only see {{Label}}
  const real = action.type === 'type' ? Object.assign({}, action, { text: irisFillSecrets(action.text) }) : action
  const plan = irisInputPlan.planInputEvents(real, { from: this.pointer })

  // Mark "we are driving" so genuine human input can be told apart from our own events.
  this.injecting = true
  try {
    for (const step of plan) {
      wc.sendInputEvent(step.event)
      if (step.delayMs) await sleep(step.delayMs)
    }
  } finally {
    self.injecting = false
    self.injectingUntil = Date.now() + 400
  }
  this.pointer = irisInputPlan.pointerAfter(action) || this.pointer
  return { ok: true, events: plan.length }
}

/** Wait for the page to react to an action: navigation, loading, then one paint. */
IrisComputer.prototype.settle = async function (action) {
  let wc
  try { wc = this.view().webContents } catch (e) { return }
  const started = Date.now()
  if (action && action.type === 'zoom') return
  const mayNavigate = action && (action.type === 'navigate' || action.type === 'back' || action.type === 'click' ||
    action.type === 'key' || action.type === 'new_tab' || action.type === 'switch_tab' || (action.type === 'type' && action.enter))
  await sleep(mayNavigate ? 400 : 160)
  try { wc = this.view().webContents } catch (e) { return } // a click may have opened a new tab
  while (wc.isLoading() && Date.now() - started < 12000) {
    await sleep(150)
  }
  if (action && action.type === 'scroll') await sleep(200) // smooth scrolling
  await sleep(120)
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
 * Pointer overlay — a click-through window floating exactly over the tab
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
      // This window only ever loads Iris' own local pointer page (never remote content, and
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
  // the pointer is drawn on still receives every real click.
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
  if (!cfg.markerEnabled) return
  const bounds = positionOverlay(tabId, fallbackBounds)
  if (!bounds) return
  const overlay = ensureOverlay()
  overlay.setBounds(bounds)
  if (!overlay.isVisible()) overlay.showInactive()
}

function hideOverlay () {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try { overlayWindow.webContents.send('iris-overlay-hide') } catch (e) { /* not loaded */ }
    if (overlayWindow.isVisible()) overlayWindow.hide()
  }
}

function overlaySend (payload) {
  if (!overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.webContents) return
  overlayWindow.webContents.send('iris-overlay', payload)
}

/* ------------------------------------------------------------------ *
 * Sessions: every chat is saved and can be reopened
 * ------------------------------------------------------------------ */

function irisSessionsDir () {
  const dir = path.join(userDataPath, 'iris-sessions')
  try { fs.mkdirSync(dir, { recursive: true }) } catch (e) { /* exists */ }
  return dir
}

function irisSessionFile (id) {
  return path.join(irisSessionsDir(), String(id).replace(/[^a-z0-9-]/gi, '') + '.json')
}

function irisNewSession (task) {
  return {
    id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    title: String(task).slice(0, 120),
    created: Date.now(),
    updated: Date.now(),
    status: 'running',
    items: [],
    history: null
  }
}

var irisSaveTimer = null
function irisSessionSave (session, now) {
  if (!session) return
  const write = function () {
    irisSaveTimer = null
    try {
      session.updated = Date.now()
      fs.writeFileSync(irisSessionFile(session.id), JSON.stringify(session))
    } catch (e) { DBUG('session save failed: ' + e.message) }
  }
  if (now) {
    clearTimeout(irisSaveTimer)
    write()
  } else if (!irisSaveTimer) {
    irisSaveTimer = setTimeout(write, 1500)
  }
}

function irisSessionLoad (id) {
  try { return JSON.parse(fs.readFileSync(irisSessionFile(id), 'utf8')) } catch (e) { return null }
}

function irisSessionList () {
  const dir = irisSessionsDir()
  let names = []
  try { names = fs.readdirSync(dir).filter(function (n) { return n.endsWith('.json') }) } catch (e) { return [] }
  const list = []
  names.forEach(function (n) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))
      const results = (s.items || []).filter(function (i) { return i.kind === 'result' })
      list.push({ id: s.id, title: s.title, created: s.created, updated: s.updated, status: s.status, runs: results.length })
    } catch (e) { /* skip broken file */ }
  })
  list.sort(function (a, b) { return b.updated - a.updated })
  return list.slice(0, 300)
}

/* Keep a compact, replayable record of what the panel showed. */
function irisRecord (session, type, p) {
  if (!session) return
  const items = session.items
  const stepItem = function (step) {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].kind === 'step' && items[i].step === step && items[i].run === session.run) return items[i]
      if (items[i].kind === 'user') break
    }
    const it = { kind: 'step', run: session.run, step: step, actions: [] }
    items.push(it)
    return it
  }
  if (type === 'observation') {
    const it = stepItem(p.step)
    it.url = p.url
    it.title = p.title
  } else if (type === 'thought') {
    stepItem(p.step).thought = p.thought
  } else if (type === 'action' && !p.automatic) {
    stepItem(p.step).actions.push({ type: p.action.type, text: p.action.type === 'type' ? p.action.text : undefined, url: p.action.url, description: p.description })
  } else if (type === 'action:result' && !p.ok) {
    stepItem(p.step).error = p.error
  } else if (type === 'remember') {
    items.push({ kind: 'note', text: p.note })
  } else if (type === 'run:end') {
    items.push({ kind: 'result', status: p.status, answer: p.answer, reason: p.reason, steps: p.steps, ms: p.stats && p.stats.elapsedMs })
    session.status = p.status
  } else {
    return
  }
  irisSessionSave(session, type === 'run:end')
}

/* ------------------------------------------------------------------ *
 * Running tasks
 * ------------------------------------------------------------------ */

var irisAgent = null
var irisComputer = null
var irisSession = null
var irisRepeatTimer = null
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
  for (var i = 0; i < all.length; i++) {
    const contents = all[i]
    if (!contents || contents.isDestroyed()) continue
    // browser UI windows only (not the tab contents, not the pointer overlay)
    if (contents.getType && contents.getType() !== 'window') continue
    try {
      contents.send(channel, payload)
    } catch (e) {
      DBUG('broadcast send failed: ' + e.message)
    }
  }
}

function broadcastEvent (payload) {
  broadcast('iris-agent-event', payload)
}

function irisIsBusy () {
  return irisAgentState.status === 'running' || irisAgentState.status === 'paused' || irisAgentState.status === 'stopping'
}

function irisCancelRepeat () {
  if (irisRepeatTimer) {
    clearTimeout(irisRepeatTimer)
    irisRepeatTimer = null
    broadcastEvent({ type: 'repeat:cancelled' })
  }
}

/* genuine human input in the tab (a click or a key press) → pause so the user can take over */
var irisInputBinding = null
function irisBindInput (tabId, cfg) {
  if (irisInputBinding) {
    irisInputBinding.detach()
    irisInputBinding = null
  }
  if (!cfg.autoPauseOnUserInput) return
  const view = getView(tabId)
  if (!view) return
  const onInput = function (event, input) {
    const type = input && input.type
    if (type !== 'mouseDown' && type !== 'keyDown' && type !== 'rawKeyDown') return
    if (input.key === 'Escape' || input.keyCode === 'Escape') return
    if (!irisComputer) return
    const accepted = irisComputer.noteHumanInput({
      kind: type === 'mouseDown' ? 'click' : 'keydown',
      at: input.x !== undefined ? { x: input.x, y: input.y } : null
    })
    if (accepted && irisAgent && irisAgentState.status === 'running') {
      irisAgent.pause('human-input')
      broadcastEvent({ type: 'takeover', info: irisComputer.lastTakeover })
    }
  }
  view.webContents.on('input-event', onInput)
  irisInputBinding = {
    detach: function () {
      try { view.webContents.removeListener('input-event', onInput) } catch (e) { /* already gone */ }
    }
  }
}

function irisSystemExtra (mode) {
  const parts = []
  const now = new Date()
  parts.push('Today is ' + now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) + '.')
  const profile = irisPrompts.profileText(irisProfileForPrompt())
  if (profile) parts.push(profile)
  const modeText = irisPrompts.modeText(mode)
  if (modeText) parts.push(modeText)
  return parts.join('\n\n')
}

/**
 * Start a task, or continue the current chat.
 * options: { tabId, viewBounds, sessionId, mode: 'once'|'continuous'|'repeat', everyMinutes }
 */
function startAgent (task, options) {
  options = options || {}
  if (!task || !task.trim()) return { ok: false, error: 'Type a task for Iris first.' }
  if (irisIsBusy()) return { ok: false, error: 'Iris is already working. Stop it first.' }
  irisCancelRepeat()

  const cfg = irisSettings()
  const tabId = options.tabId
  if (!tabId) return { ok: false, error: 'No active tab to work in.' }
  if (!getView(tabId)) return { ok: false, error: 'This tab is not ready yet. Try again in a moment.' }

  // continue the open chat, reopen a saved one, or start a new one
  let previousHistory = null
  if (options.sessionId && irisSession && irisSession.id === options.sessionId) {
    previousHistory = irisAgent ? irisAgent.exportHistory() : irisSession.history
  } else if (options.sessionId) {
    const saved = irisSessionLoad(options.sessionId)
    if (saved) {
      irisSession = saved
      previousHistory = saved.history
    }
  } else {
    irisSession = null
  }
  if (!irisSession) irisSession = irisNewSession(task)
  const session = irisSession
  session.run = (session.run || 0) + 1
  session.items.push({ kind: 'user', text: task, mode: options.mode || 'once', run: session.run })
  irisSessionSave(session, true)

  const mode = options.mode === 'continuous' || options.mode === 'repeat' ? options.mode : 'once'
  const unlimited = mode === 'continuous'

  const computer = new IrisComputer(tabId, cfg, {
    onTabChange: function (newTabId) {
      irisAgentState.tabId = newTabId
      irisBindInput(newTabId, cfg)
    }
  }, options.viewBounds)
  irisComputer = computer
  irisBindInput(tabId, cfg)

  irisAgentState = {
    status: 'running',
    task: task,
    tabId: tabId,
    reason: null,
    answer: null,
    steps: 0,
    startedAt: Date.now(),
    mode: mode,
    sessionId: session.id
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

  const agent = irisLoop.createAgent({
    model: model,
    computer: computer,
    config: { systemExtra: function () { return irisSystemExtra(mode) } },
    safety: {
      maxSteps: unlimited ? 0 : cfg.maxSteps,
      maxModelMsPerStep: cfg.modelTimeoutMs + 5000,
      maxWallClockMs: unlimited ? 0 : Math.max(1, cfg.maxMinutes) * 60 * 1000,
      // a long run must survive a flaky moment instead of giving up after three errors
      maxConsecutiveFailures: unlimited ? 12 : 4,
      maxRetriesPerStep: unlimited ? 8 : 3
    },
    history: { keepImages: cfg.keepImages, maxMessages: unlimited ? 60 : 40 },
    log: DBUG,
    onEvent: function (type, payload) {
      if (type !== 'model:progress') DBUG('event ' + type + ' ' + JSON.stringify(payload && (payload.status || payload.description || payload.error || payload.thought || '') || ''))
      irisRecord(session, type, payload)
      if (type === 'run:end') {
        irisAgentState.status = payload.status
        irisAgentState.answer = payload.answer
        irisAgentState.reason = payload.reason
        irisAgentState.steps = payload.steps
        hideOverlay()
        if (irisInputBinding) { irisInputBinding.detach(); irisInputBinding = null }
        session.history = agent.exportHistory()
        irisSessionSave(session, true)
      } else if (type === 'action') {
        irisAgentState.steps = payload.step
        if (payload.anchor && cfg.markerEnabled) {
          showOverlay(computer.tabId, computer.fallbackBounds)
          overlaySend({ action: payload.action, anchor: payload.anchor, description: payload.description })
        }
      } else if (type === 'status') {
        irisAgentState.status = payload.status
      }
      broadcastEvent(Object.assign({ type: type, sessionId: session.id }, payload))
    }
  })
  if (previousHistory) agent.importHistory(previousHistory)
  irisAgent = agent

  agent.run(task, { followUp: !!previousHistory }).then(function (result) {
    irisAgentState.status = result.status
    irisAgentState.answer = result.answer
    irisAgentState.reason = result.reason
    if (mode === 'repeat' && result.status !== 'stopped') irisScheduleRepeat(task, options)
  }).catch(function (err) {
    DBUG('run rejected ' + err.stack)
    irisAgentState.status = 'failed'
    irisAgentState.reason = err.message
    broadcastEvent({ type: 'run:end', status: 'failed', reason: err.message, sessionId: session.id })
  })

  broadcastEvent({ type: 'session', session: irisSessionHeader(session) })
  return { ok: true, sessionId: session.id }
}

function irisScheduleRepeat (task, options) {
  const minutes = Math.max(1, Number(options.everyMinutes) || 60)
  const at = Date.now() + minutes * 60000
  broadcastEvent({ type: 'repeat:scheduled', at: at, minutes: minutes, sessionId: irisSession && irisSession.id })
  irisRepeatTimer = setTimeout(function () {
    irisRepeatTimer = null
    const tabId = irisComputer ? irisComputer.tabId : options.tabId
    const result = startAgent('Do the task again now (scheduled repeat): ' + task, Object.assign({}, options, { tabId: tabId, sessionId: irisSession && irisSession.id }))
    if (!result.ok) DBUG('repeat run failed to start: ' + result.error)
  }, minutes * 60000)
}

function irisSessionHeader (s) {
  return s ? { id: s.id, title: s.title, created: s.created, updated: s.updated, status: s.status } : null
}

function agentStatus () {
  return Object.assign({
    ok: true,
    running: irisIsBusy(),
    settings: irisSettings(),
    defaults: IRIS_DEFAULT_SETTINGS,
    session: irisSessionHeader(irisSession),
    repeating: !!irisRepeatTimer
  }, irisAgentState)
}

ipc.on('iris-agent-start', function (event, data) {
  var result
  try {
    result = startAgent(data.task, data)
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
  irisCancelRepeat()
  if (irisAgent && irisIsBusy()) irisAgent.stop('Stopped by you')
  hideOverlay()
  event.reply('iris-agent-control-reply', { ok: true, status: irisAgentState.status })
})

ipc.on('iris-agent-status', function (event) {
  event.reply('iris-agent-status-reply', agentStatus())
})

ipc.on('iris-agent-new-chat', function (event) {
  if (irisIsBusy()) return
  irisCancelRepeat()
  irisSession = null
  irisAgent = null
})

ipc.on('iris-agent-sessions', function (event) {
  event.reply('iris-agent-sessions-reply', irisSessionList())
})

ipc.on('iris-agent-session-open', function (event, id) {
  const s = irisSessionLoad(id)
  if (s && !irisIsBusy()) {
    irisCancelRepeat()
    irisSession = s
    irisAgent = null
  }
  event.reply('iris-agent-session-data', s ? { id: s.id, title: s.title, status: s.status, items: s.items } : null)
})

ipc.on('iris-agent-session-delete', function (event, id) {
  try { fs.unlinkSync(irisSessionFile(id)) } catch (e) { /* already gone */ }
  if (irisSession && irisSession.id === id && !irisIsBusy()) {
    irisSession = null
    irisAgent = null
  }
  event.reply('iris-agent-sessions-reply', irisSessionList())
})

ipc.on('iris-agent-probe', async function (event, data) {
  const cfg = irisSettings()
  const result = await irisModelClient.probeServer({ baseUrl: (data && data.baseUrl) || cfg.baseUrl, apiKey: cfg.apiKey })
  event.reply('iris-agent-probe-reply', result)
})

ipc.on('iris-overlay-sync', function () {
  if (irisComputer && irisIsBusy()) showOverlay(irisComputer.tabId, irisComputer.fallbackBounds)
})

ipc.on('iris-agent-settings-changed', function () {
  broadcast('iris-agent-settings', irisSettings())
})

/* the settings page asks for / saves the profile through the browser UI (see agentPanel.js) */
ipc.on('iris-profile-get', function (event, data) {
  event.reply('iris-profile-data', { tabId: data && data.tabId, fields: irisProfileForPage() })
})

ipc.on('iris-profile-set', function (event, data) {
  try {
    irisProfileSave(data && data.fields)
    event.reply('iris-profile-data', { tabId: data && data.tabId, fields: irisProfileForPage(), saved: true })
  } catch (err) {
    event.reply('iris-profile-data', { tabId: data && data.tabId, fields: irisProfileForPage(), error: err.message })
  }
})

/* the model config can change while a run is idle; pick it up immediately */
settings.listen('irisAI', function () {
  broadcast('iris-agent-settings', irisSettings())
})

/* ------------------------------------------------------------------ *
 * Scheduled tasks (Settings → Iris AI → Schedule)
 * ------------------------------------------------------------------ */

function irisScheduleDue (s, now) {
  if (!s || !s.enabled || !s.task) return false
  const last = s.lastRun || 0
  if (s.at && /^\d{1,2}:\d{2}$/.test(s.at)) {
    const parts = s.at.split(':')
    const today = new Date(now)
    today.setHours(Number(parts[0]), Number(parts[1]), 0, 0)
    return now >= today.getTime() && last < today.getTime()
  }
  const every = Number(s.everyMinutes) || 0
  return every > 0 && now - last >= every * 60000
}

function irisCheckSchedules () {
  if (irisIsBusy()) return
  const list = settings.get('irisSchedules') || []
  const now = Date.now()
  const due = list.find(function (s) { return irisScheduleDue(s, now) })
  if (!due) return
  const updated = list.map(function (s) { return s.id === due.id ? Object.assign({}, s, { lastRun: now }) : s })
  settings.set('irisSchedules', updated)
  DBUG('schedule due: ' + due.task)
  // the browser UI opens a fresh tab and starts the task there, so it shows up in the panel
  broadcast('iris-agent-scheduled-run', { task: due.task, mode: due.mode || 'once', scheduleId: due.id })
}

setInterval(irisCheckSchedules, 30000)
