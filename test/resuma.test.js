'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('events')
const R = require('../iris/agent/resuma')

/* a fake resuma: answers JSON-RPC lines the way the Python MCP server does */
function fakeSpawn (handlers) {
  const spawned = []
  function spawn (command, args, opts) {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.killed = false
    child.kill = function () { child.killed = true; setImmediate(function () { child.emit('exit', 0) }) }
    child.stdin = {
      write: function (line) {
        const msg = JSON.parse(line)
        if (msg.id === undefined) return
        const reply = function (result, error) {
          // two messages in one chunk and a split line, as pipes deliver them
          const text = JSON.stringify(error ? { jsonrpc: '2.0', id: msg.id, error: error } : { jsonrpc: '2.0', id: msg.id, result: result }) + '\n'
          setImmediate(function () {
            child.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n' + text.slice(0, 10)))
            child.stdout.emit('data', Buffer.from(text.slice(10)))
          })
        }
        if (msg.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'resuma' } })
        if (msg.method === 'tools/call') return handlers(msg.params.name, msg.params.arguments, reply)
      }
    }
    spawned.push({ command, args, opts, child })
    return child
  }
  spawn.spawned = spawned
  return spawn
}

test('the client starts the server once, calls tools and reads their structured content', async () => {
  const spawn = fakeSpawn(function (name, args, reply) {
    if (name === 'tailor_resume') return reply({ content: [{ type: 'text', text: '{}' }], structuredContent: { job_id: 'abc', status: 'queued', mode: args.mode } })
    if (name === 'list_runs') return reply({ content: [{ type: 'text', text: '{"runs":[1,2]}' }] })
  })
  const c = R.createResumaClient({ spawn, command: 'py', args: ['-m', 'resuma', 'serve'], cwd: '/x', env: { RESUMA_REAL_ONLY: '1' } })
  const j = await c.call('tailor_resume', { jd_text: 'x'.repeat(100), mode: 'strict' })
  assert.deepStrictEqual(j, { job_id: 'abc', status: 'queued', mode: 'strict' })
  const runs = await c.call('list_runs', {})
  assert.deepStrictEqual(runs, { runs: [1, 2] }, 'text content parsed when there is no structured content')
  assert.strictEqual(spawn.spawned.length, 1, 'one server for many calls')
  assert.strictEqual(spawn.spawned[0].opts.env.RESUMA_REAL_ONLY, '1')
  c.stop()
})

test('a tool error and a server that exits reject, and the next call starts it again', async () => {
  const spawn = fakeSpawn(function (name, args, reply) {
    if (name === 'get_job') return reply({ isError: true, content: [{ type: 'text', text: "unknown job_id 'nope'" }] })
    if (name === 'die') return spawn.spawned[spawn.spawned.length - 1].child.emit('exit', 1)
    return reply({ structuredContent: { ok: 1 } })
  })
  const c = R.createResumaClient({ spawn, command: 'py' })
  await assert.rejects(c.call('get_job', { job_id: 'nope' }), /unknown job_id/)
  await assert.rejects(c.call('die', {}), /resuma stopped/)
  assert.deepStrictEqual(await c.call('again', {}), { ok: 1 })
  assert.strictEqual(spawn.spawned.length, 2)
  c.stop()
})

test('waitForJob polls until done, and gives up on a failed or lost run', async () => {
  let n = 0
  const phases = []
  const client = { call: async function () { n++; return n < 3 ? { status: 'running', phase: n === 1 ? 'planning' : 'writing' } : { status: 'done', phase: 'done', result: { files: { pdf: '/o/a.pdf' } } } } }
  const r = await R.waitForJob(client, 'j1', { sleep: async function () {}, onProgress: function (j) { phases.push(j.phase) } })
  assert.ok(r.ok && r.result.files.pdf === '/o/a.pdf')
  assert.deepStrictEqual(phases, ['planning', 'writing', 'done'])
  const failed = await R.waitForJob({ call: async function () { return { status: 'failed', error: 'LLMError: unreachable' } } }, 'j2', { sleep: async function () {} })
  assert.ok(!failed.ok && /failed: LLMError/.test(failed.error))
  const lost = await R.waitForJob({ call: async function () { throw new Error("unknown job_id 'j3'") } }, 'j3', { sleep: async function () {} })
  assert.ok(!lost.ok && /unknown job_id/.test(lost.error))
  let t = 0
  const slow = await R.waitForJob({ call: async function () { return { status: 'queued' } } }, 'j4', { sleep: async function () { t += 60000 }, now: function () { return t }, timeoutMs: 5 * 60000 })
  assert.ok(!slow.ok && slow.timedOut)
})

test('each job gets its own resuma folder name, never a path', () => {
  assert.strictEqual(R.resumaCompany({ company: 'JP Morgan', title: 'Software Engineer, iOS (New Grad)' }, 'a1b2'), 'JP Morgan - Software Engineer iOS New Grad a1b2')
  assert.ok(!/\.\./.test(R.resumaCompany({ company: '../..', title: 'x/y' })))
  assert.ok(!/[/\\]/.test(R.resumaCompany({ company: 'a/b\\c', title: 'd' })))
})
