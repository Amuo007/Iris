/*
 * main/irisBridge.js — let a coding agent use Iris's eyes and hands, without Iris's own model.
 *
 * A developer's coding agent (Claude Code, OpenCode, Codex, …) can attach bin/iris-mcp.js as an
 * MCP server and then use Iris's tools: see the page and click, type and scroll in it exactly the
 * way Iris does (screenshots in, real mouse and keyboard events out), look things up, use
 * bookmarks, My info (secrets stay placeholders), saved accounts, downloads, and the Jobs tools.
 * No model runs in Iris; the coding agent is the brain.
 *
 * Guarded like a developer tool:
 *   • off until the user turns it on in Settings → Iris AI → Coding agents
 *   • listens on 127.0.0.1 only, and every request needs the secret token from
 *     <userData>/iris-bridge.json (readable by the user only). Web pages cannot reach it: no
 *     CORS headers are ever sent, so a browser refuses to send the Authorization header
 *   • it never runs scripts in pages, same as Iris; it works through the screen
 *   • while Iris's own agent is running, the bridge waits its turn (busy error)
 *
 * Concatenated into main.build.js after irisAgent.js (shared scope: IrisComputer, irisMapper,
 * irisActionSchema, irisTabList, irisTabCommand, irisResolveUrl, irisIsBusy, broadcast, settings).
 */

const irisHttp = require('http')
const irisCrypto = require('crypto')

const IRIS_BRIDGE_PORT = 47821

var irisBridgeServer = null
var irisBridgeComputer = null
var irisBridgeLastUse = 0
var irisBridgeError = ''

function irisBridgeFile () {
  return path.join(userDataPath, 'iris-bridge.json')
}

/* The token lives in a user-only file; the MCP script reads it from there. */
function irisBridgeCredentials () {
  let data = null
  try { data = JSON.parse(fs.readFileSync(irisBridgeFile(), 'utf8')) } catch (e) { /* first start */ }
  if (!data || !data.token) {
    data = { port: IRIS_BRIDGE_PORT, token: irisCrypto.randomBytes(24).toString('hex') }
    fs.writeFileSync(irisBridgeFile(), JSON.stringify(data), { mode: 0o600 })
  }
  return data
}

function irisBridgeEnabled () {
  return settings.get('irisBridge') === true
}

/* The tab the user is looking at, as an Iris "computer". */
function irisBridgeTarget () {
  const tabId = irisTabs.selected
  if (!tabId || !getView(tabId)) throw new Error('no tab is open in Iris')
  if (!irisBridgeComputer || !getView(irisBridgeComputer.tabId)) {
    irisBridgeComputer = new IrisComputer(tabId, irisSettings(), {}, null)
  }
  irisBridgeComputer.currentTabId() // follow the selected tab
  return irisBridgeComputer
}

/* Last screenshot geometry: tool coordinates are pixels in the image the agent was given. */
var irisBridgeShot = null

async function irisBridgeScreenshot () {
  const computer = irisBridgeTarget()
  const obs = await computer.screenshot()
  irisBridgeShot = obs
  const m = /^data:image\/(\w+);base64,(.*)$/.exec(obs.dataUrl || '')
  return {
    image: m ? m[2] : '',
    mimeType: m ? 'image/' + m[1] : 'image/jpeg',
    width: obs.width,
    height: obs.height,
    url: obs.url || '',
    title: obs.title || '',
    loading: !!obs.loading,
    note: obs.note || '',
    tabs: irisTabList().map(function (t, i) { return { tab: i + 1, title: t.title, url: t.url, current: t.active } })
  }
}

