'use strict'

const test = require('node:test')
const assert = require('node:assert')

const { createSafetyGate, DEFAULTS, isBlockedUrl } = require('../iris/agent/safety')

function clock () {
  let t = 0
  return { now: () => t, advance: (ms) => { t += ms } }
}

test('safety gate defaults exist and are sane', () => {
  assert.ok(DEFAULTS.maxSteps > 0)
  assert.ok(DEFAULTS.maxWallClockMs > 0)
  assert.ok(DEFAULTS.repeatActionLimit >= 2)
})

test('allows steps up to the limit then stops', () => {
  const c = clock()
  const gate = createSafetyGate({ now: c.now, maxSteps: 3, maxWallClockMs: 100000 })
  assert.strictEqual(gate.beforeStep().allow, true)
  assert.strictEqual(gate.beforeStep().allow, true)
  assert.strictEqual(gate.beforeStep().allow, true)
  const fourth = gate.beforeStep()
  assert.strictEqual(fourth.allow, false)
  assert.strictEqual(fourth.kind, 'steps')
  assert.match(fourth.reason, /limit of 3 steps/)
})

test('wall-clock budget stops a long-running task', () => {
  const c = clock()
  const gate = createSafetyGate({ now: c.now, maxSteps: 100, maxWallClockMs: 5000 })
  assert.strictEqual(gate.beforeStep().allow, true)
  c.advance(6000)
  const second = gate.beforeStep()
  assert.strictEqual(second.allow, false)
  assert.strictEqual(second.kind, 'time')
})

test('detects a stuck agent repeating the same action', () => {
  const c = clock()
  const gate = createSafetyGate({ now: c.now, maxSteps: 50, maxWallClockMs: 100000, repeatActionLimit: 2 })
  const a = { type: 'click', x: 10, y: 10 }
  assert.strictEqual(gate.beforeAction(a).allow, true)
  assert.strictEqual(gate.beforeAction(a).allow, true)
  const third = gate.beforeAction(a)
  assert.strictEqual(third.allow, false)
  assert.strictEqual(third.kind, 'loop')
})

test('different actions do not trip the loop detector', () => {
  const c = clock()
  const gate = createSafetyGate({ now: c.now, maxSteps: 50, maxWallClockMs: 100000, repeatActionLimit: 2 })
  for (let i = 0; i < 10; i++) {
    assert.strictEqual(gate.beforeAction({ type: 'click', x: i, y: i }).allow, true)
  }
})

test('blocks dangerous url schemes and honours a host block list', () => {
  const c = clock()
  const gate = createSafetyGate({ now: c.now, blockHosts: ['evil.test'] })
  assert.strictEqual(gate.beforeAction({ type: 'navigate', url: 'javascript:alert(1)' }).kind, 'blocked')
  assert.strictEqual(gate.beforeAction({ type: 'navigate', url: 'file:///etc/passwd' }).kind, 'blocked')
  assert.strictEqual(gate.beforeAction({ type: 'navigate', url: 'chrome://settings' }).kind, 'blocked')
  assert.strictEqual(gate.beforeAction({ type: 'navigate', url: 'https://evil.test/x' }).kind, 'blocked')
  assert.strictEqual(gate.beforeAction({ type: 'navigate', url: 'https://example.com/' }).allow, true)
  assert.strictEqual(isBlockedUrl('HTTPS://EXAMPLE.COM/', { blockSchemes: ['javascript:'], blockHosts: [] }).blocked, false)
})

test('pauses before sensitive actions', () => {
  const c = clock()
  const gate = createSafetyGate({ now: c.now })
  const r = gate.beforeAction({ type: 'type', text: 'purchase now with card 4111' })
  assert.strictEqual(r.allow, false)
  assert.strictEqual(r.kind, 'confirmation')
})

test('sensitive check is disabled when the user allows it', () => {
  const c = clock()
  const gate = createSafetyGate({ now: c.now, allowSensitiveActions: true })
  assert.strictEqual(gate.beforeAction({ type: 'type', text: 'purchase now' }).allow, true)
})

test('stops after too many retries in one step', () => {
  const c = clock()
  const gate = createSafetyGate({ now: c.now, maxRetriesPerStep: 2, maxConsecutiveFailures: 99 })
  assert.strictEqual(gate.noteRetry('bad').allow, true)
  assert.strictEqual(gate.noteRetry('bad').allow, true)
  const third = gate.noteRetry('bad')
  assert.strictEqual(third.allow, false)
  assert.strictEqual(third.kind, 'retries')
  gate.noteSuccess()
  assert.strictEqual(gate.noteRetry('bad').allow, true)
})

test('stops after too many consecutive failures overall', () => {
  const c = clock()
  const gate = createSafetyGate({ now: c.now, maxRetriesPerStep: 99, maxConsecutiveFailures: 2 })
  gate.noteRetry('a')
  const second = gate.noteRetry('b')
  assert.strictEqual(second.allow, true)
  const third = gate.noteRetry('c')
  assert.strictEqual(third.allow, false)
  assert.strictEqual(third.kind, 'failures')
})

test('takeover stop is reported when the user grabbed the page', () => {
  const c = clock()
  const gate = createSafetyGate({ now: c.now })
  const r = gate.beforeAction({ type: 'click', x: 1, y: 1 }, { pausedByUser: true })
  assert.strictEqual(r.allow, false)
  assert.strictEqual(r.kind, 'takeover')
})

test('snapshot reports counters and limits', () => {
  const c = clock()
  const gate = createSafetyGate({ now: c.now, maxSteps: 5 })
  gate.beforeStep()
  gate.beforeModelCall()
  gate.noteRetry('x')
  const s = gate.snapshot()
  assert.strictEqual(s.steps, 1)
  assert.strictEqual(s.modelCalls, 1)
  assert.strictEqual(s.retries, 1)
  assert.strictEqual(s.limits.maxSteps, 5)
})
