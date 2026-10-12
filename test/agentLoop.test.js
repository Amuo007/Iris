'use strict'

const test = require('node:test')
const assert = require('node:assert')

const { createAgent } = require('../iris/agent/agentLoop')
const { FakeModel, FakeComputer, virtualClock, json } = require('./fakes')

/** Build an agent whose timers are instant and whose clock is virtual. */
function harness (replies, computerOptions, options) {
  const clock = virtualClock()
  const model = new FakeModel(replies)
  const computer = new FakeComputer(Object.assign({ width: 2880, height: 1800, devicePixelRatio: 2 }, computerOptions))
  const events = []
  const agent = createAgent(Object.assign({
    model,
    computer,
    delay: clock.delay,
    now: clock.now,
    onEvent: (type, payload) => events.push(Object.assign({ type }, payload)),
    config: { settleDelayMs: 0, markerDwellMs: 0 }
  }, options || {}))
  return { agent, model, computer, events, clock }
}

const ev = (events, type) => events.filter(e => e.type === type)

/** Yield to the event loop until `predicate()` holds (fails loudly instead of hanging). */
async function until (predicate, what) {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return
    await new Promise(r => setImmediate(r))
  }
  throw new Error('timed out waiting for: ' + what)
}

/* ------------------------------------------------------------------ */

test('happy path: acts on what the model says and finishes', async () => {
  const h = harness([
    json('click the search box', { type: 'click', x: 1000, y: 800 }),
    json('type the query', { type: 'type', text: 'weather paris' }),
    json('submit', { type: 'key', key: 'enter' }),
    json('the weather is shown', { type: 'done', answer: 'It is 21C in Paris' })
  ])

  const result = await h.agent.run('What is the weather in Paris?')

  assert.strictEqual(result.status, 'done')
  assert.strictEqual(result.answer, 'It is 21C in Paris')
  assert.strictEqual(h.computer.actions.length, 3)
  assert.deepStrictEqual(h.computer.actions.map(a => a.type), ['click', 'type', 'key'])
  assert.strictEqual(h.model.callCount, 4)
})

test('Retina: screenshot coordinates become CSS coordinates on the page', async () => {
  const h = harness([
    json('click', { type: 'click', x: 1000, y: 800 }),
    json('done', { type: 'done' })
  ])
  await h.agent.run('click it')
  const sent = h.computer.actions[0]
  assert.strictEqual(sent.x, 500)
  assert.strictEqual(sent.y, 400)
})

test('the UI receives the marker position in both spaces', async () => {
  const h = harness([json('click', { type: 'click', x: 1440, y: 900 }), json('ok', { type: 'done' })])
  await h.agent.run('click centre')
  const action = ev(h.events, 'action')[0]
  assert.deepStrictEqual(action.anchor, { x: 720, y: 450 })
  assert.strictEqual(action.actionView.x, 720)
  assert.strictEqual(action.action.x, 1440)
  assert.match(action.description, /Click at/)
})

test('observation events carry the screenshot the model saw', async () => {
  const h = harness([json('ok', { type: 'done' })])
  await h.agent.run('noop')
  const obs = ev(h.events, 'observation')[0]
  assert.ok(obs.dataUrl.startsWith('data:image/png'))
  assert.strictEqual(obs.width, 2880)
  assert.strictEqual(obs.viewWidth, 1440)
  assert.strictEqual(obs.devicePixelRatio, 2)
})

/* ---------- bad model output ------------------------------------------- */

test('prose instead of JSON is rejected, corrected and retried', async () => {
  const h = harness([
    'I will click the button now.',
    json('now clicked', { type: 'click', x: 10, y: 10 }),
    json('done', { type: 'done' })
  ])
  const result = await h.agent.run('click a button')
  assert.strictEqual(result.status, 'done')
  assert.strictEqual(ev(h.events, 'rejected').length, 1)
  assert.strictEqual(h.computer.actions.length, 1)
})

test('out-of-image coordinates are rejected and re-asked', async () => {
  const h = harness([
    json('hallucinating', { type: 'click', x: 99999, y: 10 }),
    json('fixed', { type: 'click', x: 100, y: 100 }),
    json('done', { type: 'done' })
  ])
  const result = await h.agent.run('click')
  assert.strictEqual(result.status, 'done')
  assert.strictEqual(h.computer.actions.length, 1)
  assert.strictEqual(h.computer.actions[0].x, 50)
})

