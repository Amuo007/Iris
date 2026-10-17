#!/usr/bin/env node
'use strict'

/*
 * bin/iris-mcp.js — Iris as an MCP server for coding agents (stdio, no dependencies).
 *
 * Add it to your coding agent's MCP config, e.g.
 *   { "mcpServers": { "iris": { "command": "node", "args": ["/path/to/Iris/bin/iris-mcp.js"] } } }
 * then turn on Settings → Iris AI → Coding agents in Iris.
 *
 * Your agent sees the page in Iris as a screenshot and uses the mouse and keyboard there, like a
 * person, and can use Iris's other tools: look-ups, bookmarks, My info (secrets stay placeholders),
 * saved accounts, downloads and the Jobs tools (career profile, one-page resumes, applications log).
 * Iris's own model does not run. x/y are pixels in the latest screenshot.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

const DATA_DIRS = [
  process.env.IRIS_USER_DATA,
  path.join(os.homedir(), 'Library', 'Application Support', 'Iris'),
  path.join(os.homedir(), 'Library', 'Application Support', 'Iris-development'),
  path.join(os.homedir(), '.config', 'Iris'),
  path.join(process.env.APPDATA || '', 'Iris')
].filter(Boolean)

function credentials () {
  for (const d of DATA_DIRS) {
    try { return JSON.parse(fs.readFileSync(path.join(d, 'iris-bridge.json'), 'utf8')) } catch (e) { /* next */ }
  }
  throw new Error('Iris is not set up for coding agents yet: open Iris → Settings → Iris AI → Coding agents and turn it on.')
}

