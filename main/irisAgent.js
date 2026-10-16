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

const { webContents: allWebContents, Notification: IrisNotification } = require('electron') // nativeImage comes from main.js (shared scope)
const irisActionSchema = require('./iris/agent/actionSchema.js')
const irisMapper = require('./iris/agent/coordinateMapper.js')
const irisInputPlan = require('./iris/agent/inputPlan.js')
const irisLoop = require('./iris/agent/agentLoop.js')
const irisModelClient = require('./iris/agent/modelClient.js')
const irisPrompts = require('./iris/agent/prompts.js')
const irisMemoryLib = require('./iris/agent/memory.js')
const irisLookupLib = require('./iris/agent/lookup.js')

const IRIS_SETTINGS_VERSION = 2

const IRIS_DEFAULT_SETTINGS = {
  settingsVersion: IRIS_SETTINGS_VERSION,
  baseUrl: 'http://192.168.1.252:13305/v1',
  model: 'Qwen3.8-Flash-Next-GGUF-IQ4_NL',
  apiKey: '',
  thinking: 'low', // off | low | medium | full
  accountMode: 'signup', // login: log in only · signup: log in, or create an account with My info
  emailAccess: false, // may Iris open the user's inbox to read sign-up codes and links?
  maxSteps: 40,
  maxMinutes: 20,
  temperature: 0.2,
  modelTimeoutMs: 180000,
  keepImages: 1,
  screenshotMaxDimension: 1280,
  screenshotQuality: 82,
  markerEnabled: true,
  autoPauseOnUserInput: true,
  lookups: true, // quick look-ups outside the browser (Smart planning + the lookup action)
  runLookups: 6, // look-ups allowed during one run
  smartLevel: 'quick' // quick | deep
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

/*
 * One model request at a time across every copy of Iris on this Mac. Two Iris windows asking the
 * same local server at once made llama-server stop answering; now the second one waits its turn.
 * A small lock file per server, refreshed while a request runs; a lock whose owner quit or that has
 * not been refreshed for 90 s is taken over.
 */
function irisModelLockFile (baseUrl) {
  const key = require('crypto').createHash('sha1').update(String(baseUrl || '')).digest('hex').slice(0, 12)
  return path.join(app.getPath('temp'), 'iris-model-' + key + '.lock')
}

var irisModelLocks = {}
function irisModelTurn (baseUrl, fn, onWait) {
  const file = irisModelLockFile(baseUrl)
  if (!irisModelLocks[file]) irisModelLocks[file] = require('./iris/agent/modelLock.js').createModelLock({ fs: fs, file: file })
  return irisModelLocks[file].turn(fn, onWait)
}

/* a model client whose every request waits for its turn */
function irisLockedModel (client, baseUrl) {
  return {
    next: function (opts) {
      return irisModelTurn(baseUrl, function () { return client.next(opts) }, function () {
        if (opts && typeof opts.onProgress === 'function') opts.onProgress({ phase: 'queued' })
      })
    }
  }
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
  { label: 'Password', value: '', secret: true },
  { label: 'Email inbox URL', value: '', secret: false }
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
    // {{account:site.com}} — the password of an account Iris made there
    const acct = /^account:\s*(.+)$/i.exec(name)
    if (acct) {
      const a = irisAccountsLoad().find(function (x) { return x.site.toLowerCase() === acct[1].trim().toLowerCase().replace(/^www\./, '') })
      const pw = a ? irisAccountPassword(a.site, a.username) : ''
      return pw || all
    }
    const key = name.toLowerCase()
    const hit = profile.find(function (f) { return f.label.toLowerCase() === key })
    return hit && hit.value ? hit.value : all
  })
}

/* ------------------------------------------------------------------ *
 * Memory beyond the context window
 *   • every download Iris made, in any chat (iris-downloads.json): duplicates are skipped by code
 *   • per chat: notes, downloads and pages visited, searchable with `recall`
 * ------------------------------------------------------------------ */

function irisDownloadsPath () {
  return path.join(userDataPath, 'iris-downloads.json')
}

var irisDownloadLog = null
function irisDownloads () {
  if (!irisDownloadLog) {
    let items = []
    try { items = JSON.parse(fs.readFileSync(irisDownloadsPath(), 'utf8')).items || [] } catch (e) { /* first download */ }
    irisDownloadLog = irisMemoryLib.createMemory(items)
  }
  return irisDownloadLog
}

function irisDownloadsSave () {
  try { fs.writeFileSync(irisDownloadsPath(), JSON.stringify({ items: irisDownloads().items().slice(-5000) })) } catch (e) { DBUG('download log: ' + e.message) }
}

function irisSessionMemory (session) {
  if (!session.memoryStore) session.memoryStore = irisMemoryLib.createMemory(session.memory || [])
  return session.memoryStore
}

/* ------------------------------------------------------------------ *
 * Projects: chats that share one plan and one memory (notes, decisions, downloads).
 * A new chat in a project starts where the others left off, so resetting a long
 * conversation loses nothing important. Only a short summary goes into the prompt.
 * ------------------------------------------------------------------ */

function irisProjectsPath () {
  return path.join(userDataPath, 'iris-projects.json')
}

function irisProjectsLoad () {
  try { return JSON.parse(fs.readFileSync(irisProjectsPath(), 'utf8')).projects || [] } catch (e) { return [] }
}

function irisProjectsSave (list) {
  fs.writeFileSync(irisProjectsPath(), JSON.stringify({ projects: list }, null, 1))
}

function irisProject (id) {
  return id ? irisProjectsLoad().find(function (p) { return p.id === id }) || null : null
}

function irisProjectUpdate (id, patch) {
  const list = irisProjectsLoad()
  const p = list.find(function (x) { return x.id === id })
  if (!p) return
  Object.assign(p, patch, { updated: Date.now() })
  try { irisProjectsSave(list) } catch (e) { DBUG('project save: ' + e.message) }
}

var irisProjectStores = {}
var irisProjectSaveTimers = {}

function irisProjectMemory (id) {
  if (!id) return null
  if (!irisProjectStores[id]) {
    let items = []
    try { items = JSON.parse(fs.readFileSync(path.join(userDataPath, 'iris-project-' + id.replace(/[^a-z0-9-]/gi, '') + '.json'), 'utf8')).items || [] } catch (e) { /* new project */ }
    irisProjectStores[id] = irisMemoryLib.createMemory(items)
  }
  return irisProjectStores[id]
}

function irisProjectMemoryAdd (id, kind, text, extra) {
  const store = irisProjectMemory(id)
  if (!store) return
  store.add(kind, text, extra)
  if (!irisProjectSaveTimers[id]) {
    irisProjectSaveTimers[id] = setTimeout(function () {
      irisProjectSaveTimers[id] = null
      try {
        fs.writeFileSync(path.join(userDataPath, 'iris-project-' + id.replace(/[^a-z0-9-]/gi, '') + '.json'), JSON.stringify({ items: store.items().slice(-8000) }))
      } catch (e) { DBUG('project memory: ' + e.message) }
    }, 2000)
  }
}

/** What every chat in the project knows up front: plan, latest notes, decisions so far. */
function irisProjectBrief (id) {
  const p = irisProject(id)
  if (!p) return ''
  const store = irisProjectMemory(id)
  const items = store ? store.items() : []
  const lines = ['Project "' + p.name + '" — shared by all chats in this project. Continue its work; do not redo what is already done.']
  if (p.plan) lines.push('Project plan (update_plan changes it for every chat):\n' + p.plan)
  const notes = items.filter(function (it) { return it.kind === 'note' }).slice(-8).map(function (it) { return '- ' + it.text })
  if (notes.length) lines.push('Latest project notes:\n' + notes.join('\n'))
  const verdicts = items.filter(function (it) { return it.kind === 'verdict' })
  const kept = verdicts.filter(function (it) { return /^Kept: /.test(it.text) }).map(function (it) { return it.text.replace(/^Kept: /, '').split(' — ')[0] })
  if (verdicts.length) lines.push('Project decisions: kept ' + kept.length + (kept.length ? ' (' + kept.slice(-15).join('; ') + ')' : '') + ', skipped ' + (verdicts.length - kept.length) + '.')
  const downloads = items.filter(function (it) { return it.kind === 'download' }).length
  if (downloads) lines.push('Files downloaded in this project: ' + downloads + '.')
  lines.push('Use recall to search everything this project has saved.')
  return lines.join('\n')
}

ipc.on('iris-projects', function (event) {
  event.reply('iris-projects-reply', { projects: irisProjectsLoad() })
})

ipc.on('iris-project-create', function (event, data) {
  const name = String((data && data.name) || '').trim().slice(0, 80)
  if (!name) return event.reply('iris-projects-reply', { projects: irisProjectsLoad() })
  const list = irisProjectsLoad()
  const project = { id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6), name: name, created: Date.now(), updated: Date.now(), plan: '' }
  list.push(project)
  try { irisProjectsSave(list) } catch (e) { DBUG('project create: ' + e.message) }
  event.reply('iris-projects-reply', { projects: list, created: project.id })
})

/* ------------------------------------------------------------------ *
 * Bookmarks: the browser UI owns them (Min's places); main asks it, and reads Chrome's file
 * ------------------------------------------------------------------ */

var irisBookmarkWaiters = {}
ipc.on('iris-agent-bookmarks-reply', function (e, data) {
  const w = data && irisBookmarkWaiters[data.id]
  if (w) { delete irisBookmarkWaiters[data.id]; w(data) }
})

function irisAskBookmarks (query) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  return new Promise(function (resolve) {
    irisBookmarkWaiters[id] = resolve
    broadcast('iris-agent-bookmarks-query', { id: id, query: query })
    setTimeout(function () {
      if (irisBookmarkWaiters[id]) { delete irisBookmarkWaiters[id]; resolve({ bookmarks: [], total: 0 }) }
    }, 3000)
  })
}

/* Google Chrome keeps bookmarks as JSON; folders become tags, the bar keeps its order. */
function irisChromeBookmarksFile () {
  const base = path.join(app.getPath('home'), 'Library', 'Application Support', 'Google', 'Chrome')
  let file = path.join(base, 'Default', 'Bookmarks')
  if (!fs.existsSync(file)) {
    let profiles = []
    try { profiles = fs.readdirSync(base).filter(function (n) { return /^Profile \d+$/.test(n) }) } catch (e) { /* no Chrome */ }
    const found = profiles.map(function (n) { return path.join(base, n, 'Bookmarks') }).find(function (f) { return fs.existsSync(f) })
    if (!found) throw new Error('Google Chrome bookmarks were not found on this Mac')
    file = found
  }
  return file
}

