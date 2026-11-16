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

test('leaving an application cancels its resume, but form, login and email steps preserve it', () => {
  const job = { company: 'Acme', title: 'Engineer', url: 'https://jobs.acme.com/job/12345', resume: '/resume.pdf', tabId: 'application' }
  assert.ok(R.moveOnReason(job, { type: 'cancel_resume', reason: 'duplicate' }))
  assert.ok(R.moveOnReason(job, { type: 'lookup', kind: 'jobs' }))
  assert.ok(R.moveOnReason(job, { type: 'tailor_resume' }, { sameJob: false }))
  assert.ok(!R.moveOnReason(job, { type: 'tailor_resume' }, { sameJob: true }))
  assert.ok(R.moveOnReason(job, { type: 'close_tab' }, { tabId: 'application' }))
  assert.ok(!R.moveOnReason(job, { type: 'close_tab' }, { tabId: 'email' }))
  for (const url of ['https://www.ycombinator.com/jobs/role/software-engineer?experience=entry-level', 'https://jobs.acme.com/search-jobs', 'https://www.google.com/search?q=new+grad+jobs']) {
    assert.ok(R.moveOnReason(job, { type: 'switch_tab' }, { url }), url)
  }
  for (const url of ['https://mail.google.com/mail/u/0/', 'https://citi.wd5.myworkdayjobs.com/2/job/New-York/Python-Developer_261002498-1/apply', 'https://login.microsoftonline.com/common/oauth2/authorize', 'https://jobs.acme.com/job/12345/apply', 'https://boards.greenhouse.io/embed/job_app?token=123456']) {
    assert.ok(!R.moveOnReason(job, { type: 'navigate' }, { url }), url)
  }
  assert.ok(!R.moveOnReason(Object.assign({}, job, { resumeCancelled: 'duplicate' }), { type: 'lookup', kind: 'jobs' }))
  assert.ok(!R.moveOnReason(Object.assign({}, job, { uploaded: true }), { type: 'lookup', kind: 'jobs' }))
})

test('labelled requisitions match public and ATS postings without confusing companies or distinct jobs', () => {
  assert.deepStrictEqual(R.requisitionIds('Job Req Id:\n\n261002498\nLocation: New York'), ['261002498'])
  assert.deepStrictEqual(R.requisitionIds('Requisition ID: JR-121808'), ['jr121808'])
  assert.deepStrictEqual(R.requisitionIds('Salary $126500.00; posted Oct 29, 2026; 3 years of experience'), [])
  const records = [{ company: 'Citi', title: 'Python Developer', requisitionIds: ['261002498'] }]
  const job = { company: 'Citi', title: 'Python Developer', requirements: 'Job Req Id: 261002498' }
  assert.strictEqual(R.appliedRequisition(job, records, () => []), records[0])
  assert.strictEqual(R.appliedRequisition(Object.assign({}, job, { requirements: 'Job Req Id: 261002499' }), records, () => []), null)
  assert.strictEqual(R.appliedRequisition(Object.assign({}, job, { company: 'Citizens Financial Group' }), records, () => []), null)
  assert.strictEqual(R.appliedRequisition(Object.assign({}, job, { requirements: 'Python Developer, New York' }), records, () => []), null)
})

test('tailoring sends the company, role and posting with an explicit 90% target', async () => {
  let received
  const spawn = fakeSpawn(function (name, args, reply) {
    received = args
    reply({ structuredContent: { job_id: 'tailored' } })
  })
  const c = R.createResumaClient({ spawn, command: 'py' })
  const job = { company: 'Acme', title: 'Backend Engineer', requirements: 'Build Python APIs and maintain distributed services.' }
  await c.call('tailor_resume', R.tailorArgs(job, 'preview'))
  assert.match(received.jd_text, /^Company: Acme\nRole: Backend Engineer\n/)
  assert.ok(received.jd_text.endsWith(job.requirements))
  assert.strictEqual(received.coverage_target, 0.90)
  assert.strictEqual(received.company, 'Acme - Backend Engineer preview')
  assert.strictEqual(received.mode, 'jd_aware')
  assert.strictEqual(received.project_strategy, 'adaptive')
  assert.strictEqual(received.wait, false)
  assert.strictEqual(R.tailorArgs(Object.assign({}, job, { requirements: 'x'.repeat(30000) })).jd_text.length, 20000)
  c.stop()
})
