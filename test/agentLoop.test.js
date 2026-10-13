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
  assert.match(h.last, /Your notes so far:\n- price is \$42/)
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
  assert.match(h.last, /Files already downloaded in this chat \(1, never download these again\): paper.pdf/)
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
