'use strict'

const test = require('node:test')
const assert = require('node:assert')

const { record, summary, speedOf, emptyStore, normalizeStore, MAX_SESSIONS } = require('../iris/agent/usage')

const NOW = new Date(2026, 9, 23, 19, 30)

function reply (prompt, completion, extra) {
  return Object.assign({ prompt_tokens: prompt, completion_tokens: completion }, extra || {})
}

test('a request counts for the day, its session and its project', () => {
  let s = emptyStore()
  s = record(s, 'request', { usage: reply(1000, 50, { gen_ms: 1000 }), ms: 3000, session: { id: 's1', title: 'Apply to jobs' }, project: { id: 'p1', name: 'Jobs' }, provider: 'local', model: 'q' }, NOW)
  s = record(s, 'request', { usage: reply(2000, 150, { gen_ms: 3000 }), ms: 5000, session: { id: 's1' }, project: { id: 'p1' }, provider: 'local', model: 'q' }, NOW)
  assert.deepStrictEqual(s.days['2026-10-23'], { tasks: 0, requests: 2, input: 3000, output: 200, cached: 0, ms: 8000, genMs: 4000, genOut: 200 })
  assert.strictEqual(speedOf(s.days['2026-10-23']), 50)
  const sess = s.sessions.s1
  assert.strictEqual(sess.title, 'Apply to jobs')
  assert.strictEqual(sess.project, 'p1')
  assert.strictEqual(sess.requests, 2)
  assert.strictEqual(sess.input, 3000)
  assert.strictEqual(sess.output, 200)
  assert.strictEqual(sess.provider, 'local')
  // 200 tokens over 4 s of generation
  assert.strictEqual(speedOf(sess), 50)
  assert.strictEqual(s.projects.p1.name, 'Jobs')
  assert.strictEqual(s.projects.p1.requests, 2)
})

test('speed uses only replies whose generation time is known', () => {
  let s = emptyStore()
  s = record(s, 'request', { usage: reply(10, 100, { timings: { predicted_ms: 2000 } }), ms: 5000, session: { id: 's' } }, NOW)
  s = record(s, 'request', { usage: reply(10, 100), ms: 5000, session: { id: 's' } }, NOW)
  assert.strictEqual(s.sessions.s.output, 200)
  assert.strictEqual(speedOf(s.sessions.s), 50)
  assert.strictEqual(speedOf({ output: 5 }), null)
})

test('tasks and look-ups count per day only', () => {
  let s = emptyStore()
  s = record(s, 'task', null, NOW)
  s = record(s, 'lookup', null, NOW)
  s = record(s, 'lookup', null, NOW)
  assert.strictEqual(s.days['2026-10-23'].tasks, 1)
  assert.strictEqual(s.days['2026-10-23'].lookups, 2)
  assert.deepStrictEqual(s.sessions, {})
})

test('an old days-only file and a damaged one both load', () => {
  const old = normalizeStore({ days: { '2026-10-17': { tasks: 1, requests: 2, input: 3, output: 4, ms: 5 } } })
  assert.strictEqual(old.days['2026-10-17'].requests, 2)
  assert.deepStrictEqual(old.sessions, {})
  assert.deepStrictEqual(normalizeStore(null), emptyStore())
  assert.deepStrictEqual(normalizeStore('junk'), emptyStore())
})

test('only the newest sessions are kept', () => {
  let s = emptyStore()
  for (let i = 0; i < MAX_SESSIONS + 5; i++) s = record(s, 'request', { usage: reply(1, 1), ms: 1, session: { id: 's' + i } }, NOW.getTime() + i)
  assert.strictEqual(Object.keys(s.sessions).length, MAX_SESSIONS)
  assert.ok(!s.sessions.s0)
  assert.ok(s.sessions['s' + (MAX_SESSIONS + 4)])
})

test('summary for the panel', () => {
  let s = emptyStore()
  s = record(s, 'request', { usage: reply(500, 40, { gen_ms: 2000 }), ms: 3000, session: { id: 's1' }, project: { id: 'p1', name: 'Jobs' } }, NOW)
  const sum = summary(s, 's1', 'p1')
  assert.deepStrictEqual(sum.session, { requests: 1, input: 500, output: 40, speed: 20 })
  assert.strictEqual(sum.project.name, 'Jobs')
  assert.deepStrictEqual(summary(s, 'nope', null), { session: null, project: null })
})