function irisReadChromeBookmarks (file) {
  return { bookmarks: require('./iris/agent/chromeBookmarks.js').parseChromeBookmarks(JSON.parse(fs.readFileSync(file, 'utf8'))), source: file }
}

ipc.on('iris-chrome-bookmarks', async function (event, data) {
  const tabId = data && data.tabId
  let file = null
  try {
    file = irisChromeBookmarksFile()
    return event.reply('iris-chrome-bookmarks-data', Object.assign({ tabId: tabId }, irisReadChromeBookmarks(file)))
  } catch (err) {
    if (err.code !== 'EPERM' && err.code !== 'EACCES') return event.reply('iris-chrome-bookmarks-data', { tabId: tabId, error: err.message })
  }
  // macOS protects other apps' data: a file the user picks themselves is allowed
  try {
    const pick = await dialog.showOpenDialog(windows.getCurrent(), {
      title: 'Import bookmarks from Chrome',
      message: 'macOS needs your OK: select Chrome\'s "Bookmarks" file (it is already highlighted) and click Import.',
      buttonLabel: 'Import',
      defaultPath: file,
      properties: ['openFile', 'showHiddenFiles']
    })
    if (pick.canceled || !pick.filePaths[0]) return event.reply('iris-chrome-bookmarks-data', { tabId: tabId, error: 'Import cancelled. You can also allow Iris in System Settings → Privacy & Security → Full Disk Access.' })
    event.reply('iris-chrome-bookmarks-data', Object.assign({ tabId: tabId }, irisReadChromeBookmarks(pick.filePaths[0])))
  } catch (err) {
    event.reply('iris-chrome-bookmarks-data', { tabId: tabId, error: err.message })
  }
})

/* ------------------------------------------------------------------ *
 * Accounts Iris created, so the user can find them later (Settings → Accounts)
 * ------------------------------------------------------------------ */