async function irisBridgeAct (raw) {
  const computer = irisBridgeTarget()
  if (!irisBridgeShot) await irisBridgeScreenshot()
  const shot = irisBridgeShot
  const parsed = irisActionSchema.validateAction(raw, { imageWidth: shot.width, imageHeight: shot.height })
  if (!parsed.ok) throw new Error(parsed.error)
  const action = parsed.action
  const allowed = ['click', 'double_click', 'right_click', 'move', 'drag', 'scroll', 'type', 'key', 'shortcut', 'wait', 'navigate', 'back', 'switch_tab', 'new_tab', 'close_tab', 'find', 'dialog', 'upload']
  if (allowed.indexOf(action.type) === -1) throw new Error(action.type + ' is not available to coding agents')
  const mapping = irisMapper.createMapping({
    imageWidth: shot.width,
    imageHeight: shot.height,
    viewWidth: shot.viewWidth,
    viewHeight: shot.viewHeight,
    devicePixelRatio: shot.devicePixelRatio
  })
  const mapped = irisMapper.mapActionToView(action, mapping, { coordinateSpace: 'auto' })
  if (raw.what) mapped.intent = String(raw.what).slice(0, 200)
  // the same pointer the user sees when Iris acts, so it is obvious something is driving the page
  const anchor = irisMapper.actionAnchorCss(action, mapping)
  if (anchor && irisSettings().markerEnabled) {
    showOverlay(computer.tabId, computer.fallbackBounds)
    overlaySend({ action: action, anchor: anchor, description: 'Coding agent: ' + irisActionSchema.describeAction(action) })
  }
  const result = await computer.act(mapped)
  if (!result || !result.ok) throw new Error((result && result.error) || 'the page rejected the input')
  await computer.settle(mapped)
  irisBridgeShot = null // the page may have changed: the next action needs a fresh look
  const notes = (computer.notes || []).splice(0)
  return { ok: true, did: irisActionSchema.describeAction(action), notes: notes }
}

/* A close-up of part of the latest screenshot (to read small text); clicks still use full-screenshot pixels. */
async function irisBridgeZoom (args) {
  const computer = irisBridgeTarget()
  if (!irisBridgeShot) await irisBridgeScreenshot()
  const shot = irisBridgeShot
  const sx = shot.viewWidth / shot.width
  const sy = shot.viewHeight / shot.height
  computer.pendingZoom = { x: Math.round(Number(args.x) * sx), y: Math.round(Number(args.y) * sy) }
  const obs = await computer.screenshot()
  const m = /^data:image\/(\w+);base64,(.*)$/.exec(obs.dataUrl || '')
  return { image: m ? m[2] : '', mimeType: m ? 'image/' + m[1] : 'image/jpeg', width: obs.width, height: obs.height, url: obs.url || '', title: obs.title || '', note: 'Close-up only: use pixels of the full screenshot for clicks.' }
}

/* Tools that only read Iris's own data may run while Iris works; the page is Iris's then. */
const IRIS_BRIDGE_READ_ONLY = ['tabs', 'lookup', 'bookmarks', 'my_info', 'accounts', 'downloads', 'career', 'applications', 'agent_status', 'agent_stop', 'agent_answer']

/* Iris's own run, for a coding agent that hands Iris a task and checks on it: state, newest steps, this chat's applications. */
function irisBridgeAgentStatus (last) {
  const s = irisSession
  const steps = s ? s.items.filter(function (i) { return i.kind === 'step' }) : []
  return {
    status: irisAgentState.status,
    running: irisIsBusy(),
    mode: irisAgentState.mode || null,
    sessionId: irisAgentState.sessionId || (s && s.id) || null,
    startedAt: irisAgentState.startedAt || null,
    steps: irisAgentState.steps,
    reason: irisAgentState.reason,
    answer: irisAgentState.answer,
    task: String(irisAgentState.task || '').slice(0, 300),
    last: steps.slice(-Math.max(1, Math.min(30, Number(last) || 5))).map(function (i) {
      return { run: i.run, step: i.step, url: i.url || '', thought: i.thought || '', actions: (i.actions || []).map(function (a) { return a.description || a.type }) }
    }),
    applications: s ? irisApplicationsLoad().filter(function (a) { return a.sessionId === s.id }).map(function (a) {
      return { status: a.status, company: a.company, title: a.title, url: a.url, note: a.note, at: a.updated || a.at }
    }) : []
  }
}