function call (tool, args) {
  const c = credentials()
  const body = JSON.stringify(args || {})
  return new Promise(function (resolve, reject) {
    const req = http.request({ host: '127.0.0.1', port: c.port, path: '/v1/' + tool, method: 'POST', headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, function (res) {
      let data = ''
      res.on('data', function (d) { data += d })
      res.on('end', function () {
        try {
          const j = JSON.parse(data)
          if (j.error) reject(new Error(j.error))
          else resolve(j)
        } catch (e) { reject(new Error('Iris answered ' + res.statusCode)) }
      })
    })
    req.on('error', function () { reject(new Error('Iris is not running, or Coding agents is turned off in its settings.')) })
    req.end(body)
  })
}

const XY = { x: { type: 'integer', description: 'pixels from the left of the latest screenshot' }, y: { type: 'integer', description: 'pixels from the top of the latest screenshot' } }
const LOOK = { look: { type: 'boolean', description: 'return a fresh screenshot after acting (default true)' } }

const TOOLS = [
  { name: 'iris_screenshot', description: 'See the current tab in Iris: a screenshot plus its URL, title and the open tabs. Coordinates for the other tools are pixels in this image.', inputSchema: { type: 'object', properties: {} } },
  { name: 'iris_click', description: 'Click at a point in the latest screenshot. A click just beside a link, button or field moves onto it (not for checkboxes, radios or dropdowns: say what you click in "what").', inputSchema: { type: 'object', properties: Object.assign({}, XY, { button: { type: 'string', enum: ['left', 'right', 'middle'] }, double: { type: 'boolean' }, what: { type: 'string', description: 'what you are clicking, e.g. "the Save button" or "the terms checkbox"' } }, LOOK), required: ['x', 'y'] } },
  { name: 'iris_type', description: 'Type text. With x/y it clicks that field first and replaces its text (clear:false adds to it). enter:true presses Enter after.', inputSchema: { type: 'object', properties: Object.assign({ text: { type: 'string' }, enter: { type: 'boolean' }, clear: { type: 'boolean' } }, XY, LOOK), required: ['text'] } },
  { name: 'iris_key', description: 'Press a key, optionally with modifiers (command, control, option, shift). Keys: enter, tab, escape, backspace, delete, up, down, left, right, pageup, pagedown, home, end, a-z, 0-9, f1-f12.', inputSchema: { type: 'object', properties: Object.assign({ key: { type: 'string' }, modifiers: { type: 'array', items: { type: 'string' } } }, LOOK), required: ['key'] } },
  { name: 'iris_scroll', description: 'Scroll the page (amount = wheel notches; about 6 is one screen). x/y says where.', inputSchema: { type: 'object', properties: Object.assign({ direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'integer' } }, XY, LOOK), required: ['direction'] } },
  { name: 'iris_hover', description: 'Move the mouse to a point (hover menus, tooltips).', inputSchema: { type: 'object', properties: Object.assign({}, XY, LOOK), required: ['x', 'y'] } },
  { name: 'iris_drag', description: 'Drag from one point to another (sliders, drag and drop).', inputSchema: { type: 'object', properties: Object.assign({ fromX: { type: 'integer' }, fromY: { type: 'integer' }, toX: { type: 'integer' }, toY: { type: 'integer' } }, LOOK), required: ['fromX', 'fromY', 'toX', 'toY'] } },
  { name: 'iris_navigate', description: 'Open a URL in the current tab (e.g. http://localhost:3000), or plain words to search.', inputSchema: { type: 'object', properties: Object.assign({ url: { type: 'string' } }, LOOK), required: ['url'] } },
  { name: 'iris_back', description: 'Browser Back.', inputSchema: { type: 'object', properties: Object.assign({}, LOOK) } },
  { name: 'iris_tabs', description: 'List the open tabs.', inputSchema: { type: 'object', properties: {} } },
  { name: 'iris_new_tab', description: 'Open a new tab (optionally at a URL) and switch to it.', inputSchema: { type: 'object', properties: Object.assign({ url: { type: 'string' } }, LOOK) } },
  { name: 'iris_switch_tab', description: 'Switch to tab N from iris_tabs.', inputSchema: { type: 'object', properties: Object.assign({ tab: { type: 'integer' } }, LOOK), required: ['tab'] } },
  { name: 'iris_close_tab', description: 'Close tab N (default: the current one).', inputSchema: { type: 'object', properties: Object.assign({ tab: { type: 'integer' } }, LOOK) } },
  { name: 'iris_find', description: 'Find text on the page like Cmd+F; it scrolls to and highlights the match.', inputSchema: { type: 'object', properties: Object.assign({ text: { type: 'string' } }, LOOK), required: ['text'] } },
  { name: 'iris_wait', description: 'Wait while the page is loading or animating.', inputSchema: { type: 'object', properties: Object.assign({ ms: { type: 'integer' } }, LOOK) } },
  { name: 'iris_zoom', description: 'A 2x close-up around a point of the latest screenshot, to read small text. Keep using full-screenshot pixels for clicks.', inputSchema: { type: 'object', properties: XY, required: ['x', 'y'] } },
  { name: 'iris_dialog', description: 'Answer a browser alert/confirm/prompt that Iris reports (accept true = OK).', inputSchema: { type: 'object', properties: Object.assign({ accept: { type: 'boolean' }, text: { type: 'string' } }, LOOK), required: ['accept'] } },
  { name: 'iris_upload', description: 'Choose a file in an open file picker (click the page\'s upload button first). A name from Downloads/Desktop/Documents, a full path, or "resume" for the last PDF made with iris_resume.', inputSchema: { type: 'object', properties: Object.assign({ file: { type: 'string' } }, LOOK), required: ['file'] } },
  { name: 'iris_lookup', description: 'A quick text look-up outside the browser (no cookies or logins): web = search results ("site:reddit.com …" for people\'s experiences), papers = papers with abstracts, arxiv = newest preprints, wiki = encyclopedia summary, page = text of one public page (query = URL), jobs = openings on one Greenhouse/Lever/Ashby/Workday board (query = board address + words), hn = Hacker News discussions.', inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['web', 'papers', 'arxiv', 'wiki', 'page', 'jobs', 'hn'] }, query: { type: 'string' } }, required: ['query'] } },
  { name: 'iris_bookmarks', description: 'Search the user\'s bookmarks (empty query lists them).', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'iris_bookmark', description: 'Add a bookmark to the bookmarks bar, or remove one (remove: true).', inputSchema: { type: 'object', properties: { url: { type: 'string' }, title: { type: 'string' }, remove: { type: 'boolean' } }, required: ['url'] } },
  { name: 'iris_my_info', description: 'The user\'s saved details for forms. Secrets come back as placeholders like {{Password}}: type the placeholder with iris_type and Iris fills in the real value.', inputSchema: { type: 'object', properties: {} } },
  { name: 'iris_accounts', description: 'Accounts Iris made for the user (site, username, link, purpose). The password is a placeholder like {{account:site.com}} for iris_type.', inputSchema: { type: 'object', properties: {} } },
  { name: 'iris_save_account', description: 'Record an account you just created (password: the placeholder you typed, e.g. {{Password}}).', inputSchema: { type: 'object', properties: { site: { type: 'string' }, username: { type: 'string' }, password: { type: 'string' }, url: { type: 'string' }, purpose: { type: 'string' } }, required: ['site', 'username'] } },
  { name: 'iris_downloads', description: 'The newest files in Iris\'s download folder.', inputSchema: { type: 'object', properties: {} } },
  { name: 'iris_career', description: 'The user\'s career profile with IDs (E1, E1.2, P3, X1…), job preferences and saved application answers.', inputSchema: { type: 'object', properties: {} } },
  { name: 'iris_resume', description: 'Build a one-page PDF resume for a job from the career profile, no model in Iris. picks = {"summary":str,"skills":[{"group","items":[]}],"experience":[{"id":"E1","bullets":["E1.3"]}],"projects":[{"id":"P2","bullets":["P2.1"]}],"extras":["X1"],"rewrite":{"E1.3":"…"}} using IDs from iris_career (best first; Iris trims to one page and undoes rewrites that add facts). Without picks it ranks by shared words.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, company: { type: 'string' }, requirements: { type: 'string' }, picks: { type: 'object' } }, required: ['title'] } },
  { name: 'iris_cover_letter', description: 'Build a one-page cover letter PDF from your text (three short paragraphs, facts only from iris_career). Iris removes sentences with numbers, tools or names the profile does not have. Upload it with iris_upload file "cover letter".', inputSchema: { type: 'object', properties: { title: { type: 'string' }, company: { type: 'string' }, text: { type: 'string' } }, required: ['title', 'text'] } },
  { name: 'iris_applications', description: 'Jobs already applied to, skipped or left for the user.', inputSchema: { type: 'object', properties: {} } },
  { name: 'iris_log_application', description: 'Record a job application: status applied | skipped | needs_you | failed.', inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['applied', 'skipped', 'needs_you', 'failed'] }, company: { type: 'string' }, title: { type: 'string' }, url: { type: 'string' }, note: { type: 'string' } }, required: ['status'] } }
]