test('gives up after repeated unusable responses in one step', async () => {
  const h = harness(['nope', 'still nope', 'never', 'what?'], null, {
    safety: { maxRetriesPerStep: 2 }
  })
  const result = await h.agent.run('impossible')
  assert.strictEqual(result.status, 'failed')
  assert.match(result.reason, /unusable responses/)
  assert.strictEqual(h.computer.actions.length, 0)
})

test('a network error from the model is retried, not fatal on the first hit', async () => {
  const h = harness([null, json('recovered', { type: 'click', x: 4, y: 4 }), json('done', { type: 'done' })])
  const result = await h.agent.run('flaky')
  assert.strictEqual(result.status, 'done')
  assert.strictEqual(ev(h.events, 'error').length, 1)
})

/* ---------- loading pages ---------------------------------------------- */

test('waits instead of acting while the page is still loading', async () => {
  const h = harness([json('now it rendered', { type: 'click', x: 100, y: 100 }), json('done', { type: 'done' })], {
    loadingSchedule: [true, true, false]
  })
  const result = await h.agent.run('click when ready')
  assert.strictEqual(result.status, 'done')
  const auto = ev(h.events, 'action').filter(a => a.automatic)
  assert.strictEqual(auto.length, 2)
  assert.strictEqual(auto[0].action.type, 'wait')
  // the model was only consulted once the page had settled
  assert.strictEqual(h.model.callCount, 2)
})

test('does not wait forever on a page that never settles', async () => {
  const h = harness(
    [json('try anyway', { type: 'click', x: 100, y: 100 }), json('done', { type: 'done' })],
    { loadingSchedule: [true, true, true, true, true, true, true, true] },
    { config: { settleDelayMs: 0, markerDwellMs: 0, maxAutoWaits: 3 } }
  )
  const result = await h.agent.run('stubborn page')
  assert.strictEqual(result.status, 'done')
  const auto = ev(h.events, 'action').filter(a => a.automatic)
  assert.strictEqual(auto.length, 3)
})

test('a screenshot failure is reported and retried', async () => {
  const h = harness([json('ok', { type: 'done' })], { failScreenshotTimes: 1 })
  const result = await h.agent.run('flaky capture')
  assert.strictEqual(result.status, 'done')
  assert.strictEqual(ev(h.events, 'error')[0].where, 'screenshot')
})

/* ---------- stop conditions -------------------------------------------- */

test('stops at the configured max steps', async () => {
  const replies = []
  for (let i = 0; i < 40; i++) replies.push(json('scrolling', { type: 'scroll', direction: 'down', amount: (i % 3) + 1, x: 1440, y: 900 + i }))
  const h = harness(replies, null, { safety: { maxSteps: 6 } })
  const result = await h.agent.run('find the footer')
  assert.strictEqual(result.status, 'stopped')
  assert.strictEqual(result.steps, 6)
  assert.match(result.reason, /limit of 6 steps/)
})

test('the model is never consulted after the run ends', async () => {
  const replies = []
  for (let i = 0; i < 20; i++) replies.push(json('again', { type: 'click', x: 10 + i, y: 10 }))
  const h = harness(replies, null, { safety: { maxSteps: 4 } })
  await h.agent.run('cap')
  assert.strictEqual(h.model.callCount, 4)
})

test('stop() halts the loop within one step and reports why', async () => {
  const h = harness([json('a', { type: 'click', x: 10, y: 10 }), json('b', { type: 'click', x: 20, y: 20 })])
  const running = h.agent.run('keep going')
  h.agent.stop('user pressed stop')
  const result = await running
  assert.strictEqual(result.status, 'stopped')
  assert.match(result.reason, /user pressed stop/)
  assert.ok(h.model.callCount <= 2)
})

test('pause blocks the loop until resume', async () => {
  const h = harness([json('a', { type: 'click', x: 10, y: 10 }), json('b', { type: 'click', x: 20, y: 20 }), json('done', { type: 'done' })])
  let sawPausedWait = false
  const running = h.agent.run('paused task')
  h.agent.pause('user wanted a break')
  await until(() => h.events.some(e => e.type === 'pause:waiting'), 'loop to park while paused')
  sawPausedWait = true
  h.agent.resume()
  const result = await running
  assert.strictEqual(result.status, 'done')
  assert.ok(sawPausedWait, 'loop should have parked while paused')
})

