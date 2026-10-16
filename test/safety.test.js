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
  assert.strictEqual(gate.beforeAction({ type: 'navigate', url: 'https://evil.test/x' }).kind, 'blocked')
  assert.strictEqual(gate.beforeAction({ type: 'navigate', url: 'https://example.com/' }).allow, true)
  assert.strictEqual(isBlockedUrl('HTTPS://EXAMPLE.COM/', { blockSchemes: ['javascript:'], blockHosts: [] }).blocked, false)
})

test('pauses before sensitive actions only when the user turns that on', () => {
  const c = clock()
  const gate = createSafetyGate({ now: c.now, allowSensitiveActions: false })
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

test('scrolling repeatedly is fine while the page changes, a loop when it does not', () => {
  const c = clock()
  const gate = createSafetyGate({ now: c.now, repeatActionLimit: 2 })
  const s = { type: 'scroll', direction: 'down', amount: 5, x: 1, y: 1 }
  for (let i = 0; i < 6; i++) assert.strictEqual(gate.beforeAction(s, { pageUnchanged: false }).allow, true)
  assert.strictEqual(gate.beforeAction(s, { pageUnchanged: true }).kind, 'loop')
})

test('an approved sensitive action passes once', () => {
  const c = clock()
  const gate = createSafetyGate({ now: c.now, allowSensitiveActions: false })
  const a = { type: 'type', text: 'place order now' }
  const first = gate.beforeAction(a)
  assert.strictEqual(first.kind, 'confirmation')
  assert.strictEqual(gate.beforeAction(a, { approved: first.key }).allow, true)
})

test('ordinary words like remove or delete in a search are not treated as sensitive', () => {
  const c = clock()
  const gate = createSafetyGate({ now: c.now, allowSensitiveActions: false })
  assert.strictEqual(gate.beforeAction({ type: 'type', text: 'how to remove coffee stains' }).allow, true)
})

test('refundStep gives back a step that never reached the model', () => {
  const c = clock()
  const gate = createSafetyGate({ now: c.now, maxSteps: 1 })
  assert.strictEqual(gate.beforeStep().allow, true)
  gate.refundStep()
  assert.strictEqual(gate.beforeStep().allow, true)
  assert.strictEqual(gate.beforeStep().allow, false)
})

test('no restrictions by default: purchases and logins go straight through', () => {
  const c = clock()
  const gate = createSafetyGate({ now: c.now })
  assert.strictEqual(gate.beforeAction({ type: 'type', text: 'place order now' }).allow, true)
  assert.strictEqual(gate.beforeAction({ type: 'navigate', url: 'file:///Users/me/report.pdf' }).allow, true)
})

test('0 means no step or time limit (continuous runs)', () => {
  const c = clock()
  const gate = createSafetyGate({ now: c.now, maxSteps: 0, maxWallClockMs: 0 })
  for (let i = 0; i < 500; i++) assert.strictEqual(gate.beforeStep().allow, true)
  c.advance(48 * 3600 * 1000)
  assert.strictEqual(gate.beforeStep().allow, true)
})

test('reset starts the budget again for a follow-up', () => {
  const c = clock()
  const gate = createSafetyGate({ now: c.now, maxSteps: 2 })
  gate.beforeStep(); gate.beforeStep()
  assert.strictEqual(gate.beforeStep().allow, false)
  gate.reset()
  assert.strictEqual(gate.beforeStep().allow, true)
})

test('after card details are typed, a click that means "pay" waits for the user', () => {
  const g = createSafetyGate({})
  assert.ok(g.beforeAction({ type: 'click', x: 1, y: 1 }, { thought: 'Click Pay now' }).allow, 'no card typed yet: normal click')
  assert.ok(g.beforeAction({ type: 'type', text: '{{Card number}}' }, { thought: 'fill card' }).allow)
  const d = g.beforeAction({ type: 'click', x: 5, y: 5 }, { thought: 'Card filled. Click Place order.' })
  assert.strictEqual(d.allow, false)
  assert.strictEqual(d.kind, 'confirmation')
  assert.strictEqual(d.key, 'payment')
  assert.ok(g.beforeAction({ type: 'click', x: 6, y: 6 }, { thought: 'Click Place order.', approved: 'payment' }).allow, 'approved')
  assert.ok(g.beforeAction({ type: 'click', x: 7, y: 7 }, { thought: 'Open the receipt' }).allow, 'not a pay click')
})

test('paymentGuard auto never pauses', () => {
  const g = createSafetyGate({ paymentGuard: 'auto' })
  g.beforeAction({ type: 'type', text: '{{Card CVC}}' }, {})
  assert.ok(g.beforeAction({ type: 'click', x: 5, y: 5 }, { thought: 'Pay now' }).allow)
})

test('ask-before-submit: the click that sends an application waits for the user', () => {
  const gate = createSafetyGate({ applicationGuard: 'ask' })
  const click = { type: 'click', x: 10, y: 10 }
  const d = gate.beforeAction(click, { thought: 'All fields are filled. Click Submit Application.' })
  assert.strictEqual(d.allow, false)
  assert.strictEqual(d.key, 'application')
  assert.strictEqual(gate.beforeAction(click, { thought: 'Click Submit Application.', approved: 'application' }).allow, true)
  assert.strictEqual(gate.beforeAction({ type: 'click', x: 1, y: 2 }, { thought: 'Submit the search for Android jobs' }).allow, true)
  assert.strictEqual(createSafetyGate({}).beforeAction(click, { thought: 'Click Submit Application.' }).allow, true, 'off unless asked for')
})

test('ask-before-submit: Enter in a form field pauses too, a search or dropdown choice does not', () => {
  const gate = createSafetyGate({ applicationGuard: 'ask' })
  const d = gate.beforeAction({ type: 'type', text: '1', enter: true }, { thought: 'Set years of experience to 1.' })
  assert.strictEqual(d.allow, false)
  assert.strictEqual(d.key, 'application')
  assert.strictEqual(gate.beforeAction({ type: 'type', text: 'Yes', enter: true }, { thought: 'Pick Yes in the work authorization dropdown' }).allow, true)
  assert.strictEqual(gate.beforeAction({ type: 'type', text: 'android', enter: true }, { thought: 'Search the job board for android roles' }).allow, true)
  assert.strictEqual(gate.beforeAction({ type: 'type', text: 'Yes', enter: true, clear: false }, { thought: 'Set work authorization to Yes' }).allow, true, 'a dropdown pick (clear:false) goes through')
})