/* never treat a payment-looking placeholder as an account password */
function irisCardLikeLabel (text) {
  return /\{\{\s*(card|cvc|cvv|expiry)/i.test(String(text || ''))
}

function irisAccountsPath () {
  return path.join(userDataPath, 'iris-accounts.json')
}

function irisAccountsLoad () {
  try { return JSON.parse(fs.readFileSync(irisAccountsPath(), 'utf8')).accounts || [] } catch (e) { return [] }
}

function irisAccountSave (rec) {
  const list = irisAccountsLoad().filter(function (a) { return !(a.site === rec.site && a.username === rec.username) })
  const pw = String(rec.password || '')
  const ref = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(pw)
  list.push({
    site: rec.site,
    username: rec.username,
    url: rec.url || '',
    // a placeholder points at My info; anything else is kept encrypted like other secrets
    passwordRef: ref ? ref[1] : null,
    password: ref ? '' : irisEncrypt(pw),
    title: String(rec.title || '').slice(0, 120),
    purpose: String(rec.purpose || '').slice(0, 200),
    created: Date.now()
  })
  fs.writeFileSync(irisAccountsPath(), JSON.stringify({ accounts: list }, null, 1), { mode: 0o600 })
}

/* For the settings page: everything except the passwords themselves. */
function irisAccountsForPage () {
  return irisAccountsLoad().map(function (a) {
    return { site: a.site, username: a.username, url: a.url, title: a.title || '', purpose: a.purpose || '', created: a.created, passwordFrom: a.passwordRef ? 'My info › ' + a.passwordRef : (a.password ? 'saved here' : '') }
  })
}

/* "Show" in settings: the one password the user asked to see. */
function irisAccountPassword (site, username) {
  const a = irisAccountsLoad().find(function (x) { return x.site === site && x.username === username })
  if (!a) return ''
  if (a.passwordRef) {
    const f = irisProfileLoad().find(function (p) { return p.label.toLowerCase() === a.passwordRef.toLowerCase() })
    return f ? f.value : ''
  }
  return irisDecrypt(a.password)
}

/* ------------------------------------------------------------------ *
 * Skills: short tips Iris learned about each website, offered on the next visit
 * ------------------------------------------------------------------ */

function irisSkillsPath () {
  return path.join(userDataPath, 'iris-skills.json')
}

function irisSkillsLoad () {
  try { return JSON.parse(fs.readFileSync(irisSkillsPath(), 'utf8')) || {} } catch (e) { return {} }
}

function irisSiteOf (url) {
  try { return new URL(url).hostname.replace(/^www\./, '') || null } catch (e) { return null }
}

function irisSkillsFor (url) {
  const site = irisSiteOf(url)
  if (!site) return null
  const all = irisSkillsLoad()
  const tips = (all[site] || []).map(function (t) { return t.tip })
  return tips.length ? { site: site, tips: tips } : null
}

/* host + path + parameter names of the first URL in a tip: "the same kind of link" */
function irisUrlShape (text) {
  const m = /https?:\/\/[^\s]+/.exec(String(text || ''))
  if (!m) return null
  try {
    const u = new URL(m[0])
    return u.hostname + u.pathname + '?' + Array.from(u.searchParams.keys()).sort().join('&')
  } catch (e) { return null }
}

/** Tips for every site the task names (e.g. "on arxiv.org" → arxiv.org and export.arxiv.org). */
function irisSkillsForTask (task) {
  const all = irisSkillsLoad()
  const words = String(task || '').toLowerCase()
  const lines = []
  Object.keys(all).forEach(function (site) {
    const parts = site.split('.')
    const name = parts.length > 1 ? parts[parts.length - 2] : site
    if (name.length >= 3 && words.indexOf(name) !== -1) {
      ;(all[site] || []).forEach(function (t) { lines.push('- ' + site + ': ' + t.tip) })
    }
  })
  return lines.length ? 'Skills you learned before for this task:\n' + lines.slice(0, 15).join('\n') : ''
}

function irisLearn (url, tip) {
  const site = irisSiteOf(url)
  // at most 240 characters, ending at a sentence or a word, never mid-word
  let text = String(tip || '').trim()
  if (text.length > 240) {
    const cut = text.slice(0, 240)
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '))
    text = end > 120 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '…'
  }
  if (!site || !text) return
  const all = irisSkillsLoad()
  let list = all[site] || []
  if (list.some(function (t) { return t.tip.toLowerCase() === text.toLowerCase() })) return
  // one tip per kind of URL: a newer search URL with the same shape replaces the older one
  const shape = irisUrlShape(text)
  if (shape) list = list.filter(function (t) { return irisUrlShape(t.tip) !== shape })
  list.push({ tip: text, added: Date.now() })
  all[site] = list.slice(-12)
  try { fs.writeFileSync(irisSkillsPath(), JSON.stringify(all, null, 1)) } catch (e) { DBUG('skills save failed: ' + e.message) }
  settings.set('irisSkills', all)
}

/*
 * Playbooks: a Smart plan that led to a finished task, with the sites that worked. A later task
 * that reads alike starts from it instead of from nothing.
 */
/*
 * Skills the user writes: "when the task is about <words>, do this". Like a coding agent's skills,
 * only the ones whose words appear in the task are put in the prompt.
 */
function irisUserSkillsFor (task) {
  const list = settings.get('irisUserSkills')
  if (!Array.isArray(list) || !list.length) return ''
  const t = String(task || '').toLowerCase()
  const hits = list.filter(function (sk) {
    if (!sk || !sk.text || sk.enabled === false) return false
    const words = String(sk.when || '').toLowerCase().split(/[,;\n]+/).map(function (w) { return w.trim() }).filter(Boolean)
    return words.length === 0 || words.some(function (w) { return t.indexOf(w) !== -1 })
  }).slice(0, 4)
  if (!hits.length) return ''
  return 'The user\'s own instructions for this kind of task (follow them):\n' + hits.map(function (sk) {
    return '- ' + (sk.name ? sk.name + ': ' : '') + String(sk.text).slice(0, 600)
  }).join('\n')
}

function irisPlaybooksPath () {
  return path.join(userDataPath, 'iris-playbooks.json')
}

function irisPlaybooksLoad () {
  try { return JSON.parse(fs.readFileSync(irisPlaybooksPath(), 'utf8')).playbooks || [] } catch (e) { return [] }
}

function irisPlaybooksSave (list) {
  try { fs.writeFileSync(irisPlaybooksPath(), JSON.stringify({ playbooks: list }, null, 1)) } catch (e) { DBUG('playbooks save: ' + e.message) }
  settings.set('irisPlaybooks', list)
}

function irisPlaybookAdd (rec) {
  const words = irisMemoryLib.words(rec.task)
  const list = irisPlaybooksLoad().filter(function (p) {
    // a newer plan for the same kind of task replaces the older one
    const w = irisMemoryLib.words(p.task)
    const shared = w.filter(function (x) { return words.includes(x) }).length
    return shared < Math.max(3, Math.min(w.length, words.length) * 0.8)
  })
  list.push(rec)
  irisPlaybooksSave(list.slice(-60))
}

function irisPlaybookFor (task) {
  const words = Array.from(new Set(irisMemoryLib.words(task)))
  if (words.length < 2) return ''
  let best = null
  irisPlaybooksLoad().forEach(function (p) {
    const w = Array.from(new Set(irisMemoryLib.words(p.task)))
    const shared = w.filter(function (x) { return words.includes(x) }).length
    const score = shared / Math.max(1, Math.min(w.length, words.length))
    if (shared >= 2 && score >= 0.5 && (!best || score > best.score)) best = { p: p, score: score }
  })
  if (!best) return ''
  const p = best.p
  return 'A plan that worked before for a similar task ("' + p.task.slice(0, 120) + '", ' + new Date(p.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
    ', ' + p.steps + ' steps). Reuse what fits:\n' + p.plan.slice(0, 700) + (p.sites && p.sites.length ? '\nSites that worked: ' + p.sites.slice(0, 6).join(', ') : '')
}

settings.listen('irisPlaybooks', function (value) {
  if (!Array.isArray(value)) return
  try { fs.writeFileSync(irisPlaybooksPath(), JSON.stringify({ playbooks: value }, null, 1)) } catch (e) { /* ignore */ }
})

/* the settings page removes tips through the synced setting; keep the file in step */
settings.listen('irisSkills', function (value) {
  if (!value || typeof value !== 'object') return
  try { fs.writeFileSync(irisSkillsPath(), JSON.stringify(value, null, 1)) } catch (e) { /* ignore */ }
})

/* ------------------------------------------------------------------ *
 * Research log: every judgement Iris made, in any chat. When Iris lands on a page or sees a
 * search result it already judged, it is told so — it never re-reads the same paper by accident.
 * ------------------------------------------------------------------ */

function irisSeenPath () {
  return path.join(userDataPath, 'iris-seen.json')
}

var irisSeenLog = null
var irisSeenTimer = null
function irisSeen () {
  if (!irisSeenLog) {
    let items = []
    try { items = JSON.parse(fs.readFileSync(irisSeenPath(), 'utf8')).items || [] } catch (e) { /* nothing judged yet */ }
    irisSeenLog = irisMemoryLib.createMemory(items)
  }
  return irisSeenLog
}

function irisSeenAdd (kind, text, extra) {
  irisSeen().add(kind, text, extra)
  if (!irisSeenTimer) {
    irisSeenTimer = setTimeout(function () {
      irisSeenTimer = null
      try { fs.writeFileSync(irisSeenPath(), JSON.stringify({ items: irisSeen().items().slice(-20000) })) } catch (e) { DBUG('seen log: ' + e.message) }
    }, 1500)
  }
}

/*
 * "kept on Oct 14 (chat "harness papers"): fits the topic" — or null if never judged. A judgement this
 * chat made in the last few minutes is left out: a paper it just kept must not look like something to
 * avoid when Iris opens its PDF. Older ones in the same chat are flagged too — after hours of work
 * they have long left the context (a long run re-judged a paper it kept 55 steps earlier).
 */
function irisSeenNote (url, title, sessionId) {
  const hit = irisSeen().find(url, title, ['verdict'])
  if (hit && sessionId && hit.sessionId === sessionId && Date.now() - hit.at < 5 * 60 * 1000) return null
  if (!hit) {
    const dl = irisDownloads().findDownload(url, title)
    return dl ? 'already downloaded as ' + (dl.name || dl.text) + ' on ' + new Date(dl.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null
  }
  const when = new Date(hit.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const dl = irisDownloads().findDownload(url, title + ' ' + hit.text)
  return (hit.keep ? 'kept' : 'skipped') + ' on ' + when + (hit.chat ? ' (chat "' + String(hit.chat).slice(0, 40) + '")' : '') + (hit.why ? ': ' + String(hit.why).slice(0, 120) : '') +
    (dl ? '; its file is already in Downloads as ' + (dl.name || dl.text) : (hit.keep ? '; not downloaded yet' : ''))
}

/* IDs of papers judged in earlier chats about the same thing: skipped before they are even opened. */
function irisPriorJudged (task, sessionId) {
  const want = Array.from(new Set(irisMemoryLib.words(task)))
  if (want.length < 3) return ''
  const ids = []
  irisSeen().items().forEach(function (it) {
    if (it.kind !== 'verdict' || it.sessionId === sessionId || !it.ids || !it.ids.length) return
    const w = Array.from(new Set(irisMemoryLib.words(it.chat || '')))
    const shared = w.filter(function (x) { return want.includes(x) }).length
    if (shared / Math.max(1, Math.min(w.length, want.length)) < 0.5) return
    it.ids.forEach(function (id) {
      const short = id.replace(/^arxiv:/, '').replace(/^doi:/, 'doi ')
      if (!ids.includes(short)) ids.push(short)
    })
  })
  return ids.length ? 'Already judged in earlier chats on this topic — skip these, never open or download them again: ' + ids.slice(-300).join(', ') : ''
}

/* ------------------------------------------------------------------ *
 * Quick look-ups outside the browser (iris/agent/lookup.js). They go through an empty,
 * in-memory Chromium session — never the tabs' cookies or logins — and never to sites that
 * ban accounts for automated reading, nor to sites where the user has an account with Iris.
 * ------------------------------------------------------------------ */

var irisLookupInstance = null
function irisLookup () {
  if (!irisLookupInstance) {
    const ses = session.fromPartition('iris-lookup') // no "persist:" prefix: memory only, nothing shared
    irisLookupInstance = irisLookupLib.createLookup({
      fetch: function (url, opts) { return ses.fetch(url, opts) },
      never: irisLookupNever()
    })
  }
  return irisLookupInstance
}

function irisLookupNever () {
  const own = String(settings.get('irisLookupNever') || '').split(/[\s,]+/).filter(Boolean)
  const accounts = irisAccountsLoad().map(function (a) { return a.site }).filter(Boolean)
  return own.concat(accounts)
}
settings.listen('irisLookupNever', function () { irisLookupInstance = null })

async function irisDoLookup (req) {
  const result = await irisLookup().lookup(req, {
    annotate: function (it) {
      const note = irisSeenNote(it.url || '', (it.id || '') + ' ' + (it.title || ''), irisSession && irisSession.id)
      return note ? 'you ' + note : null
    }
  })
  irisUsageRecord('lookup')
  return result
}

/* ------------------------------------------------------------------ *
 * Usage: requests and tokens per day, shown in Settings → Iris AI → Usage
 * ------------------------------------------------------------------ */

function irisUsagePath () {
  return path.join(userDataPath, 'iris-usage.json')
}

var irisUsage = null
var irisUsageTimer = null
function irisUsageRecord (kind, data) {
  if (!irisUsage) {
    try { irisUsage = JSON.parse(fs.readFileSync(irisUsagePath(), 'utf8')) } catch (e) { irisUsage = { days: {} } }
  }
  const d = new Date()
  const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  const day = irisUsage.days[key] || (irisUsage.days[key] = { tasks: 0, requests: 0, input: 0, output: 0, ms: 0 })
  if (kind === 'task') day.tasks++
  if (kind === 'lookup') day.lookups = (day.lookups || 0) + 1
  if (kind === 'request') {
    day.requests++
    day.input += (data && data.prompt_tokens) || 0
    day.output += (data && data.completion_tokens) || 0
    day.ms += (data && data.ms) || 0
  }
  if (!irisUsageTimer) {
    irisUsageTimer = setTimeout(function () {
      irisUsageTimer = null
      try { fs.writeFileSync(irisUsagePath(), JSON.stringify(irisUsage)) } catch (e) { /* retry next time */ }
      settings.set('irisUsage', irisUsage)
    }, 10000)
  }
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

  this.watch(wc)
  const info = irisTabInfo(this.tabId)
  const tabNote = this.tabNote
  this.tabNote = null

  // a JavaScript dialog freezes the page: report it instead of waiting for a fresh frame
  if (this.pendingDialog && this.lastObservation) {
    const d = this.pendingDialog
    const obs = Object.assign({}, this.lastObservation, { tabs: irisTabList(), fingerprint: null, crop: null, memos: null })
    obs.note = 'The page opened a ' + d.type + ' dialog: "' + String(d.message || '').slice(0, 400) + '"' +
      (d.type === 'prompt' ? ' (it asks for text; default "' + (d.defaultPrompt || '') + '")' : '') +
      '. The page is frozen until you answer it with the dialog action (accept true = OK, false = Cancel).'
    return obs
  }

  // a brand-new tab has no page at all: describe it instead of photographing nothing
  if (!url || url === 'about:blank' || /^min:\/\/newtab/.test(url)) {
    // still opening: try again in a moment. Not loading: it is simply empty (a download link leaves
    // its tab blank, and a page that failed to load too) — Iris can carry on from there.
    if (info && info.url && !/^min:\/\/newtab/.test(info.url) && wc.isLoading() && Date.now() - (this.blankSince || (this.blankSince = Date.now())) < 8000) {
      this.tabNote = tabNote
      throw new Error('the new tab is still opening')
    }
    this.blankSince = 0
    const empty = Object.assign(this.emptyTabObservation(bounds), { tabs: irisTabList(), tabChanged: tabNote })
    if (info && info.url && !/^min:\/\/newtab/.test(info.url)) {
      empty.note = 'This tab shows nothing: its last address (' + info.url.slice(0, 120) + ') was a download or did not load. Open a page with navigate.'
    }
    return irisAttachEvents(this, empty)
  }
  this.blankSince = 0

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
  if (crop) this.lastClick = null // a close-up has its own coordinates: no marks on it
  const obs = this.finishCapture(image, size, crop || bounds, wc, sig)
  irisAttachEvents(this, obs)
  obs.skills = irisSkillsFor(obs.url)
  if (this.memory && obs.url && obs.url !== this.lastVisit) {
    this.lastVisit = obs.url
    this.memory.add('visit', obs.title || obs.url, { url: obs.url, title: obs.title })
    const seen = irisSeenNote(obs.url, obs.title, this.sessionId)
    // first line, and blunt: a soft hint at the end of the notes was read past
    if (seen) obs.note = 'STOP — you already judged this before: you ' + seen + '. Do not judge or download it again; go back and pick something new.' + (obs.note ? '\n' + obs.note : '')
    const applied = this.jobsMode && !(this.lastJob && irisJobKey(this.lastJob.url) === irisJobKey(obs.url)) ? irisApplicationNote(obs.url) : null
    if (applied) obs.note = applied + (obs.note ? '\n' + obs.note : '')
  }
  // Iris's own PDF viewer: say where its download button is (it fades out until the mouse is near)
  if (/^min:\/\/app\/pages\/pdfViewer\//.test(obs.url || '') && !crop) {
    const sx = obs.width / obs.viewWidth
    const sy = obs.height / obs.viewHeight
    let pdf = ''
    try { pdf = new URL(obs.url).searchParams.get('url') || '' } catch (e) { /* not a URL */ }
    obs.note = (obs.note ? obs.note + '\n' : '') + 'This is Iris\'s PDF viewer' + (pdf ? ' showing ' + pdf : '') +
      '. To save the PDF to Downloads, click its round download button at (' + Math.round((obs.viewWidth - 60) * sx) + ', ' + Math.round((obs.viewHeight - 50) * sy) +
      ') in the bottom-right corner (it may look faded).'
  }
  if (this.pendingChooser) {
    const files = irisRecentFiles(12)
    obs.note = (obs.note ? obs.note + '\n' : '') + 'A file picker is open (' + (this.pendingChooser.mode === 'selectMultiple' ? 'several files allowed' : 'one file') + '). ' +
      (this.lastResume && fs.existsSync(this.lastResume) ? 'For the resume, use {"type":"upload","file":"resume"} (the PDF made for this job, ' + path.basename(this.lastResume) + '). ' : '') +
      'Pick a file with {"type":"upload","file":"<name>"}. Recent files: ' + (files.length ? files.map(function (f) { return f.name }).join(', ') : '(none found)') + '.'
  }
  if (!crop) this.lastObservation = obs
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

/* A small red ✕ drawn into the screenshot (BGRA bitmap), 2 px thick, with a white outline. */
function irisDrawMiss (image, x, y) {
  const size = image.getSize()
  const buf = Buffer.from(image.toBitmap())
  const put = function (px, py, r, g, b) {
    if (px < 0 || py < 0 || px >= size.width || py >= size.height) return
    const i = (py * size.width + px) * 4
    buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = 255
  }
  const arm = Math.max(7, Math.round(size.width / 160))
  for (const pass of [[255, 255, 255, 2], [225, 29, 72, 1]]) {
    for (let d = -arm; d <= arm; d++) {
      for (let t = -pass[3]; t <= pass[3]; t++) {
        put(x + d + t, y + d, pass[0], pass[1], pass[2]); put(x + d + t, y - d, pass[0], pass[1], pass[2])
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size.width, height: size.height })
}

IrisComputer.prototype.finishCapture = function (image, size, bounds, wc, sig) {
  const fitted = irisMapper.fitDimensions(size.width, size.height, this.config.screenshotMaxDimension)
  let payload = image
  if (fitted.width !== size.width || fitted.height !== size.height) {
    payload = image.resize({ width: fitted.width, height: fitted.height, quality: 'better' })
  }
  // a click that changed nothing: mark the spot, so the model sees how far off it was
  let missNote = null
  const click = this.lastClick
  this.lastClick = null
  if (click && sig && click.fingerprint && sig.fingerprint === click.fingerprint && bounds.width) {
    const k = fitted.width / bounds.width
    try {
      payload = irisDrawMiss(payload, Math.round(click.x * k), Math.round(click.y * k))
      missNote = 'The red ✕ marks where your last click landed; nothing happened there. Aim at the centre of what you meant (zoom in if it is small).'
    } catch (e) { DBUG('miss mark: ' + e.message) }
  }
  if (sig) this.lastFingerprint = sig.fingerprint
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
    fingerprint: sig ? sig.fingerprint : null,
    note: missNote || undefined
  }
}

function irisFormatBytes (n) {
  if (!n || n < 0) return 'unknown size'
  if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

/* Finished downloads become a line in the observation and a permanent note. */
function irisAttachEvents (computer, obs) {
  const events = computer.takeEvents()
  if (computer.notes && computer.notes.length) {
    obs.note = (obs.note ? obs.note + '\n' : '') + computer.notes.join('\n')
    computer.notes = []
  }
  if (!events.length) return obs
  const lines = events.map(function (d) {
    return d.state === 'completed'
      ? 'Downloaded "' + d.name + '" (' + irisFormatBytes(d.bytes) + ') to the Downloads folder.'
      : 'The download of "' + d.name + '" failed (' + d.state + ').'
  })
  obs.note = (obs.note ? obs.note + '\n' : '') + lines.join('\n')
  obs.files = events.filter(function (d) { return d.state === 'completed' }).map(function (d) { return d.name })
  return obs
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
      try { wc.stopFindInPage('clearSelection') } catch (e) { /* nothing to clear */ }
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
    case 'find':
      return this.findInPage(wc, action.text)
    case 'recall': {
      const found = []
      const seen = new Set()
      const add = function (it) {
        const line = irisMemoryLib.describeItem(it)
        if (!seen.has(line)) { seen.add(line); found.push(line) }
      }
      if (this.memory) this.memory.search(action.query, 8).forEach(add)
      if (this.projectMemory) this.projectMemory.search(action.query, 8).forEach(add)
      irisDownloads().search(action.query, 5).forEach(add)
      this.notes = (this.notes || []).concat(found.length
        ? 'Recall "' + action.query + '":\n' + found.slice(0, 10).join('\n')
        : 'Recall "' + action.query + '": nothing saved matches that.')
      return { ok: true }
    }
    case 'bookmark': {
      const url = action.url ? irisResolveUrl(action.url) : wc.getURL()
      const title = action.title || (action.url ? url : wc.getTitle())
      broadcast('iris-agent-bookmark', { url: url, title: title, remove: !!action.remove })
      this.notes = (this.notes || []).concat(action.remove ? 'Removed the bookmark for ' + url + '.' : 'Bookmarked "' + title + '" on the bookmarks bar.')
      return { ok: true }
    }
    case 'bookmarks': {
      const found = await irisAskBookmarks(action.query || '')
      this.notes = (this.notes || []).concat(found.bookmarks.length
        ? 'Bookmarks' + (action.query ? ' matching "' + action.query + '"' : '') + ' (' + found.total + ' in all):\n' +
          found.bookmarks.map(function (b) { return '- ' + (b.title || b.url) + ' — ' + b.url }).join('\n')
        : 'No bookmarks match "' + (action.query || '') + '" (' + found.total + ' bookmarks in all).')
      return { ok: true }
    }
    case 'save_account':
      try {
        irisAccountSave({ site: action.site, username: action.username, password: action.password, url: wc.getURL(), title: wc.getTitle(), purpose: action.purpose || this.taskTitle || '' })
      } catch (e) {
        return { ok: false, error: 'could not save the account: ' + e.message }
      }
      this.notes = (this.notes || []).concat('Saved the account for ' + action.site + ' (' + action.username + ') in Settings → Accounts.')
      return { ok: true }
    case 'tailor_resume': {
      const job = { title: action.title, company: action.company || '', requirements: action.requirements || '', url: action.url || wc.getURL() }
      const before = irisApplicationFind(job)
      if (before && before.status === 'applied') {
        this.notes = (this.notes || []).concat('You already applied to ' + job.title + (job.company ? ' at ' + job.company : '') + ' on ' +
          new Date(before.updated || before.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + '. Skip it and find another job.')
        return { ok: true }
      }
      broadcastEvent({ type: 'resume:start', title: job.title, company: job.company, sessionId: this.sessionId })
      let r
      try { r = await irisTailorResume(job) } catch (e) { r = { ok: false, error: e.message } }
      if (!r.ok) {
        this.notes = (this.notes || []).concat('Could not make the resume: ' + r.error)
        broadcastEvent({ type: 'resume', ok: false, error: r.error, title: job.title, company: job.company, sessionId: this.sessionId })
        return { ok: true }
      }
      this.lastResume = r.file
      this.lastJob = { title: job.title, company: job.company, url: job.url, fit: r.fit }
      let note = 'Made a one-page resume for ' + job.title + (job.company ? ' at ' + job.company : '') + ' (' + (r.fit === null ? 'fit not rated' : 'fit ' + r.fit + '/100') +
        (r.focus ? ', focus: ' + r.focus : '') + '): ' + r.file + '.' + (r.missing && r.missing.length ? ' The profile does not show: ' + r.missing.join(', ') + '.' : '')
      note += r.below
        ? ' The fit is below the user\'s cutoff (' + r.cutoff + '): do not apply. log_application {"status":"skipped","note":"fit ' + r.fit + '"} and find the next job.'
        : ' When the form asks for a resume, click its upload button, then {"type":"upload","file":"resume"} picks this PDF.'
      this.notes = (this.notes || []).concat(note)
      broadcastEvent({ type: 'resume', ok: true, file: r.file, fit: r.fit, focus: r.focus, why: r.why, missing: r.missing, below: r.below, title: job.title, company: job.company, ms: r.ms, undone: (r.undone || []).length, sessionId: this.sessionId })
      return { ok: true }
    }
    case 'cover_letter': {
      const job = { title: action.title, company: action.company || (this.lastJob && this.lastJob.company) || '', requirements: action.requirements || '' }
      broadcastEvent({ type: 'resume:start', title: job.title, company: job.company, letter: true, sessionId: this.sessionId })
      let r
      try { r = await irisWriteCoverLetter(job) } catch (e) { r = { ok: false, error: e.message } }
      if (!r.ok) {
        this.notes = (this.notes || []).concat('Could not write the cover letter: ' + r.error)
        return { ok: true }
      }
      this.lastCover = r.file
      this.notes = (this.notes || []).concat('Wrote a cover letter (' + r.words + ' words' + (r.removed.length ? ', ' + r.removed.length + ' sentence(s) with facts not in the profile taken out' : '') + '): ' + path.basename(r.file) +
        '. Upload it with {"type":"upload","file":"cover letter"}.')
      broadcastEvent({ type: 'letter', ok: true, file: r.file, words: r.words, removed: r.removed.length, title: job.title, company: job.company, sessionId: this.sessionId })
      return { ok: true }
    }
    case 'log_application': {
      const job = this.lastJob || {}
      const rec = {
        status: action.status,
        company: action.company || job.company || '',
        title: action.title || job.title || '',
        url: job.url || action.url || wc.getURL(),
        note: action.note || '',
        resume: this.lastResume || '',
        fit: job.fit === undefined ? null : job.fit,
        sessionId: this.sessionId || ''
      }
      const item = irisApplicationAdd(rec)
      const label = { applied: 'Applied', skipped: 'Skipped', needs_you: 'Waiting for the user', failed: 'Could not apply' }[rec.status]
      this.notes = (this.notes || []).concat('Logged in Settings → Jobs → Applications: ' + label + ' — ' + (rec.title || 'job') + (rec.company ? ' at ' + rec.company : '') + '.' +
        (rec.status === 'applied' ? ' Applications sent today: ' + irisAppliedToday() + '.' : '') + ' Go on to the next job.')
      if (rec.status === 'needs_you') irisNotify('A job application needs you', (rec.title || 'A job') + (rec.company ? ' at ' + rec.company : '') + (rec.note ? ': ' + rec.note : ''))
      broadcastEvent({ type: 'application', item: item, sessionId: this.sessionId })
      this.lastResume = null
      this.lastCover = null
      this.lastJob = null
      return { ok: true }
    }
    case 'dialog': {
      if (!this.pendingDialog) return { ok: false, error: 'no dialog is open' }
      try {
        await wc.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: !!action.accept, promptText: action.text || '' })
      } catch (e) {
        return { ok: false, error: 'could not answer the dialog: ' + e.message }
      }
      this.pendingDialog = null
      return { ok: true, pageChanged: true }
    }
    case 'upload': {
      const chooser = this.pendingChooser
      if (!chooser) return { ok: false, error: 'no file picker is open; click the upload button or "Choose file" first' }
      // "resume" means the one tailor_resume just made (long paths get mistyped)
      const wanted = String(action.file || '').trim()
      let file = null
      if (this.lastResume && fs.existsSync(this.lastResume) && (/^(the |my |tailored )*(resume|cv|résumé)( pdf| file)?$/i.test(wanted) || path.basename(wanted) === path.basename(this.lastResume))) file = this.lastResume
      if (!file && this.lastCover && fs.existsSync(this.lastCover) && (/^(the |my )*cover( letter)?( pdf| file)?$/i.test(wanted) || path.basename(wanted) === path.basename(this.lastCover))) file = this.lastCover
      if (!file) file = irisFindFile(action.file)
      if (!file) return { ok: false, error: 'no file named "' + action.file + '" in Downloads, Desktop or Documents' }
      try {
        await wc.debugger.sendCommand('DOM.setFileInputFiles', { files: [file], backendNodeId: chooser.backendNodeId })
      } catch (e) {
        return { ok: false, error: 'could not choose the file: ' + e.message }
      }
      this.pendingChooser = null
      this.notes = (this.notes || []).concat('Chose the file "' + path.basename(file) + '" in the file picker.')
      return { ok: true, pageChanged: true }
    }
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

  // a click that lands just beside a link, button or field moves onto it, like a hand finding the target
  if ((action.type === 'click' || action.type === 'double_click' || (action.type === 'type' && action.x !== undefined)) && this.config.snapClicks !== false) {
    const snapped = await this.snapToTarget(wc, action)
    if (snapped) action = Object.assign({}, action, { x: snapped.x, y: snapped.y })
  }

  // secrets are filled in here, at the last moment: the model and the panel only see {{Label}}
  const real = action.type === 'type' ? Object.assign({}, action, { text: irisFillSecrets(action.text) }) : action
  const plan = irisInputPlan.planInputEvents(real, { from: this.pointer })

  // Mark "we are driving" so genuine human input can be told apart from our own events.
  this.injecting = true
  try {
    for (const step of plan) {
      if (step.command) wc[step.command]() // Edit-menu command: selectAll / copy / paste / cut / undo / redo
      else wc.sendInputEvent(step.event)
      if (step.delayMs) await sleep(step.delayMs)
    }
  } finally {
    self.injecting = false
    self.injectingUntil = Date.now() + 400
  }
  this.pointer = irisInputPlan.pointerAfter(action) || this.pointer
  // where this click landed, so the next look can show it if nothing happened
  this.lastClick = (action.type === 'click' || action.type === 'double_click') ? { x: action.x, y: action.y, fingerprint: this.lastFingerprint || null } : null
  if (action.type === 'type') {
    // say exactly what went in, so a box that merely looks cut off is not "fixed" by mistake
    const secret = action.text.indexOf('{{') !== -1
    this.notes = (this.notes || []).concat('Typed ' + (secret ? action.text + ' (' + real.text.length + ' characters, filled in from My info)' : '"' + action.text + '"') +
      (action.clear === false ? ' (added to the existing text).' : ' (replacing what was in the field).'))
  }
  return { ok: true, events: plan.length }
}

/*
 * Aim like a person: move the pointer to the spot and look at its shape. Over a link or button it
 * becomes a hand, over a text field an I-beam. If the spot shows the plain arrow, look a few pixels
 * around it (up to 10 px) for the nearest hand or I-beam and use that instead. Only the pointer
 * moves; nothing in the page is read. Returns {x, y} when it moved the aim, otherwise null.
 */
const IRIS_SNAP_RINGS = [3, 6, 10]
/* controls that show the plain arrow on purpose: aiming at one must never slide onto a link beside it */
const IRIS_ARROW_CONTROLS = /check ?box|tick|radio|toggle|switch|dropdown|drop-down|select (box|menu)|slider|option|captcha|canvas|map|image|picture|photo|calendar|date picker/i
IrisComputer.prototype.snapToTarget = async function (wc, action) {
  if (IRIS_ARROW_CONTROLS.test(action.intent || '')) return null
  const want = action.type === 'type' ? ['text', 'hand'] : ['hand', 'text']
  const look = async function (self, x, y) {
    wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y), movementX: 0, movementY: 0 })
    await sleep(30)
    return self.cursorType
  }
  if (this.cursorType === null && !this.cursorSeen) {
    // no shape reported yet on this page: one move teaches us whether this page reports any
    await look(this, action.x, action.y)
    this.cursorSeen = true
  }
  const here = await look(this, action.x, action.y)
  if (!here || want.indexOf(here) !== -1 || (here !== 'pointer' && here !== 'default')) return null
  for (const r of IRIS_SNAP_RINGS) {
    // look all the way round before choosing: targets on two sides means the aim was between them
    const found = []
    for (let k = 0; k < 8; k++) {
      const a = k * Math.PI / 4
      const shape = await look(this, action.x + Math.cos(a) * r, action.y + Math.sin(a) * r)
      if (shape === want[0] || (shape === want[1] && r <= 6)) found.push({ k: k, shape: shape })
    }
    if (!found.length) continue
    const ks = found.map(function (f) { return f.k })
    // one target: all hits within a quarter turn of each other (going round the circle)
    let center = null
    for (const start of ks) {
      const spread = ks.map(function (k) { return (k - start + 8) % 8 })
      if (Math.max.apply(null, spread) <= 2) { center = (start + Math.round((Math.max.apply(null, spread)) / 2)) % 8; break }
    }
    if (center === null) {
      DBUG('snap skipped at (' + action.x + ',' + action.y + '): targets on more than one side')
      return null
    }
    const a = center * Math.PI / 4
    const shape = (found.find(function (f) { return f.k === center }) || found[0]).shape
    // a step further in, so the click is not on the very edge
    const x = Math.round(action.x + Math.cos(a) * r)
    const y = Math.round(action.y + Math.sin(a) * r)
    const x2 = Math.round(action.x + Math.cos(a) * (r + 2))
    const y2 = Math.round(action.y + Math.sin(a) * (r + 2))
    const pick = (await look(this, x2, y2)) === shape ? { x: x2, y: y2 } : { x: x, y: y }
    DBUG('snap ' + action.type + ' (' + action.x + ',' + action.y + ') → (' + pick.x + ',' + pick.y + ') ' + shape)
    this.snaps = (this.snaps || 0) + 1
    return pick
  }
  return null
}

/*
 * Find on page — the browser's own Cmd+F. Chromium scrolls the match into view and highlights
 * it; Iris reads the match count the way a person reads "2 of 5" in the find bar.
 */
IrisComputer.prototype.findInPage = function (wc, text) {
  const self = this
  const again = this.lastFind && this.lastFind.text === text && this.lastFind.url === wc.getURL()
  return new Promise(function (resolve) {
    let timer = null
    let latest = null
    self.lastFindAnswered = false
    const report = function (result) {
      self.lastFindAnswered = true
      clearTimeout(timer)
      wc.removeListener('found-in-page', onFound)
      self.lastFind = { text: text, url: wc.getURL() }
      if (!result) {
        self.notes = (self.notes || []).concat('Find "' + text + '": the page did not report matches yet (it may still be loading). Look at the screenshot; try again or scroll.')
      } else {
        self.notes = (self.notes || []).concat(result.matches
          ? 'Find "' + text + '": match ' + result.activeMatchOrdinal + ' of ' + result.matches + ' is highlighted and scrolled into view' + (result.matches > 1 ? ' (find the same text again for the next one).' : '.')
          : 'Find "' + text + '": no matches on this page.')
      }
      resolve({ ok: true })
    }
    const onFound = function (event, result) {
      latest = result
      // busy pages (ads still loading) can delay the final count; the first answer is enough
      if (result.finalUpdate || result.matches) report(result)
    }
    wc.on('found-in-page', onFound)
    timer = setTimeout(function () { report(latest) }, 6000)
    wc.findInPage(text, { findNext: !!again, forward: true })
    // the first search on a page that has only just loaded sometimes gets no answer: ask once more
    setTimeout(function () { if (!latest && !self.lastFindAnswered) wc.findInPage(text, { findNext: false, forward: true }) }, 2000)
  })
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
  // typing into a search box or address field: give its suggestion list time to catch up
  if (action && action.type === 'type' && !action.enter) await sleep(450)
  // a click that started a download: let it finish (briefly) so the next look says "Downloaded …"
  const dlStarted = Date.now()
  while ((this.downloadsPending || 0) > 0 && Date.now() - dlStarted < 5000) await sleep(150)
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

/*
 * Browser-level UI the page cannot draw: JavaScript dialogs (alert / confirm / prompt) and the
 * operating system's file picker. Iris watches for them through the tab's DevTools channel —
 * the same way Chrome DevTools sees a dialog — and answers them like a person clicking OK or
 * choosing a file. Nothing in the page itself is read or changed.
 *
 * Native <select> pop-ups are drawn by macOS outside the page, where a screenshot cannot see
 * them; a user-level style asks Chromium to draw them inside the page instead.
 */
const IRIS_SELECT_CSS = 'select, ::picker(select) { appearance: base-select; }' +
  // the browser's "please fill in this field" bubble is native too: mark invalid fields visibly
  ' :user-invalid { outline: 3px solid #e11d48 !important; outline-offset: 1px !important; }'

IrisComputer.prototype.watch = function (wc) {
  const self = this
  if (this.watched === wc) return
  this.unwatch()
  this.watched = wc
  this.pendingDialog = null
  this.pendingChooser = null
  const styleSelects = function () {
    wc.insertCSS(IRIS_SELECT_CSS, { cssOrigin: 'user' }).then(function (key) { self.cssKey = key }).catch(function () {})
  }
  // the pointer's shape, as the page sets it: "hand" over links and buttons, "text" over fields
  const onCursor = function (event, type) { self.cursorType = type }
  self.cursorType = null
  wc.on('cursor-changed', onCursor)
  const onMessage = function (event, method, params) {
    if (method === 'Page.javascriptDialogOpening') {
      self.pendingDialog = params
    } else if (method === 'Page.javascriptDialogClosed') {
      self.pendingDialog = null
    } else if (method === 'Page.fileChooserOpened') {
      self.pendingChooser = params
    } else if (method === 'Page.frameNavigated' && params.frame && !params.frame.parentId) {
      self.pendingChooser = null
    }
  }
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
    this.attachedDebugger = true
    wc.debugger.on('message', onMessage)
    wc.debugger.sendCommand('Page.enable').then(function () {
      return wc.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true })
    }).catch(function (e) { DBUG('debugger setup failed: ' + e.message) })
  } catch (e) {
    this.attachedDebugger = false
    DBUG('debugger attach failed: ' + e.message)
  }
  wc.on('dom-ready', styleSelects)
  styleSelects()
  this.unwatchFn = function () {
    try { wc.removeListener('dom-ready', styleSelects) } catch (e) { /* gone */ }
    try { wc.removeListener('cursor-changed', onCursor) } catch (e) { /* gone */ }
    try { wc.debugger.removeListener('message', onMessage) } catch (e) { /* gone */ }
    try { if (self.attachedDebugger && wc.debugger.isAttached()) wc.debugger.detach() } catch (e) { /* gone */ }
    try { if (self.cssKey) wc.removeInsertedCSS(self.cssKey) } catch (e) { /* gone */ }
  }
}

IrisComputer.prototype.unwatch = function () {
  if (this.unwatchFn) this.unwatchFn()
  this.unwatchFn = null
  this.watched = null
  this.cssKey = null
}

/* Files Iris may offer for an upload: the most recent ones in Downloads, Desktop and Documents. */
function irisRecentFiles (limit) {
  const dirs = ['downloads', 'desktop', 'documents'].map(function (k) { try { return app.getPath(k) } catch (e) { return null } }).filter(Boolean)
  const files = []
  dirs.forEach(function (dir) {
    let names = []
    try { names = fs.readdirSync(dir) } catch (e) { return }
    names.forEach(function (n) {
      if (n[0] === '.') return
      try {
        const full = path.join(dir, n)
        const st = fs.statSync(full)
        if (st.isFile()) files.push({ name: n, path: full, mtime: st.mtimeMs, size: st.size })
      } catch (e) { /* unreadable */ }
    })
  })
  files.sort(function (a, b) { return b.mtime - a.mtime })
  return files.slice(0, limit || 15)
}

function irisFindFile (name) {
  const wanted = String(name || '').trim().replace(/^~(?=\/)/, app.getPath('home'))
  if (path.isAbsolute(wanted)) return fs.existsSync(wanted) ? wanted : null
  const all = irisRecentFiles(400)
  const exact = all.find(function (f) { return f.name === wanted })
  if (exact) return exact.path
  const lower = wanted.toLowerCase()
  const loose = all.find(function (f) { return f.name.toLowerCase() === lower }) || all.find(function (f) { return f.name.toLowerCase().indexOf(lower) !== -1 })
  return loose ? loose.path : null
}

/** Things that happened outside the page since the last look (finished downloads). */
IrisComputer.prototype.takeEvents = function () {
  const done = this.downloads || []
  this.downloads = []
  return done
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
      if (session.memoryStore) session.memory = session.memoryStore.items().slice(-3000)
      fs.writeFileSync(irisSessionFile(session.id), JSON.stringify(session, function (k, v) { return k === 'memoryStore' ? undefined : v }))
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
      list.push({ id: s.id, title: s.title, created: s.created, updated: s.updated, status: s.status, runs: results.length, projectId: s.projectId || null })
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
  } else if (type === 'resume' && p.ok) {
    items.push({ kind: 'note', text: 'Made a resume for ' + p.title + (p.company ? ' at ' + p.company : '') + (p.fit !== null && p.fit !== undefined ? ' (fit ' + p.fit + ')' : '') + ': ' + path.basename(path.dirname(p.file)) })
  } else if (type === 'application' && p.item) {
    items.push({ kind: 'note', text: ({ applied: 'Applied', skipped: 'Skipped', needs_you: 'Needs you', failed: 'Could not apply' }[p.item.status] || p.item.status) + ': ' + (p.item.title || 'job') + (p.item.company ? ' — ' + p.item.company : '') })
  } else if (type === 'plan') {
    items.push({ kind: 'plan', text: p.text })
  } else if (type === 'verdict') {
    items.push({ kind: 'verdict', item: p.item, keep: p.keep, why: p.why, url: p.url || '' })
    irisSessionMemory(session).add('verdict', (p.keep ? 'Kept: ' : 'Skipped: ') + p.item + (p.why ? ' — ' + p.why : ''))
  } else if (type === 'run:end') {
    items.push({ kind: 'result', status: p.status, answer: p.answer, reason: p.reason, steps: p.steps, ms: p.stats && p.stats.elapsedMs })
    session.status = p.status
  } else {
    return
  }
  irisSessionSave(session, type === 'run:end')
}

