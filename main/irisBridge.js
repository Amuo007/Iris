/*
 * main/irisBridge.js — let a coding agent use Iris's eyes and hands, without Iris's own model.
 *
 * A developer's coding agent (Claude Code, OpenCode, Codex, …) can attach bin/iris-mcp.js as an
 * MCP server and then see the page it is building and click, type and scroll in it, exactly the
 * way Iris does: screenshots in, real mouse and keyboard events out. No model runs in Iris; the
 * coding agent is the brain.
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

async function irisBridgeHandle (tool, args) {
  if (irisIsBusy()) throw new Error('Iris is running a task of its own; try again when it has finished')
  irisBridgeLastUse = Date.now()
  broadcast('iris-bridge-activity', { tool: tool, at: irisBridgeLastUse })
  switch (tool) {
    case 'screenshot':
      return irisBridgeScreenshot()
    case 'tabs':
      return { tabs: irisTabList().map(function (t, i) { return { tab: i + 1, title: t.title, url: t.url, current: t.active } }) }
    case 'act':
      return irisBridgeAct(args || {})
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
  return { enabled: irisBridgeEnabled(), running: !!irisBridgeServer, port: creds.port, script: irisBridgeScriptPath(), lastUse: irisBridgeLastUse }
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
  irisBridgeServer.on('error', function (err) {
    DBUG('bridge: ' + err.message)
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
