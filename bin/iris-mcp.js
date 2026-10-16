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
 * person. Iris's own model does not run. x/y are pixels in the latest screenshot.
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
  { name: 'iris_click', description: 'Click at a point in the latest screenshot.', inputSchema: { type: 'object', properties: Object.assign({}, XY, { button: { type: 'string', enum: ['left', 'right', 'middle'] }, double: { type: 'boolean' } }, LOOK), required: ['x', 'y'] } },
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
  { name: 'iris_wait', description: 'Wait while the page is loading or animating.', inputSchema: { type: 'object', properties: Object.assign({ ms: { type: 'integer' } }, LOOK) } }
]

/* MCP tool → an Iris action */
function toAction (name, a) {
  switch (name) {
    case 'iris_click': return { type: a.double ? 'double_click' : (a.button === 'right' ? 'right_click' : 'click'), x: a.x, y: a.y, button: a.button }
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
    return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'iris', version: '0.2.0' } } })
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