/*
 * A research run that kept two or more things leaves a short Markdown report next to its
 * downloads: what was kept, why, and where. Built from the recorded decisions, no model call.
 */
function irisWriteReport (session, answer) {
  try {
    const items = session.items
    let start = 0
    for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'user') { start = i; break }
    const run = items.slice(start)
    const kept = run.filter(function (it) { return it.kind === 'verdict' && it.keep })
    if (kept.length < 2) return null
    const skipped = run.filter(function (it) { return it.kind === 'verdict' && !it.keep }).length
    const files = run.filter(function (it) { return it.kind === 'note' && /^Downloaded /.test(it.text) }).map(function (it) { return it.text.replace(/^Downloaded /, '') })
    const lines = ['# ' + (items[start] && items[start].text ? items[start].text : session.title), '',
      new Date().toLocaleString('en-US') + ' · kept ' + kept.length + ', skipped ' + skipped + ' · made by Iris', '', '## Kept', '']
    kept.forEach(function (it, i) {
      lines.push((i + 1) + '. **' + it.item + '**' + (it.url && /^https?:/.test(it.url) ? ' — ' + it.url : ''))
      if (it.why) lines.push('   ' + it.why)
    })
    if (files.length) lines.push('', '## Downloaded', '', files.map(function (f) { return '- ' + f }).join('\n'))
    if (answer) lines.push('', '## Iris\'s answer', '', String(answer))
    const name = 'Iris report - ' + String(session.title || 'research').replace(/[/\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) + '.md'
    const file = path.join(irisDownloadDir(), name)
    fs.writeFileSync(file, lines.join('\n') + '\n')
    return name
  } catch (e) {
    DBUG('report: ' + e.message)
    return null
  }
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

/*
 * A macOS notification when Iris needs the user (a question, a CAPTCHA, an approval) or
 * finishes, but only while Iris is not the app in front: if the user is watching, the panel says it.
 */
function irisNotify (title, body) {
  try {
    if (!IrisNotification.isSupported()) return
    const win = windows.getCurrent()
    if (win && !win.isDestroyed() && win.isFocused()) return
    const n = new IrisNotification({ title: title, body: String(body || '').slice(0, 220), silent: false })
    n.on('click', function () {
      const w = windows.getCurrent()
      if (w && !w.isDestroyed()) { w.show(); w.focus() }
    })
    n.show()
  } catch (e) { DBUG('notify: ' + e.message) }
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

var irisSkillsLogged = null

/* Models are bad at weekday arithmetic: name the coming Mondays so dates can be checked, not guessed. */
function irisCalendarHint (now) {
  // the next 14 days with their weekdays: "next Friday" or "this weekend" is read off, not computed
  const day = new Date(now)
  day.setHours(12, 0, 0, 0)
  const next = []
  for (let i = 1; i <= 14; i++) {
    day.setDate(day.getDate() + 1)
    next.push(day.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).replace(',', ''))
  }
  const d = new Date(now)
  d.setHours(12, 0, 0, 0)
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7) + 14) // Mondays after those two weeks
  const mondays = []
  for (let i = 0; i < 6; i++) {
    mondays.push(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))
    d.setDate(d.getDate() + 7)
  }
  return 'Next 14 days: ' + next.join(', ') + '. Later Mondays: ' + mondays.join(', ') + '. Read weekdays from this list, never work them out.'
}