/* tools that answer with data, not with an action on the page */
const DATA_TOOLS = {
  iris_lookup: 'lookup',
  iris_bookmarks: 'bookmarks',
  iris_bookmark: 'bookmark',
  iris_my_info: 'my_info',
  iris_accounts: 'accounts',
  iris_save_account: 'save_account',
  iris_downloads: 'downloads',
  iris_career: 'career',
  iris_resume: 'resume',
  iris_cover_letter: 'cover_letter',
  iris_applications: 'applications',
  iris_log_application: 'log_application'
}

/* MCP tool → an Iris action */
function toAction (name, a) {
  switch (name) {
    case 'iris_click': return { type: a.double ? 'double_click' : (a.button === 'right' ? 'right_click' : 'click'), x: a.x, y: a.y, button: a.button, what: a.what }
    case 'iris_type': return { type: 'type', text: a.text, x: a.x, y: a.y, enter: a.enter, clear: a.clear }
    case 'iris_key': return { type: 'key', key: a.key, modifiers: a.modifiers }
    case 'iris_scroll': return { type: 'scroll', direction: a.direction, amount: a.amount, x: a.x, y: a.y }
    case 'iris_hover': return { type: 'move', x: a.x, y: a.y }
    case 'iris_drag': return { type: 'drag', fromX: a.fromX, fromY: a.fromY, toX: a.toX, toY: a.toY }
    case 'iris_navigate': return { type: 'navigate', url: a.url }
    case 'iris_back': return { type: 'back' }
    case 'iris_new_tab': return { type: 'new_tab', url: a.url }
    case 'iris_switch_tab': return { type: 'switch_tab', tab: a.tab }
    case 'iris_close_tab': return { type: 'close_tab', tab: a.tab }
    case 'iris_find': return { type: 'find', text: a.text }
    case 'iris_wait': return { type: 'wait', ms: a.ms || 1000 }
    case 'iris_dialog': return { type: 'dialog', accept: a.accept, text: a.text }
    case 'iris_upload': return { type: 'upload', file: a.file }
  }
  return null
}

