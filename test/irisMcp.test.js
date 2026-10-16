'use strict'

/* bin/iris-mcp.js speaks MCP on stdio and forwards to Iris's local bridge with the secret token. */

const test = require('node:test')
const assert = require('node:assert')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

test('the MCP server lists tools, sends the token, maps actions and returns screenshots', async () => {
  const seen = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : {} })
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/v1/screenshot') return res.end(JSON.stringify({ image: 'QUJD', mimeType: 'image/jpeg', width: 1280, height: 800, url: 'http://localhost:3000/', title: 'My app', tabs: [] }))
      if (req.url === '/v1/act') return res.end(JSON.stringify({ ok: true, did: 'Click at (10, 20)', notes: [] }))
      if (req.url === '/v1/lookup') return res.end(JSON.stringify({ ok: true, text: 'Web results for "x": 1. A', count: 1 }))
      if (req.url === '/v1/my_info') return res.end(JSON.stringify({ fields: [{ label: 'Email', value: 'a@b.c' }, { label: 'Password', placeholder: '{{Password}}' }] }))
      res.end(JSON.stringify({ error: 'nope' }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-mcp-'))
  fs.writeFileSync(path.join(dir, 'iris-bridge.json'), JSON.stringify({ port: server.address().port, token: 'secret123' }))

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'iris-mcp.js')], { env: Object.assign({}, process.env, { IRIS_USER_DATA: dir }) })
  const replies = []
  let buf = ''
  child.stdout.on('data', d => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) !== -1) { replies.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1) }
  })
  const send = m => child.stdin.write(JSON.stringify(m) + '\n')
  const waitFor = async id => { for (let k = 0; k < 200; k++) { const r = replies.find(x => x.id === id); if (r) return r; await new Promise(resolve => setTimeout(resolve, 10)) } throw new Error('no reply ' + id) }

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
  assert.strictEqual((await waitFor(1)).result.serverInfo.name, 'iris')
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const names = (await waitFor(2)).result.tools.map(t => t.name)
  assert.ok(names.includes('iris_screenshot') && names.includes('iris_click') && names.includes('iris_type'))

  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'iris_click', arguments: { x: 10, y: 20 } } })
  const click = await waitFor(3)
  assert.strictEqual(click.result.content[0].text, 'Click at (10, 20)')
  assert.strictEqual(click.result.content[1].type, 'image', 'a fresh screenshot comes back after acting')
  const act = seen.find(s => s.url === '/v1/act')
  assert.deepStrictEqual(act.body, { type: 'click', x: 10, y: 20 })
  assert.ok(seen.every(s => s.auth === 'Bearer secret123'))

  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'iris_type', arguments: { text: 'hi', enter: true, look: false } } })
  const typed = await waitFor(4)
  assert.strictEqual(typed.result.content.length, 1, 'look:false skips the screenshot')

  send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'iris_lookup', arguments: { kind: 'web', query: 'x' } } })
  assert.match((await waitFor(5)).result.content[0].text, /Web results/)
  assert.deepStrictEqual(seen.find(s => s.url === '/v1/lookup').body, { kind: 'web', query: 'x' })
  send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'iris_my_info', arguments: {} } })
  assert.match((await waitFor(6)).result.content[0].text, /\{\{Password\}\}/, 'secrets only as placeholders')
  send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'iris_upload', arguments: { file: 'resume', look: false } } })
  await waitFor(7)
  assert.deepStrictEqual(seen.filter(s => s.url === '/v1/act').pop().body, { type: 'upload', file: 'resume' })
  assert.ok(names.includes('iris_resume') && names.includes('iris_career') && names.includes('iris_zoom'))

  child.kill()
  server.close()
})