/*
 * What Iris is told besides the task: { stable, live }. The stable part opens every request and
 * stays byte-identical during a run, so the model server reuses its cache; whatever changes while
 * Iris works (a project's latest notes, the jobs handled so far) is the live part, sent last.
 */
function irisSystemExtra (mode, task, projectId, sessionId) {
  const parts = []
  const live = []
  const brief = irisProjectBrief(projectId)
  if (brief) live.push(brief)
  const now = new Date()
  parts.push('Today is ' + now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) + '. ' + irisCalendarHint(now))
  const profile = irisPrompts.profileText(irisProfileForPrompt())
  if (profile) parts.push(profile)
  const modeText = irisPrompts.modeText(mode)
  if (modeText) parts.push(modeText)
  const accountMode = irisSettings().accountMode
  if (irisProfileForPrompt().length) {
    parts.push(accountMode === 'login'
      ? 'When a site needs an account, log in with the user\'s saved email or username and password. Never create new accounts; if logging in fails, use ask_user.'
      : 'When a site needs an account, first log in with the user\'s saved email or username and password. If the user has no account there, sign up with their saved details (name, email, password, and anything else the form asks that you know), accept the usual terms, then continue the task. Never guess personal details (country, address, birthday, phone, gender, job): if My info does not have one a form needs, use ask_user — even when the site suggests a default. After creating an account, record it with save_account.')
    parts.push(irisSettings().emailAccess
      ? 'If a site emails a verification code or link: open a new tab, go to the user\'s email inbox (the "Email inbox URL" in their details, or their usual webmail), sign in with their saved details if needed, open the newest message from that site, read the code or click the link, then close that tab and switch back. Codes sent by text message or phone: use ask_user.'
      : 'If a site sends a verification code or link (email or phone), use ask_user: the user will tell you the code or open the link.')
  }
  parts.push('Payments: Iris has no payment card. If the task needs a payment, go as far as the payment page, then stop and tell the user what is ready (or use ask_user). Never make up card details.')
  const skills = irisSkillsForTask(task)
  if (skills) parts.push(skills)
  const playbook = irisPlaybookFor(task)
  if (playbook) parts.push(playbook)
  const userSkills = irisUserSkillsFor(task)
  if (userSkills) parts.push(userSkills)
  const prior = irisPriorJudged(task, sessionId)
  if (prior) parts.push(prior)
  if (irisJobsActive(task)) {
    const jobs = irisJobsPrompt(task, mode)
    parts.push(jobs.stable)
    if (jobs.live) live.push(jobs.live)
  }
  if ((playbook || userSkills) && irisSkillsLogged !== task) {
    irisSkillsLogged = task
    DBUG('prompt extras: playbook=' + !!playbook + ' userSkills=' + (userSkills ? userSkills.split('\n').length - 1 : 0))
  }
  const rules = String(settings.get('irisRules') || '').trim()
  if (rules) parts.push('Rules from the user. Always follow these, they override everything else:\n' + rules)
  return { stable: parts.join('\n\n'), live: live.join('\n\n') }
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
  if (!irisSession) {
    irisSession = irisNewSession(task)
    if (options.projectId && irisProject(options.projectId)) irisSession.projectId = options.projectId
  }
  const session = irisSession
  session.run = (session.run || 0) + 1
  session.items.push({ kind: 'user', text: task, mode: options.mode || 'once', run: session.run })
  irisSessionSave(session, true)

  const mode = options.mode === 'continuous' || options.mode === 'repeat' ? options.mode : 'once'
  const unlimited = mode === 'continuous'
  // Deep Smart runs research first and judge more: they get twice the steps and time
  const budgetScale = options.plan === 'deep' ? 2 : 1

  const computer = new IrisComputer(tabId, cfg, {
    onTabChange: function (newTabId) {
      irisAgentState.tabId = newTabId
      irisBindInput(newTabId, cfg)
    }
  }, options.viewBounds)
  computer.memory = irisSessionMemory(session)
  computer.taskTitle = session.title
  computer.sessionId = session.id
  computer.projectId = session.projectId || null
  computer.projectMemory = irisProjectMemory(session.projectId)
  computer.jobsMode = irisJobsActive(session.title + '\n' + task)
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
    : irisLockedModel(irisModelClient.createModelClient({
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      apiKey: cfg.apiKey,
      temperature: cfg.temperature,
      thinking: cfg.thinking,
      timeoutMs: cfg.modelTimeoutMs
    }), cfg.baseUrl)

  const agent = irisLoop.createAgent({
    model: model,
    computer: computer,
    lookup: cfg.lookups === false ? null : irisDoLookup,
    config: {
      systemExtra: function () { return irisSystemExtra(mode, session.title + '\n' + task, session.projectId, session.id) },
      maxServerWaitMs: unlimited ? 0 : 10 * 60 * 1000,
      askTimeoutMs: unlimited ? 10 * 60 * 1000 : 0, // an overnight run does not wait all night for an answer
      planThinking: cfg.thinking === 'full' ? 'full' : 'medium',
      runLookups: cfg.lookups === false ? 0 : (Number(cfg.runLookups) >= 0 ? Number(cfg.runLookups) : 6)
    },
    safety: {
      maxSteps: unlimited ? 0 : cfg.maxSteps * budgetScale,
      maxModelMsPerStep: cfg.modelTimeoutMs + 5000,
      maxWallClockMs: unlimited ? 0 : Math.max(1, cfg.maxMinutes) * budgetScale * 60 * 1000,
      // a long run must survive a flaky moment instead of giving up after three errors
      maxConsecutiveFailures: unlimited ? 12 : 4,
      maxRetriesPerStep: unlimited ? 8 : 3,
      // Jobs with "ask before submitting": pause before the click that sends an application
      applicationGuard: computer.jobsMode && irisCareerLoad().prefs.autoSubmit === false ? 'ask' : 'auto'
    },
    history: { keepImages: cfg.keepImages, maxMessages: unlimited ? 30 : 40 },
    log: DBUG,
    onEvent: function (type, payload) {
      if (type === 'run:start') { irisUsageRecord('task'); session.runUrls = [] }
      if (type === 'remember' && payload.note && !payload.automatic) {
        irisSessionMemory(session).add('note', payload.note)
        if (session.projectId) irisProjectMemoryAdd(session.projectId, 'note', payload.note)
      }
      if (session.projectId && type === 'verdict') irisProjectMemoryAdd(session.projectId, 'verdict', (payload.keep ? 'Kept: ' : 'Skipped: ') + payload.item + (payload.why ? ' — ' + payload.why : ''))
      if (type === 'verdict') {
        let here = ''
        try { here = computer.view().webContents.getURL() } catch (e) { /* tab gone */ }
        irisSeenAdd('verdict', payload.item, { url: here, keep: !!payload.keep, why: payload.why || '', chat: session.title, name: payload.item, sessionId: session.id })
        payload = Object.assign({}, payload, { url: here })
      }
      if (type === 'run:end' && payload.status === 'done') {
        const file = irisWriteReport(session, payload.answer)
        if (file) {
          session.items.push({ kind: 'note', text: 'Saved a report: ' + file })
          broadcastEvent({ type: 'remember', note: 'Saved a report of what was kept: ' + file, sessionId: session.id })
        }
      }
      // look-up results become searchable with recall, so a long run can find them again
      if (type === 'lookup:result' && payload.items) {
        payload.items.slice(0, 8).forEach(function (it) {
          if (it.url) irisSessionMemory(session).add('found', (it.title || '') + (it.id ? ' (' + it.id + ')' : ''), { url: it.url, title: it.title })
        })
        payload = Object.assign({}, payload, { items: undefined })
      }
      if (session.projectId && type === 'plan' && payload.text) irisProjectUpdate(session.projectId, { plan: payload.text })
      if (type === 'plan' && payload.text) session.lastPlan = payload.text
      if (type === 'observation' && payload.url) {
        const host = irisSiteOf(payload.url)
        if (host && !/^(duckduckgo\.com|google\.|bing\.com)/.test(host)) {
          session.runHosts = session.runHosts || []
          if (!session.runHosts.includes(host)) session.runHosts.push(host)
        }
      }
      if (type === 'run:end' && payload.status === 'done' && session.lastPlan) {
        irisPlaybookAdd({ task: task.slice(0, 300), plan: session.lastPlan.slice(0, 1200), sites: (session.runHosts || []).slice(0, 8), steps: payload.steps || 0, at: Date.now() })
      }
      if (type === 'run:end') { session.lastPlan = null; session.runHosts = [] }
      // remember direct URLs that led to a successful answer: next time they are the shortcut
      if (type === 'action' && payload.action && payload.action.type === 'navigate') {
        const resolved = irisResolveUrl(payload.action.url)
        if (/\?/.test(resolved) && !/duckduckgo\.com\/\?q=/.test(resolved)) (session.runUrls = session.runUrls || []).push(resolved)
      }
      // a sign-up during this run is recorded even if the model forgets save_account
      if (type === 'thought' && payload.thought && /sign ?up|create (an |your |a new )?account|register|create one/i.test(payload.thought)) {
        session.signup = session.signup || { saved: false }
        session.signup.active = true
      }
      if (type === 'action' && payload.action && session.signup && session.signup.active) {
        const a = payload.action
        if (a.type === 'save_account') session.signup.saved = true
        if (a.type === 'type' && /\{\{[^}]+\}\}/.test(a.text) && !irisCardLikeLabel(a.text)) {
          session.signup.password = a.text.trim()
          session.signup.site = irisSiteOf(computer.state().url)
        } else if (a.type === 'type' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.text.trim())) {
          session.signup.username = a.text.trim()
        }
      }
      if (type === 'run:end' && session.signup) {
        const su = session.signup
        if (payload.status === 'done' && !su.saved && su.site && su.username && su.password) {
          try {
            irisAccountSave({ site: su.site, username: su.username, password: su.password, url: computer.state().url, purpose: session.title })
            broadcastEvent({ type: 'remember', note: 'Saved the new ' + su.site + ' account in Settings → Accounts', sessionId: session.id })
          } catch (e) { DBUG('auto account save failed: ' + e.message) }
        }
        session.signup = null
      }
      if (type === 'run:end' && payload.status === 'done' && session.runUrls && session.runUrls.length) {
        session.runUrls.slice(-2).forEach(function (u) { irisLearn(u, 'A direct URL that worked before (change the search words): ' + u.slice(0, 200)) })
        session.runUrls = []
      }
      if (type === 'learn') irisLearn(payload.url, payload.tip)
      if (type === 'ask') irisNotify('Iris needs you', payload.question)
      if (type === 'ask') computer.lastQuestion = payload.question
      if (type === 'questions') irisNotify('Iris has a few questions', 'Answer them in the Iris panel so it can plan "' + session.title + '".')
      if (type === 'blocked' && payload.kind === 'confirmation') irisNotify('Iris is waiting for your OK', payload.reason)
      // a non-stop run picks itself up after a failure: only tell the user when it really ends
      if (type === 'run:end' && payload.status !== 'stopped' && !(unlimited && payload.status === 'failed')) irisNotify(payload.status === 'done' ? 'Iris finished' : 'Iris could not finish', (payload.status === 'done' ? payload.answer : payload.reason) || session.title)
      if (type === 'thought' && payload.usage) irisUsageRecord('request', Object.assign({ ms: payload.modelMs }, payload.usage))
      if (type === 'thought' && payload.usage) {
        DBUG('usage step ' + payload.step + ' prompt=' + payload.usage.prompt_tokens + ' cached=' + ((payload.usage.prompt_tokens_details && payload.usage.prompt_tokens_details.cached_tokens) || 0) + ' completion=' + payload.usage.completion_tokens + ' ms=' + payload.modelMs)
      }
      if (type !== 'model:progress') DBUG('event ' + type + ' ' + JSON.stringify(payload && (payload.status || payload.description || payload.error || payload.thought || '') || ''))
      if (type === 'rejected') DBUG('rejected raw: ' + String(payload.raw || '').slice(0, 2500))
      irisRecord(session, type, payload)
      if (type === 'run:end') {
        irisAgentState.status = payload.status
        irisAgentState.answer = payload.answer
        irisAgentState.reason = payload.reason
        irisAgentState.steps = payload.steps
        hideOverlay()
        computer.unwatch()
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

  const project = irisProject(session.projectId)
  const smart = options.plan ? (options.plan === 'deep' ? 'deep' : 'quick') : false
  agent.run(task, { followUp: !!previousHistory, plan: smart, projectPlan: project && project.plan }).then(function (result) {
    irisAgentState.status = result.status
    irisAgentState.answer = result.answer
    irisAgentState.reason = result.reason
    if (mode === 'repeat' && result.status !== 'stopped') irisScheduleRepeat(task, options)
    // "keep going until I stop you": a non-stop run that thinks it is finished looks for more
    const original = session.items.find(function (it) { return it.kind === 'user' }) || { text: task }
    if (mode === 'continuous' && result.status === 'done' && irisPrompts.isOpenEnded(original.text) && (session.autoResumes || 0) < 200) {
      session.autoResumes = (session.autoResumes || 0) + 1
      broadcastEvent({ type: 'repeat:scheduled', at: Date.now() + 20000, minutes: 1 / 3, sessionId: session.id, resume: true })
      irisRepeatTimer = setTimeout(function () {
        irisRepeatTimer = null
        const tabId = irisComputer ? irisComputer.tabId : options.tabId
        const again = startAgent('Keep going (you were asked to continue until stopped): find more that you have not covered yet, ' +
          'and skip everything you already judged or downloaded. The task: ' + original.text, Object.assign({}, options, { tabId: tabId, sessionId: session.id, plan: false }))
        if (!again.ok) DBUG('continue failed: ' + again.error)
      }, 20000)
      return
    }
    // a non-stop run that hit trouble overnight picks itself back up (only Stop ends it)
    if (mode === 'continuous' && result.status === 'failed' && (session.autoResumes || 0) < 50) {
      session.autoResumes = (session.autoResumes || 0) + 1
      broadcastEvent({ type: 'repeat:scheduled', at: Date.now() + 60000, minutes: 1, sessionId: session.id, resume: true })
      irisRepeatTimer = setTimeout(function () {
        irisRepeatTimer = null
        const tabId = irisComputer ? irisComputer.tabId : options.tabId
        const again = startAgent('Something went wrong (' + String(result.reason || '').slice(0, 160) + '). Continue the task from where you left off: ' + task,
          Object.assign({}, options, { tabId: tabId, sessionId: session.id }))
        if (!again.ok) DBUG('auto-resume failed: ' + again.error)
      }, 60000)
    }
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

ipc.on('iris-agent-answer', function (event, text) {
  // in a job run, an answer to a form question is kept for the next forms (Settings → Jobs → Answers)
  if (irisComputer && irisComputer.jobsMode && irisComputer.lastQuestion && text && irisIsBusy()) {
    try { irisJobsLearnAnswer(irisComputer.lastQuestion, String(text)) } catch (e) { DBUG('learn answer: ' + e.message) }
    irisComputer.lastQuestion = null
  }
  if (irisAgent && irisIsBusy()) irisAgent.answer(text)
  if (irisSession && text) {
    irisSession.items.push({ kind: 'user', text: text, run: irisSession.run, answer: true })
    irisSessionSave(irisSession)
  }
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

ipc.on('iris-agent-view-state', function (e, data) {
  DBUG('page view still hidden by: ' + ((data && data.placeholders) || []).join(', '))
})

ipc.on('iris-overlay-sync', function () {
  if (irisComputer && irisIsBusy()) showOverlay(irisComputer.tabId, irisComputer.fallbackBounds)
})

ipc.on('iris-agent-settings-changed', function () {
  broadcast('iris-agent-settings', irisSettings())
})

/* Settings page actions that need the main process */
/* The newest files in the download folder, for Settings → Downloads. */
function irisRecentDownloads (limit) {
  const dir = irisDownloadDir()
  let names = []
  try { names = fs.readdirSync(dir) } catch (e) { return [] }
  return names.filter(function (n) { return n[0] !== '.' }).map(function (n) {
    try {
      const st = fs.statSync(path.join(dir, n))
      return st.isFile() ? { name: n, bytes: st.size, at: st.mtimeMs } : null
    } catch (e) { return null }
  }).filter(Boolean).sort(function (a, b) { return b.at - a.at }).slice(0, limit || 40)
}

/* Cookies grouped by site, most first, for Settings → Cookies & site data. */
async function irisCookieSites () {
  const all = await session.fromPartition('persist:webcontent').cookies.get({})
  const by = {}
  all.forEach(function (c) {
    const d = c.domain.replace(/^\./, '').toLowerCase().replace(/^www\./, '')
    by[d] = (by[d] || 0) + 1
  })
  return Object.keys(by).map(function (d) { return { domain: d, count: by[d] } }).sort(function (a, b) { return b.count - a.count || a.domain.localeCompare(b.domain) })
}

ipc.on('iris-settings-action', async function (event, data) {
  const reply = function (result) { event.reply('iris-settings-action-reply', { tabId: data.tabId, action: data.action, result: result }) }
  try {
    switch (data.action) {
      case 'defaultStatus':
        return reply({ isDefault: app.isDefaultProtocolClient('https') })
      case 'makeDefault':
        app.setAsDefaultProtocolClient('http')
        app.setAsDefaultProtocolClient('https')
        return reply({ isDefault: app.isDefaultProtocolClient('https') })
      case 'downloadDir':
        return reply({ dir: settings.get('irisDownloadDir') || app.getPath('downloads') })
      case 'chooseDownloadDir': {
        const pick = await dialog.showOpenDialog(windows.getCurrent(), { properties: ['openDirectory', 'createDirectory'], defaultPath: settings.get('irisDownloadDir') || app.getPath('downloads') })
        if (!pick.canceled && pick.filePaths[0]) settings.set('irisDownloadDir', pick.filePaths[0])
        return reply({ dir: settings.get('irisDownloadDir') || app.getPath('downloads') })
      }
      case 'cookiesList':
        return reply({ sites: await irisCookieSites() })
      case 'bridgeInfo':
        return reply(irisBridgeInfo())
      case 'downloadsList':
        return reply({ dir: irisDownloadDir(), files: irisRecentDownloads(40) })
      case 'downloadShow': {
        // only files inside the download folder, and only revealed in Finder (never opened)
        const dir = irisDownloadDir()
        const target = path.join(dir, path.basename(String((data.args && data.args.name) || '')))
        if (fs.existsSync(target)) shell.showItemInFolder(target)
        return reply({ dir: dir, files: irisRecentDownloads(40) })
      }
      case 'cookiesRemove': {
        const ses = session.fromPartition('persist:webcontent')
        const domain = String((data.args && data.args.domain) || '').toLowerCase()
        const all = await ses.cookies.get({})
        await Promise.all(all.filter(function (c) { return c.domain.replace(/^\./, '').toLowerCase().replace(/^www\./, '') === domain }).map(function (c) {
          const url = (c.secure ? 'https://' : 'http://') + c.domain.replace(/^\./, '') + (c.path || '/')
          return ses.cookies.remove(url, c.name).catch(function () {})
        }))
        return reply({ sites: await irisCookieSites() })
      }
      case 'clearData': {
        const ses = session.fromPartition('persist:webcontent')
        if (data.args && data.args.cookies) await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'websql'] })
        if (data.args && data.args.cache) await ses.clearCache()
        return reply({ ok: true })
      }
      default: {
        const jobs = irisJobsSettingsAction(data.action, data.args)
        if (jobs) return reply(await jobs)
        return reply({ error: 'unknown action' })
      }
    }
  } catch (err) {
    reply({ error: err.message })
  }
})

ipc.on('iris-accounts-get', function (event, data) {
  event.reply('iris-accounts-data', { tabId: data && data.tabId, accounts: irisAccountsForPage() })
})

ipc.on('iris-account-reveal', function (event, data) {
  event.reply('iris-accounts-data', { tabId: data && data.tabId, accounts: irisAccountsForPage(), revealed: { site: data.site, username: data.username, password: irisAccountPassword(data.site, data.username) } })
})

ipc.on('iris-account-delete', function (event, data) {
  const list = irisAccountsLoad().filter(function (a) { return !(a.site === data.site && a.username === data.username) })
  try { fs.writeFileSync(irisAccountsPath(), JSON.stringify({ accounts: list }, null, 1), { mode: 0o600 }) } catch (e) { /* ignore */ }
  event.reply('iris-accounts-data', { tabId: data && data.tabId, accounts: irisAccountsForPage() })
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
 * Downloads while Iris works: straight to ~/Downloads, no save dialog
 * (a native dialog is invisible to a screenshot-driven agent)
 * ------------------------------------------------------------------ */

/* Normal browsing: like Chrome, save straight to the downloads folder unless the user asks to choose. */
function irisDownloadDir () {
  return settings.get('irisDownloadDir') || app.getPath('downloads')
}

/* The same file is already in the download folder (same name, same size): no need for a copy. */
function irisAlreadyInFolder (item) {
  try {
    const name = (item.getFilename() || '').replace(/[/\\:]/g, '_')
    if (!name) return null
    const existing = path.join(irisDownloadDir(), name)
    if (!fs.existsSync(existing)) return null
    const total = item.getTotalBytes()
    return total > 0 && fs.statSync(existing).size === total ? existing : null
  } catch (e) {
    return null
  }
}

function irisSaveDownload (item) {
  const dir = irisDownloadDir()
  const name = (item.getFilename() || 'download').replace(/[/\\:]/g, '_')
  const ext = path.extname(name)
  const base = path.basename(name, ext)
  let target = path.join(dir, name)
  for (let i = 1; fs.existsSync(target) && i < 500; i++) target = path.join(dir, base + ' (' + i + ')' + ext)
  item.setSavePath(target)
}

function irisOnDownload (event, item) {
  if (!irisIsBusy() || !irisComputer) {
    if (settings.get('irisDownloadAsk') !== true) {
      try { irisSaveDownload(item) } catch (e) { DBUG('download path: ' + e.message) }
    }
    return
  }
  const computer = irisComputer
  // already have it? Checked by code (paper IDs, DOIs, cleaned-up URLs), so the model never has to
  const earlier = irisDownloads().findDownload(item.getURL(), item.getFilename())
  if (earlier && earlier.path && fs.existsSync(earlier.path)) {
    event.preventDefault()
    computer.notes = (computer.notes || []).concat('Skipped a download: "' + item.getFilename() + '" is already in Downloads as "' + path.basename(earlier.path) +
      '" (from ' + new Date(earlier.at).toLocaleDateString() + '). Move on to the next one.')
    broadcastEvent({ type: 'download', state: 'skipped', name: item.getFilename(), existing: path.basename(earlier.path) })
    return
  }
  const same = irisAlreadyInFolder(item)
  if (same) {
    event.preventDefault()
    computer.notes = (computer.notes || []).concat('Skipped a download: "' + path.basename(same) + '" is already in the Downloads folder (same file). Move on to the next one.')
    broadcastEvent({ type: 'download', state: 'skipped', name: item.getFilename(), existing: path.basename(same) })
    irisDownloads().add('download', 'Already had ' + path.basename(same), { name: path.basename(same), url: item.getURL(), path: same, bytes: item.getTotalBytes() })
    irisDownloadsSave()
    return
  }
  try {
    const dir = irisDownloadDir()
    const name = (item.getFilename() || 'download').replace(/[/\\:]/g, '_')
    const ext = path.extname(name)
    const base = path.basename(name, ext)
    let target = path.join(dir, name)
    for (let i = 1; fs.existsSync(target) && i < 500; i++) target = path.join(dir, base + ' (' + i + ')' + ext)
    item.setSavePath(target)
  } catch (e) {
    DBUG('download path failed: ' + e.message)
  }
  broadcastEvent({ type: 'download', state: 'started', name: item.getFilename() })
  computer.downloadsPending = (computer.downloadsPending || 0) + 1
  const sourceUrl = item.getURL()
  item.once('done', function (e, state) {
    computer.downloadsPending = Math.max(0, (computer.downloadsPending || 0) - 1)
    const rec = { name: path.basename(item.getSavePath() || item.getFilename()), state: state, bytes: item.getReceivedBytes(), path: item.getSavePath() }
    if (state === 'completed') {
      const entry = { name: rec.name, url: sourceUrl, path: rec.path, bytes: rec.bytes, session: irisSession && irisSession.id }
      irisDownloads().add('download', 'Downloaded ' + rec.name, entry)
      irisDownloadsSave()
      if (computer.memory) computer.memory.add('download', 'Downloaded ' + rec.name, entry)
      if (computer.projectId) irisProjectMemoryAdd(computer.projectId, 'download', 'Downloaded ' + rec.name, entry)
    }
    computer.downloads = (computer.downloads || []).concat(rec)
    DBUG('download ' + state + ': ' + rec.path)
    broadcastEvent(Object.assign({ type: 'download' }, rec))
    if (irisSession && state === 'completed') {
      irisSession.items.push({ kind: 'note', text: 'Downloaded ' + rec.name + ' (' + irisFormatBytes(rec.bytes) + ')' })
      irisSessionSave(irisSession)
    }
  })
}

app.whenReady().then(function () {
  session.defaultSession.on('will-download', irisOnDownload)
})
app.on('session-created', function (ses) {
  ses.on('will-download', irisOnDownload)
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
