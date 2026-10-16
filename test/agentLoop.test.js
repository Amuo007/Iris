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

test('an unexplained model error is retried, not fatal on the first hit', async () => {
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

test('a repeated ineffective action makes the model change course, without pausing', async () => {
  const same = json('same', { type: 'click', x: 100, y: 100 })
  const h = harness([same, same, same, (ctx) => { h.lastUser = JSON.stringify(ctx.messages.slice(-3)); return json('different approach', { type: 'click', x: 700, y: 300 }) }, json('done', { type: 'done' })], null, {
    safety: { repeatActionLimit: 2 }
  })
  const result = await h.agent.run('stuck')
  assert.strictEqual(result.status, 'done')
  assert.ok(ev(h.events, 'blocked').some(b => b.kind === 'loop'))
  assert.strictEqual(ev(h.events, 'pause:waiting').length, 0)
  assert.match(h.lastUser, /completely different approach/)
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

/* ---------- capture failures, progress, feedback ------------------------ */

test('capture failures do not use up steps', async () => {
  const h = harness([json('ok', { type: 'done', answer: 'seen' })], { failScreenshotTimes: 3 }, { safety: { maxSteps: 1 } })
  const result = await h.agent.run('see it')
  assert.strictEqual(result.status, 'done')
  assert.strictEqual(ev(h.events, 'error').filter(e => e.where === 'screenshot').length, 3)
})

test('a page that can never be captured fails with a clear message', async () => {
  const h = harness([json('ok', { type: 'done' })], { failScreenshotTimes: 99 })
  const result = await h.agent.run('blind')
  assert.strictEqual(result.status, 'failed')
  assert.match(result.reason, /can't see this page/)
  assert.strictEqual(h.model.callCount, 0)
})

test('the model is told when its last action changed nothing', async () => {
  const h = harness([
    json('click', { type: 'click', x: 10, y: 10 }),
    (ctx) => { h.seen = ctx.messages[ctx.messages.length - 1].content[0].text; return json('done', { type: 'done' }) }
  ])
  h.computer.screenshot = function () {
    return { dataUrl: 'data:image/png;base64,AAAA', width: 2880, height: 1800, viewWidth: 1440, viewHeight: 900, devicePixelRatio: 2, url: 'https://x.test/', fingerprint: 'same' }
  }
  await h.agent.run('click something')
  assert.match(h.seen, /did not visibly change the page/)
})

test('object replies carry reasoning and usage to the panel', async () => {
  const h = harness([{ content: json('look', { type: 'done', answer: '42' }), reasoning: 'short plan', usage: { prompt_tokens: 10 }, ms: 5 }])
  const result = await h.agent.run('answer')
  assert.strictEqual(result.answer, '42')
  const t = ev(h.events, 'thought')[0]
  assert.strictEqual(t.reasoning, 'short plan')
  assert.strictEqual(t.usage.prompt_tokens, 10)
})

test('stop aborts a model call that is still running', async () => {
  let aborted = false
  const model = {
    next (ctx) {
      return new Promise((resolve, reject) => {
        ctx.signal.addEventListener('abort', () => { aborted = true; reject(new Error('stopped')) })
      })
    }
  }
  const computer = new FakeComputer()
  const agent = createAgent({ model, computer, config: { settleDelayMs: 0, markerDwellMs: 0 } })
  const running = agent.run('slow model')
  await until(() => agent.status().step === 1, 'first step')
  await new Promise(r => setImmediate(r))
  agent.stop('user pressed stop')
  const result = await running
  assert.strictEqual(result.status, 'stopped')
  assert.ok(aborted)
})

test('a sensitive action pauses, and resume lets exactly that action through', async () => {
  const h = harness([json('order', { type: 'type', text: 'place order now' }), json('done', { type: 'done' })], null, { safety: { allowSensitiveActions: false } })
  const running = h.agent.run('buy it')
  await until(() => h.agent.status().status === 'paused', 'pause for approval')
  assert.strictEqual(ev(h.events, 'blocked')[0].kind, 'confirmation')
  h.model.replies.splice(1, 0, json('order', { type: 'type', text: 'place order now' }))
  h.agent.resume()
  const result = await running
  assert.strictEqual(result.status, 'done')
  assert.deepStrictEqual(h.computer.actions.map(a => a.text), ['place order now'])
})

test('after a takeover, one Resume is enough', async () => {
  const h = harness([json('a', { type: 'click', x: 10, y: 10 }), json('b', { type: 'click', x: 30, y: 30 }), json('done', { type: 'done' })])
  let interacted = false
  const act = h.computer.act.bind(h.computer)
  h.computer.act = function (a) {
    if (!interacted) { interacted = true; this.userInteracts('click') }
    return act(a)
  }
  const running = h.agent.run('takeover mid-run')
  await until(() => h.agent.status().status === 'paused', 'pause after the human clicked')
  h.agent.resume()
  const result = await running
  assert.strictEqual(result.status, 'done')
  assert.strictEqual(ev(h.events, 'pause:waiting').length, 1)
})

/* ---------- batches, follow-ups, notes, close-ups ----------------------- */

test('a batch runs every action from one screenshot with one model call', async () => {
  const h = harness([
    JSON.stringify({ thought: 'log in', actions: [
      { type: 'type', text: 'me@x.com', x: 200, y: 200 },
      { type: 'type', text: '{{Password}}', x: 200, y: 300, enter: true }
    ] }),
    json('done', { type: 'done', answer: 'logged in' })
  ])
  const result = await h.agent.run('log in')
  assert.strictEqual(result.status, 'done')
  assert.strictEqual(h.model.callCount, 2)
  assert.deepStrictEqual(h.computer.actions.map(a => [a.text, a.x, a.y]), [['me@x.com', 100, 100], ['{{Password}}', 100, 150]])
})

test('a follow-up keeps the conversation and starts a fresh step budget', async () => {
  const h = harness([json('first', { type: 'done', answer: 'A' }), (ctx) => { h.msgs = ctx.messages; return json('second', { type: 'done', answer: 'B' }) }], null, { safety: { maxSteps: 1 } })
  assert.strictEqual((await h.agent.run('first question')).answer, 'A')
  const second = await h.agent.run('and then?', { followUp: true })
  assert.strictEqual(second.status, 'done')
  assert.strictEqual(second.answer, 'B')
  const texts = h.msgs.map(m => typeof m.content === 'string' ? m.content : m.content.map(p => p.text || '').join(' ')).join('\n')
  assert.match(texts, /Task: first question/)
  assert.match(texts, /New message from the user.*and then\?/)
})

test('remembered notes are shown on later steps', async () => {
  const h = harness([
    JSON.stringify({ thought: 'found it', remember: 'price is $42', action: { type: 'scroll', direction: 'down' } }),
    (ctx) => { h.last = ctx.messages[ctx.messages.length - 1].content[0].text; return json('done', { type: 'done' }) }
  ])
  await h.agent.run('research')
  assert.match(h.last, /Your notes:\n- price is \$42/)
  assert.deepStrictEqual(h.agent.notes(), ['price is $42'])
})

test('clicks on a close-up land at the right place on the page', async () => {
  const h = harness([json('click the tiny link', { type: 'click', x: 640, y: 400 }), json('done', { type: 'done' })])
  h.computer.screenshot = function () {
    return { dataUrl: 'data:image/jpeg;base64,AA', width: 1280, height: 800, viewWidth: 640, viewHeight: 400, devicePixelRatio: 2, crop: { x: 300, y: 200, width: 640, height: 400 }, url: 'https://x.test/' }
  }
  await h.agent.run('tiny link')
  assert.deepStrictEqual([h.computer.actions[0].x, h.computer.actions[0].y], [620, 400])
})

test('history can be exported without screenshots and restored', async () => {
  const h = harness([json('look', { type: 'done', answer: 'ok' })])
  await h.agent.run('save me')
  const saved = JSON.parse(JSON.stringify(h.agent.exportHistory()))
  assert.ok(saved.entries.every(e => e.dataUrl === null || e.dataUrl === 'omitted'))
  const h2 = harness([(ctx) => { h2.msgs = ctx.messages; return json('again', { type: 'done' }) }])
  h2.agent.importHistory(saved)
  await h2.agent.run('continue please', { followUp: true })
  assert.ok(h2.msgs.some(m => typeof m.content === 'string' && /Task: save me/.test(m.content)))
})

test('a restarting model server is waited for, without using up steps or retries', async () => {
  let calls = 0
  const h = harness([], null, { safety: { maxSteps: 2, maxRetriesPerStep: 1 } })
  h.model.next = function () {
    calls++
    if (calls <= 6) return Promise.reject(new Error('cannot reach the model server at http://x'))
    return json('back', { type: 'done', answer: 'ok' })
  }
  const result = await h.agent.run('survive a restart')
  assert.strictEqual(result.status, 'done')
  assert.strictEqual(ev(h.events, 'error').filter(e => e.where === 'server').length, 6)
})

test('a server that stays down long enough ends the run with a clear reason', async () => {
  const h = harness([], null, { config: { settleDelayMs: 0, markerDwellMs: 0, maxServerWaitMs: 60000 } })
  h.model.next = function () { return Promise.reject(new Error('cannot reach the model server at http://x')) }
  const result = await h.agent.run('server gone')
  assert.strictEqual(result.status, 'failed')
  assert.match(result.reason, /unreachable/)
})

test('a full context drops old steps first, then explains if that is not enough', async () => {
  const replies = []
  for (let i = 0; i < 6; i++) replies.push(json('move ' + i, { type: 'scroll', direction: 'down', amount: 1, x: 10, y: 10 + i }))
  const h = harness(replies)
  let overflowed = false
  const next = h.model.next.bind(h.model)
  h.model.next = function (ctx) {
    if (h.model.index >= 6 && !overflowed) { overflowed = true; return Promise.reject(new Error('request (4204 tokens) exceeds the available context size (4096 tokens)')) }
    if (overflowed && h.model.index >= 6) return Promise.reject(new Error('request (4204 tokens) exceeds the available context size (4096 tokens)'))
    return next(ctx)
  }
  const result = await h.agent.run('long scroll')
  assert.strictEqual(result.status, 'failed')
  assert.match(result.reason, /context window is too small/)
  assert.ok(ev(h.events, 'error').some(e => e.where === 'context'))
})

test('steps that fall out of the window are kept as a one-line summary', async () => {
  const replies = []
  for (let i = 0; i < 30; i++) replies.push(json('reading item ' + i, { type: 'scroll', direction: 'down', amount: 1, x: 10, y: 10 + i }))
  replies.push((ctx) => { h.last = ctx.messages[ctx.messages.length - 1].content[0].text; h.count = ctx.messages.length; return json('done', { type: 'done' }) })
  const h = harness(replies, null, { history: { maxMessages: 12 }, safety: { maxSteps: 100 } })
  const sizes = []
  const next = h.model.next.bind(h.model)
  h.model.next = function (ctx) { sizes.push(ctx.messages.length); return next(ctx) }
  await h.agent.run('long research')
  assert.match(h.last, /Earlier steps \(summary/)
  assert.match(h.last, /Scroll down/)
  assert.ok(Math.max.apply(null, sizes) <= 14, 'the conversation itself stays small: ' + Math.max.apply(null, sizes))
  // compaction happens in chunks, so most steps keep the same prefix (prompt cache hits)
  let shrinks = 0
  for (let i = 1; i < sizes.length; i++) if (sizes[i] < sizes[i - 1]) shrinks++
  assert.ok(shrinks <= sizes.length / 3, 'compacted in chunks, not every step: ' + shrinks + ' of ' + sizes.length)
})

test('finished downloads are listed on every later step', async () => {
  const h = harness([json('download', { type: 'click', x: 10, y: 10 }), (ctx) => { h.last = ctx.messages[ctx.messages.length - 1].content[0].text; return json('done', { type: 'done' }) }])
  let n = 0
  const shot = h.computer.screenshot.bind(h.computer)
  h.computer.screenshot = function () {
    const o = shot()
    if (++n === 2) { o.note = 'Downloaded "paper.pdf" (1.2 MB) to the Downloads folder.'; o.files = ['paper.pdf'] }
    return o
  }
  await h.agent.run('get the paper')
  assert.match(h.last, /Downloaded "paper.pdf"/)
  assert.match(h.last, /Downloaded in this chat so far: 1 file \(latest: paper.pdf\)/)
  assert.deepStrictEqual(h.agent.exportHistory().files, ['paper.pdf'])
})

test('ask_user pauses with the question and the answer reaches the model', async () => {
  const h = harness([json('need the code', { type: 'ask_user', question: 'What is the 6-digit code from your phone?' }), (ctx) => { h.msgs = JSON.stringify(ctx.messages); return json('done', { type: 'done' }) }])
  const running = h.agent.run('log in with 2FA')
  await until(() => h.agent.status().status === 'paused', 'pause for the question')
  assert.strictEqual(ev(h.events, 'ask')[0].question, 'What is the 6-digit code from your phone?')
  h.agent.answer('482913')
  const result = await running
  assert.strictEqual(result.status, 'done')
  assert.match(h.msgs, /The user says: 482913/)
})

test('a learned tip is emitted, and site skills are shown on the newest step only', async () => {
  const h = harness([
    JSON.stringify({ thought: 'search url', learn: 'Search directly with /search?q=TERM', action: { type: 'scroll', direction: 'down' } }),
    (ctx) => { h.msgs = ctx.messages; return json('done', { type: 'done' }) }
  ])
  const shot = h.computer.screenshot.bind(h.computer)
  h.computer.screenshot = function () { return Object.assign(shot(), { skills: { site: 'example.com', tips: ['PDF button is top right'] } }) }
  await h.agent.run('use skills')
  assert.strictEqual(ev(h.events, 'learn')[0].tip, 'Search directly with /search?q=TERM')
  const texts = h.msgs.filter(m => Array.isArray(m.content)).map(m => m.content[0].text)
  assert.strictEqual(texts.filter(t => /What you learned before on example.com/.test(t)).length, 1)
  assert.match(texts[texts.length - 1], /PDF button is top right/)
})

test('only the latest notes are shown; older ones are left to recall', async () => {
  const replies = []
  for (let i = 0; i < 20; i++) replies.push(JSON.stringify({ thought: 't' + i, remember: 'fact number ' + i, action: { type: 'scroll', direction: 'down', amount: 1, x: 5, y: 5 + i } }))
  replies.push((ctx) => { h.last = ctx.messages[ctx.messages.length - 1].content[0].text; return json('done', { type: 'done' }) })
  const h = harness(replies, null, { safety: { maxSteps: 100 } })
  await h.agent.run('many notes')
  assert.match(h.last, /latest 15; 5 older ones: use recall/)
  assert.ok(!/fact number 0\b/.test(h.last))
  assert.match(h.last, /fact number 19/)
})

/* ---------- plan first, judge, check-ins ------------------------------- */

test('plan first: one planning call, the plan stays at the top, then normal steps', async () => {
  const plan = 'Goal: find good papers\nGood result means: about harness generation\nHow: search arXiv\nDone when: 3 kept'
  const h = harness([
    (ctx) => { h.planCtx = ctx; return plan },
    (ctx) => { h.firstStep = ctx.messages; return JSON.stringify({ thought: 'look', actions: [{ type: 'judge', item: 'P', keep: true, why: 'fits' }, { type: 'done', answer: 'ok' }] }) }
  ])
  const result = await h.agent.run('find me a few good papers on harnesses', { plan: true })
  assert.strictEqual(result.status, 'done')
  assert.strictEqual(h.planCtx.thinking, 'low', 'Quick plans think lightly')
  assert.ok(!JSON.stringify(h.planCtx.messages).includes('image_url'), 'the plan call has no screenshot')
  assert.strictEqual(ev(h.events, 'plan')[0].text, plan)
  assert.match(h.firstStep[2].content, /Your plan[\s\S]*Done when: 3 kept/)
  assert.strictEqual(result.steps, 1, 'planning is not a step')
})

test('judge records decisions without touching the page and shows a running tally', async () => {
  const h = harness([
    JSON.stringify({ thought: 'read it', actions: [
      { type: 'judge', item: 'Paper A', keep: true, why: 'about fuzz harnesses' },
      { type: 'judge', item: 'Paper B', keep: false, why: 'unrelated' }
    ] }),
    (ctx) => { h.last = ctx.messages[ctx.messages.length - 1].content[0].text; return json('done', { type: 'done' }) }
  ])
  await h.agent.run('choose papers')
  assert.strictEqual(h.computer.actions.length, 0)
  assert.deepStrictEqual(ev(h.events, 'verdict').map(v => [v.item, v.keep]), [['Paper A', true], ['Paper B', false]])
  assert.match(h.last, /kept 1 \(Paper A\), skipped 1/)
})

test('a planned run gets a check-in every reviewEvery steps', async () => {
  const replies = ['Goal: x\nHow: y\nDone when: z']
  for (let i = 0; i < 6; i++) replies.push(json('s' + i, { type: 'scroll', direction: 'down', amount: 1, x: 5, y: 5 + i }))
  replies.push(json('done', { type: 'done' }))
  const h = harness(replies, null, { config: { settleDelayMs: 0, markerDwellMs: 0, reviewEvery: 3 } })
  const seen = []
  const next = h.model.next.bind(h.model)
  h.model.next = function (ctx) { seen.push(JSON.stringify(ctx.messages)); return next(ctx) }
  await h.agent.run('loose task', { plan: true })
  assert.ok(seen.some(m => /Check-in: compare your progress with the plan/.test(m)))
})

test('a planned run that tries to finish without judging anything is sent back once', async () => {
  const h = harness([
    'Goal: x\nGood result means: y\nHow: z\nDone when: 2 kept',
    json('done already', { type: 'done', answer: 'from memory' }),
    (ctx) => { h.msgs = JSON.stringify(ctx.messages); return JSON.stringify({ thought: 'read it', actions: [{ type: 'judge', item: 'Paper A', keep: true, why: 'fits' }, { type: 'done', answer: 'Paper A' }] }) }
  ])
  const result = await h.agent.run('find good papers', { plan: true })
  assert.strictEqual(result.status, 'done')
  assert.strictEqual(result.answer, 'Paper A')
  assert.match(h.msgs, /Not finished yet: you have not judged any candidate/)
  assert.strictEqual(ev(h.events, 'finish:check').length, 1)
})

test('planning may ask a short quiz first; the answers shape the plan', async () => {
  const quiz = JSON.stringify({ questions: [{ q: 'Which kind of harness?', options: ['Fuzzing harnesses', 'Test harnesses', 'LLM eval harnesses'] }] })
  const h = harness([
    quiz,
    (ctx) => { h.second = JSON.stringify(ctx.messages); return 'Goal: fuzzing harness papers\nGood result means: generates harnesses\nHow: arXiv\nDone when: 5 kept' },
    JSON.stringify({ thought: 'ok', actions: [{ type: 'judge', item: 'A', keep: true, why: 'fits' }, { type: 'done', answer: 'A' }] })
  ])
  const running = h.agent.run('papers for generating harnesses', { plan: true })
  await until(() => ev(h.events, 'questions').length === 1 && h.agent.status().status === 'paused', 'quiz to be shown')
  assert.strictEqual(ev(h.events, 'questions')[0].questions[0].options.length, 3)
  h.agent.answer('Which kind of harness? → Fuzzing harnesses')
  const result = await running
  assert.strictEqual(result.status, 'done')
  assert.match(h.second, /The user answered your questions:[\s\S]*Fuzzing harnesses/)
  assert.match(ev(h.events, 'plan')[0].text, /The user said: Which kind of harness\? → Fuzzing harnesses/)
})

test('update_plan replaces the plan in place and it survives compaction', async () => {
  const replies = ['Goal: old plan\nDone when: 1 kept', JSON.stringify({ thought: 'learned more', action: { type: 'update_plan', plan: 'Goal: NEW plan\nDone when: 2 kept' } })]
  for (let i = 0; i < 12; i++) replies.push(json('s' + i, { type: 'scroll', direction: 'down', amount: 1, x: 5, y: 5 + i }))
  replies.push((ctx) => { h.msgs = JSON.stringify(ctx.messages); return JSON.stringify({ thought: 'k', actions: [{ type: 'judge', item: 'X', keep: true }, { type: 'done', answer: 'X' }] }) })
  const h = harness(replies, null, { history: { maxMessages: 8 }, safety: { maxSteps: 100 } })
  await h.agent.run('loose task', { plan: true })
  assert.match(h.msgs, /Goal: NEW plan/)
  assert.ok(!/Goal: old plan/.test(h.msgs))
})

/* ---------- Smart mode look-ups ----------------------------------------- */

test('Smart planning can look things up first; results go back to the planner, then the plan', async () => {
  const asked = []
  const lookup = async (req) => { asked.push(req); return { ok: true, text: 'Web search for "' + req.query + '": 1. Ski Shop — https://ski.test', count: 1 } }
  const h = harness([
    (ctx) => { h.first = ctx; return JSON.stringify({ lookups: [{ kind: 'web', query: 'best ski boots 2026 reddit' }] }) },
    (ctx) => { h.second = ctx; return 'Goal: pick boots\nStart at: https://ski.test\nDone when: 3 kept' },
    json('look', { type: 'done', answer: 'ok' })
  ], {}, { lookup })
  await h.agent.run('which ski boots should I buy', { plan: 'quick', noQuestions: true })
  assert.deepStrictEqual(asked, [{ kind: 'web', query: 'best ski boots 2026 reddit' }])
  assert.match(h.first.messages[0].content, /look things up before planning/)
  const last = h.second.messages[h.second.messages.length - 1].content
  assert.match(last, /Look-up results:[\s\S]*ski\.test[\s\S]*Now write the plan \(no more look-ups\)/)
  assert.match(ev(h.events, 'plan')[0].text, /Start at: https:\/\/ski\.test/)
  assert.strictEqual(ev(h.events, 'lookup').length, 1)
})

test('Quick planning gets one round of look-ups, Deep gets two', async () => {
  const lookup = async (req) => ({ ok: true, text: 'r ' + req.query, count: 1 })
  const more = () => JSON.stringify({ lookups: [{ kind: 'web', query: 'again' }] })
  const quick = harness([more, more, 'Goal: q\nDone when: x', json('look', { type: 'done', answer: 'ok' })], {}, { lookup })
  await quick.agent.run('t', { plan: 'quick', noQuestions: true })
  assert.strictEqual(ev(quick.events, 'lookup').length, 1, 'quick: the second request for look-ups is not served')
  const deep = harness([more, more, more, 'Goal: d\nDone when: x', json('look', { type: 'done', answer: 'ok' })], {}, { lookup })
  await deep.agent.run('t', { plan: 'deep', noQuestions: true })
  assert.strictEqual(ev(deep.events, 'lookup').length, 2)
})

test('without a lookup function the planner is never offered look-ups', async () => {
  const h = harness([(ctx) => { h.ctx = ctx; return 'Goal: g\nDone when: d' }, json('look', { type: 'done', answer: 'ok' })])
  await h.agent.run('t', { plan: true, noQuestions: true })
  assert.ok(!/look things up/.test(h.ctx.messages[0].content))
})

test('the lookup action returns text on the next step and has a per-task budget', async () => {
  let n = 0
  const lookup = async () => { n++; return { ok: true, text: 'RESULT ' + n, count: 1 } }
  const look = json('check fast', { type: 'lookup', kind: 'wiki', query: 'Eiffel Tower height' })
  const h = harness([look, look, (ctx) => { h.ctx = ctx; return json('done', { type: 'done', answer: '330 m' }) }], {}, { lookup, config: { settleDelayMs: 0, markerDwellMs: 0, runLookups: 1 } })
  const result = await h.agent.run('how tall is the Eiffel Tower')
  assert.strictEqual(result.status, 'done')
  assert.strictEqual(n, 1)
  const text = JSON.stringify(h.ctx.messages)
  assert.match(text, /RESULT 1/)
  assert.match(text, /used all 1 look-ups/)
})

test('a planned run repeats its goal on every step', async () => {
  const h = harness(['Goal: find 3 boots\nHow: shops\nDone when: 3 kept', (ctx) => { h.ctx = ctx; return json('d', { type: 'done', answer: 'x' }) }])
  await h.agent.run('boots', { plan: true, noQuestions: true })
  const last = h.ctx.messages[h.ctx.messages.length - 1].content.find(p => p.type === 'text').text
  assert.match(last, /Remember the plan — Goal: find 3 boots \| Done when: 3 kept/)
})

test('the newest step lists the sites already tried, with the last thought on each', async () => {
  const h = harness([
    json('LiftmyCV needs a login', { type: 'navigate', url: 'https://b.test/' }),
    (ctx) => { h.ctx = ctx; return json('d', { type: 'done', answer: 'x' }) }
  ], { url: 'https://a.test/jobs' })
  const urls = ['https://a.test/jobs', 'https://b.test/']
  let i = 0
  const orig = h.computer.screenshot.bind(h.computer)
  h.computer.screenshot = () => Object.assign(orig(), { url: urls[Math.min(i++, 1)] })
  await h.agent.run('jobs')
  const last = h.ctx.messages[h.ctx.messages.length - 1].content.find(p => p.type === 'text').text
  assert.match(last, /Sites in this task[\s\S]*a\.test: 1 step; "LiftmyCV needs a login"/)
})

test('three steps before the limit Iris is told to report what it has', async () => {
  const replies = [0, 1, 2].map(() => json('scroll', { type: 'scroll', direction: 'down' }))
  replies.push((ctx) => { h.ctx = ctx; return json('d', { type: 'done', answer: 'partial' }) })
  const h = harness(replies, {}, { safety: { maxSteps: 4 } })
  await h.agent.run('long task')
  assert.match(JSON.stringify(h.ctx.messages), /Only 1 step left/)
})

test('an answer on the last steps is accepted even if nothing was judged', async () => {
  const h = harness(['Goal: g\nDone when: 3 kept', json('s', { type: 'scroll', direction: 'down' }), json('final', { type: 'done', answer: 'partial: one job' })], {}, { safety: { maxSteps: 2 } })
  const r = await h.agent.run('find jobs', { plan: true, noQuestions: true })
  assert.strictEqual(r.status, 'done')
  assert.strictEqual(r.answer, 'partial: one job')
})

test('a repeating chat keeps only the newest follow-ups pinned', () => {
  const { createHistory } = require('../iris/agent/history')
  const h = createHistory({ maxMessages: 10 })
  h.start('check the price')
  for (let i = 1; i <= 30; i++) {
    h.addFollowUp('Do the task again now (repeat ' + i + ')')
    h.addAssistant(json('t', { type: 'wait' }), 't', { type: 'wait', ms: 1 }, 'https://a.test')
  }
  const kinds = h.messages().map(m => m.content)
  const follow = kinds.filter(c => typeof c === 'string' && /repeat \d+/.test(c) && /^New message/.test(c))
  assert.ok(follow.length <= 8, 'old follow-ups are summarised, not pinned forever (' + follow.length + ')')
  assert.ok(follow.some(c => /repeat 30\b/.test(c)), 'the newest one is kept')
})

test('in a non-stop run an unanswered question times out and Iris carries on', async () => {
  const h = harness([
    json('captcha', { type: 'ask_user', question: 'Please solve the CAPTCHA' }),
    (ctx) => { h.ctx = ctx; return json('moving on', { type: 'done', answer: 'skipped that site' }) }
  ], {}, { config: { settleDelayMs: 0, markerDwellMs: 0, askTimeoutMs: 600000 } })
  const r = await h.agent.run('collect prices')
  assert.strictEqual(r.status, 'done')
  assert.match(JSON.stringify(h.ctx.messages), /did not answer within 10 minutes/)
  assert.strictEqual(ev(h.events, 'ask:timeout').length, 1)
})

test('without a timeout a question waits for the user', async () => {
  const h = harness([json('ask', { type: 'ask_user', question: 'Which size?' }), json('d', { type: 'done', answer: 'M' })])
  const running = h.agent.run('buy a shirt')
  await until(() => h.agent.status().status === 'paused', 'paused on the question')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.strictEqual(h.agent.status().status, 'paused')
  h.agent.answer('M')
  assert.strictEqual((await running).status, 'done')
})

test('the final answer is checked: details Iris never saw are taken out', async () => {
  const answer = 'Booked Hiawatha 331, Chicago to Denver on Nov 12, 08:00 to 16:30, seat 2A, $29 total.'
  const scroll = () => json('s', { type: 'scroll', direction: 'down' })
  const h = harness([scroll(), scroll(), scroll(), scroll(),
    json('ready', { type: 'done', answer }),
    (ctx) => { h.checkCtx = ctx; return JSON.stringify({ unsupported: ['08:00 to 16:30'], answer: 'Booked Hiawatha 331, Chicago to Denver on Nov 12, seat 2A, $29 total.' }) }
  ])
  const r = await h.agent.run('book a train')
  assert.strictEqual(r.answer, 'Booked Hiawatha 331, Chicago to Denver on Nov 12, seat 2A, $29 total.')
  assert.strictEqual(h.checkCtx.thinking, 'off')
  assert.ok(JSON.stringify(h.checkCtx.messages).includes('image_url'), 'the checker sees the last screenshot')
  assert.deepStrictEqual(ev(h.events, 'answer:checked')[0].removed, ['08:00 to 16:30'])
})

test('a checker reply that throws most of the answer away is ignored', async () => {
  const answer = 'The cheapest flight is Frontier at 6:30 AM for $183; next are American, United and Southwest at $317.'
  const scroll = () => json('s', { type: 'scroll', direction: 'down' })
  const h = harness([scroll(), scroll(), scroll(), scroll(), json('done', { type: 'done', answer }), JSON.stringify({ unsupported: ['$317'], answer: 'Frontier.' })])
  const r = await h.agent.run('cheapest flight')
  assert.strictEqual(r.answer, answer)
})

test('short answers without numbers are not checked', async () => {
  const h = harness([json('done', { type: 'done', answer: 'Done, the page is open.' })])
  await h.agent.run('open the page')
  assert.strictEqual(h.model.callCount, 1)
})