test('user takeover pauses the agent and tells the model what happened', async () => {
  const h = harness([
    json('a', { type: 'click', x: 10, y: 10 }),
    json('the human typed', { type: 'click', x: 30, y: 30 }),
    json('done', { type: 'done' })
  ])
  const running = h.agent.run('takeover task')
  h.computer.userInteracts('keydown', { x: 400, y: 200 })
  await until(() => h.agent.status().status === 'paused', 'agent to pause for user takeover')
  assert.strictEqual(h.agent.status().status, 'paused')
  const takeover = ev(h.events, 'takeover')
  assert.strictEqual(takeover.length, 1)
  assert.strictEqual(takeover[0].info.kind, 'keydown')
  h.agent.resume()
  const result = await running
  assert.strictEqual(result.status, 'done')
})

test('a repeated ineffective action parks the agent for the human', async () => {
  const same = json('same', { type: 'click', x: 100, y: 100 })
  const h = harness([same, same, same, same, same, json('done', { type: 'done' })], null, {
    safety: { repeatActionLimit: 2 }
  })
  const running = h.agent.run('stuck')
  await until(() => h.agent.status().status === 'paused', 'loop detector to park the agent')
  h.agent.resume()
  const result = await running
  assert.strictEqual(result.status, 'done')
  const blocked = ev(h.events, 'blocked')
  assert.ok(blocked.some(b => b.kind === 'loop'))
})

test('blocked navigation is stopped before it reaches the page', async () => {
  const h = harness([json('escape', { type: 'navigate', url: 'javascript:alert(document.cookie)' })])
  const result = await h.agent.run('do something evil')
  assert.strictEqual(result.status, 'stopped')
  assert.strictEqual(h.computer.actions.length, 0)
  assert.strictEqual(ev(h.events, 'blocked')[0].kind, 'blocked')
})

test('terminal fail is reported with the model reason', async () => {
  const h = harness([json('cannot', { type: 'fail', reason: 'the page requires a login I do not have' })])
  const result = await h.agent.run('read my private inbox')
  assert.strictEqual(result.status, 'failed')
  assert.match(result.reason, /login/)
})

test('action failures are fed back to the model', async () => {
  const h = harness(
    [json('click', { type: 'click', x: 10, y: 10 }), json('retry elsewhere', { type: 'click', x: 40, y: 40 }), json('done', { type: 'done' })],
    { actResults: [{ ok: false, error: 'element refused the click' }, { ok: true }] }
  )
  const result = await h.agent.run('flaky click')
  assert.strictEqual(result.status, 'done')
  const fails = ev(h.events, 'action:result').filter(r => !r.ok)
  assert.strictEqual(fails.length, 1)
})

/* ---------- context management ----------------------------------------- */

test('only the most recent screenshots are sent as images', async () => {
  const replies = []
  for (let i = 0; i < 6; i++) replies.push(json('move ' + i, { type: 'click', x: 100 + i * 10, y: 100 }))
  replies.push(json('done', { type: 'done' }))
  const h = harness(replies, null, { history: { keepImages: 2 } })
  await h.agent.run('click around')
  const imageCounts = h.model.calls.map(c => c.images)
  assert.ok(imageCounts.every(n => n <= 2), 'images never exceed the budget: ' + imageCounts.join(','))
  assert.strictEqual(imageCounts[imageCounts.length - 1], 2)
})

test('the transcript is available for the side panel', async () => {
  const h = harness([json('click it', { type: 'click', x: 10, y: 10 }), json('done', { type: 'done' })])
  await h.agent.run('small task')
  const t = h.agent.transcript()
  assert.ok(t.some(e => e.kind === 'assistant' && e.thought === 'click it'))
  assert.ok(t.some(e => e.kind === 'observation'))
  assert.strictEqual(h.agent.status().status, 'done')
})

test('run() rejects bad arguments and re-entrancy', async () => {
  const h = harness([json('done', { type: 'done' })])
  await assert.rejects(() => h.agent.run(''), /non-empty string/)
  assert.throws(() => createAgent({ model: {}, computer: {} }), /model/)
  assert.throws(() => createAgent({ model: { next () {} } }), /computer/)
})