async function irisBridgeHandle (tool, args) {
  args = args || {}
  if (irisIsBusy() && IRIS_BRIDGE_READ_ONLY.indexOf(tool) === -1) throw new Error('Iris is running a task of its own; try again when it has finished')
  irisBridgeLastUse = Date.now()
  broadcast('iris-bridge-activity', { tool: tool, at: irisBridgeLastUse })
  switch (tool) {
    case 'screenshot':
      return irisBridgeScreenshot()
    case 'zoom':
      return irisBridgeZoom(args)
    case 'tabs':
      return { tabs: irisTabList().map(function (t, i) { return { tab: i + 1, title: t.title, url: t.url, current: t.active } }) }
    case 'act':
      return irisBridgeAct(args)
    // quick look-ups outside the browser (no cookies, never LinkedIn & co.)
    case 'lookup': {
      const r = await irisLookup().lookup({ kind: args.kind || 'web', query: String(args.query || '') })
      irisUsageRecord('lookup')
      return { ok: r.ok, text: r.text, count: r.count }
    }
    case 'bookmarks': {
      const found = await irisAskBookmarks(String(args.query || ''))
      return { bookmarks: found.bookmarks, total: found.total }
    }
    case 'bookmark': {
      if (!args.url) throw new Error('url is required')
      broadcast('iris-agent-bookmark', { url: irisResolveUrl(args.url), title: args.title || args.url, remove: !!args.remove })
      return { ok: true }
    }
    // the user's details: plain values, secrets only as placeholders that iris_type fills in
    case 'my_info':
      return { fields: irisProfileForPrompt().map(function (f) { return f.secret ? { label: f.label, placeholder: '{{' + f.label + '}}' } : { label: f.label, value: f.value } }) }
    case 'accounts':
      return { accounts: irisAccountsForPage().map(function (a) { return { site: a.site, username: a.username, url: a.url, purpose: a.purpose, password: '{{account:' + a.site + '}}' } }) }
    case 'save_account':
      if (!args.site || !args.username) throw new Error('site and username are required')
      irisAccountSave({ site: args.site, username: args.username, password: args.password || '', url: args.url || '', title: args.title || '', purpose: args.purpose || 'made by a coding agent' })
      return { ok: true }
    case 'downloads':
      return { folder: irisDownloadDir(), files: irisRecentDownloads(30) }
    // Jobs: the career profile with IDs, a resume built from picks (no model), the applications log
    case 'career':
      return { profile: irisCareerLib.bankText(irisCareerLoad()), prefs: irisCareerLoad().prefs, answers: irisCareerLoad().answers.filter(function (a) { return a.value }) }
    case 'resume': {
      const job = { title: String(args.title || 'Job'), company: String(args.company || ''), requirements: String(args.requirements || '') }
      const r = await irisTailorResume(job, { picks: args.picks || null, noModel: true })
      if (r.ok) irisBridgeTarget().lastResume = r.file
      return r.ok ? { ok: true, file: r.file, pages: r.pages, fill: r.fill, undone: r.undone } : { ok: false, error: r.error }
    }
    case 'cover_letter': {
      if (!args.text) throw new Error('text is required: three short paragraphs, from the career profile only')
      const r = await irisWriteCoverLetter({ title: String(args.title || 'Job'), company: String(args.company || '') }, String(args.text))
      if (r.ok) irisBridgeTarget().lastCover = r.file
      return r.ok ? { ok: true, file: r.file, words: r.words, removed: r.removed } : { ok: false, error: r.error }
    }
    case 'applications':
      return { items: irisApplicationsLoad().slice(-100), today: irisAppliedToday() }
    // Iris's own agent: start a task in a new tab and chat (like Settings → Jobs → Start), check on it, stop it
    case 'agent_run': {
      const task = String(args.task || '').trim()
      if (!task) throw new Error('task is required')
      const mode = args.mode === 'continuous' ? 'continuous' : 'once'
      // plan: 'quick' | 'deep' runs it with Smart on (a run restarted the way the user started it)
      const plan = args.plan === 'quick' || args.plan === 'deep' ? args.plan : undefined
      broadcast('iris-agent-scheduled-run', { task: task, mode: mode, plan: plan })
      const started = Date.now()
      while (!irisIsBusy() && Date.now() - started < 10000) await sleep(200)
      if (!irisIsBusy()) throw new Error('Iris did not start (is the browser window open?)')
      return irisBridgeAgentStatus(1)
    }
    case 'agent_status':
      return irisBridgeAgentStatus(args.last)
    case 'agent_answer': {
      // Iris asked something and waits (the panel shows the question): the same as the user typing the answer
      if (!irisIsBusy() || irisAgentState.status !== 'paused') throw new Error('Iris is not waiting for an answer')
      const text = String(args.text || '').trim()
      if (!text) throw new Error('text is required')
      if (irisComputer && irisComputer.jobsMode && irisComputer.lastQuestion) {
        try { irisJobsLearnAnswer(irisComputer.lastQuestion, text) } catch (e) { DBUG('learn answer: ' + e.message) }
        irisComputer.lastQuestion = null
      }
      irisAgent.answer(text)
      if (irisSession) {
        irisSession.items.push({ kind: 'user', text: text, run: irisSession.run, answer: true })
        irisSessionSave(irisSession)
      }
      broadcast('iris-agent-event', { type: 'answered', text: text })
      return irisBridgeAgentStatus(1)
    }
    case 'agent_stop':
      irisCancelRepeat()
      if (irisAgent && irisIsBusy()) irisAgent.stop(String(args.reason || 'Stopped by a coding agent'))
      return irisBridgeAgentStatus(1)
    case 'log_application': {
      if (['applied', 'skipped', 'needs_you', 'failed'].indexOf(args.status) === -1) throw new Error('status must be applied, skipped, needs_you or failed')
      const item = irisApplicationAdd({ status: args.status, company: args.company || '', title: args.title || '', url: args.url || '', note: args.note || '', resume: (irisBridgeComputer && irisBridgeComputer.lastResume) || '' })
      return { ok: true, item: item }
    }
    default:
      throw new Error('unknown tool: ' + tool)
  }
}