function shotContent (s) {
  const info = 'URL: ' + (s.url || '(empty tab)') + (s.title ? '\nTitle: ' + s.title : '') + '\nScreenshot: ' + s.width + 'x' + s.height + ' px' +
    (s.loading ? '\n(still loading)' : '') + (s.note ? '\n' + s.note : '') +
    (s.tabs && s.tabs.length > 1 ? '\nTabs: ' + s.tabs.map(function (t) { return '[' + t.tab + '] ' + (t.title || t.url).slice(0, 50) + (t.current ? ' (current)' : '') }).join('  ') : '')
  return [{ type: 'image', data: s.image, mimeType: s.mimeType }, { type: 'text', text: info }]
}

async function runTool (name, args) {
  const a = args || {}
  if (name === 'iris_screenshot') return shotContent(await call('screenshot'))
  if (name === 'iris_zoom') {
    const z = await call('zoom', { x: a.x, y: a.y })
    return [{ type: 'image', data: z.image, mimeType: z.mimeType }, { type: 'text', text: z.note }]
  }
  if (DATA_TOOLS[name]) {
    const r = await call(DATA_TOOLS[name], a)
    if (name === 'iris_lookup') return [{ type: 'text', text: r.text || 'Nothing found.' }]
    if (name === 'iris_career') return [{ type: 'text', text: r.profile + '\n\nPREFERENCES: ' + JSON.stringify(r.prefs) + '\nANSWERS: ' + r.answers.map(function (x) { return x.label + ': ' + x.value }).join('; ') }]
    return [{ type: 'text', text: JSON.stringify(r, null, 1) }]
  }
  if (name === 'iris_tabs') {
    const t = await call('tabs')
    return [{ type: 'text', text: t.tabs.map(function (x) { return '[' + x.tab + '] ' + x.title + ' — ' + x.url + (x.current ? ' (current)' : '') }).join('\n') || 'No tabs.' }]
  }
  const action = toAction(name, a)
  if (!action) throw new Error('unknown tool ' + name)
  const r = await call('act', action)
  const text = [{ type: 'text', text: r.did + (r.notes && r.notes.length ? '\n' + r.notes.join('\n') : '') }]
  return a.look === false ? text : text.concat(shotContent(await call('screenshot')))
}

/* ---- JSON-RPC over stdio, one message per line ---- */

function send (msg) { process.stdout.write(JSON.stringify(msg) + '\n') }

async function handle (msg) {
  if (msg.method === 'initialize') {
    return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'iris', version: '0.3.0' } } })
  }
  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } })
  if (msg.method === 'tools/call') {
    try {
      const content = await runTool(msg.params.name, msg.params.arguments)
      return send({ jsonrpc: '2.0', id: msg.id, result: { content } })
    } catch (err) {
      return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: err.message }], isError: true } })
    }
  }
  if (msg.method === 'ping') return send({ jsonrpc: '2.0', id: msg.id, result: {} })
  if (msg.id !== undefined && msg.method) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found: ' + msg.method } })
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', function (chunk) {
  buffer += chunk
  let i
  while ((i = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, i).trim()
    buffer = buffer.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch (e) { continue }
    handle(msg)
  }
})