/* The MCP script, copied next to the token so `node <path>` works from a packaged app too. */
function irisBridgeScriptPath () {
  const target = path.join(userDataPath, 'iris-mcp.js')
  try {
    const src = fs.readFileSync(path.join(__dirname, 'bin', 'iris-mcp.js'), 'utf8')
    let old = ''
    try { old = fs.readFileSync(target, 'utf8') } catch (e) { /* not copied yet */ }
    if (old !== src) fs.writeFileSync(target, src, { mode: 0o700 })
  } catch (e) { DBUG('bridge script copy: ' + e.message) }
  return target
}

function irisBridgeInfo () {
  const creds = irisBridgeCredentials()
  return { enabled: irisBridgeEnabled(), running: !!irisBridgeServer && !irisBridgeError, error: irisBridgeError, port: creds.port, script: irisBridgeScriptPath(), lastUse: irisBridgeLastUse }
}

function irisBridgeStart () {
  if (irisBridgeServer) return
  const creds = irisBridgeCredentials()
  irisBridgeScriptPath()
  irisBridgeServer = irisHttp.createServer(function (req, res) {
    const send = function (code, body) {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    if (req.method !== 'POST') return send(405, { error: 'POST only' })
    if (req.headers.authorization !== 'Bearer ' + creds.token) return send(401, { error: 'bad token' })
    const m = /^\/v1\/([a-z_]+)$/.exec(req.url || '')
    if (!m) return send(404, { error: 'not found' })
    let body = ''
    req.on('data', function (c) { body += c; if (body.length > 1e6) req.destroy() })
    req.on('end', function () {
      let args = {}
      try { args = body ? JSON.parse(body) : {} } catch (e) { return send(400, { error: 'bad JSON' }) }
      irisBridgeHandle(m[1], args).then(function (out) { send(200, out) }, function (err) { send(200, { error: err.message }) })
    })
  })
  irisBridgeError = ''
  irisBridgeServer.on('error', function (err) {
    DBUG('bridge: ' + err.message)
    irisBridgeError = err.code === 'EADDRINUSE'
      ? 'Port ' + (creds.port || IRIS_BRIDGE_PORT) + ' is already in use, probably by another copy of Iris. Quit it and turn this off and on again.'
      : err.message
    irisBridgeServer = null
  })
  irisBridgeServer.listen(creds.port || IRIS_BRIDGE_PORT, '127.0.0.1')
}

function irisBridgeStop () {
  if (!irisBridgeServer) return
  try { irisBridgeServer.close() } catch (e) { /* already closed */ }
  irisBridgeServer = null
  irisBridgeComputer = null
}

settings.listen('irisBridge', function () {
  if (irisBridgeEnabled()) irisBridgeStart()
  else irisBridgeStop()
})
