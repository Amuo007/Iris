'use strict'

const test = require('node:test')
const assert = require('node:assert')

const { imageTokens, estimate, windowFromModelEntry, knownContextWindow, roundHalfEven, COMPACT_AT } = require('../iris/agent/contextMeter')
const { createHistory } = require('../iris/agent/history')
const { createAgent } = require('../iris/agent/agentLoop')
const { FakeModel, FakeComputer, virtualClock, json } = require('./fakes')

test('a screenshot costs what the model server counts', () => {
  // measured on Halogen (Qwen VL), 2026-10-23: text alone vs text + image
  assert.strictEqual(imageTokens(1024, 536, 'local'), 546)
  assert.strictEqual(imageTokens(800, 400, 'local'), 302)
  // Claude: about one token per 750 pixels
  assert.strictEqual(imageTokens(1024, 536, 'anthropic'), 732)
  assert.strictEqual(imageTokens(0, 536, 'local'), 0)
  assert.strictEqual(roundHalfEven(12.5), 12)
  assert.strictEqual(roundHalfEven(13.5), 14)
  assert.strictEqual(roundHalfEven(16.75), 17)
})

test('the parts add up to the exact total the server reported', () => {
  const layout = { instructions: 2500, tools: 1500, info: 8000, task: 1000, steps: 3000, page: 2000, images: [{ width: 1024, height: 536 }] }
  const c = estimate(layout, { prompt_tokens: 6123, completion_tokens: 88, prompt_tokens_details: { cached_tokens: 5000 } }, { provider: 'local', window: 262144 })
  assert.strictEqual(c.used, 6123)
  assert.strictEqual(c.exact, true)
  assert.strictEqual(c.parts.reduce((a, p) => a + p.tokens, 0), 6123)
  assert.strictEqual(c.screenshot, 546)
  assert.ok(c.parts.find(p => p.key === 'messages').tokens > 546)
  assert.strictEqual(c.window, 262144)
  assert.strictEqual(c.compactAt, Math.round(262144 * COMPACT_AT))
  assert.strictEqual(c.buffer, 262144 - c.compactAt)
  assert.strictEqual(c.free, c.compactAt - 6123)
  assert.ok(Math.abs(c.percent - (6123 / 262144) * 100) < 1e-9)
  assert.strictEqual(c.output, 88)
  assert.strictEqual(c.cached, 5000)
  assert.deepStrictEqual(c.parts.map(p => p.label), ['System prompt', 'Tools', 'Memory', 'Messages'])
})

test('the split of a real job step stays close to the tokenizer', () => {
  // one step of the 10-23 job run, each part counted by Halogen's /tokenize; messages = task 4272 + earlier
  // steps 4949 + the page's text 2416 + the screenshot 546
  const exact = { system: 1603, tools: 1197, memory: 8663, messages: 12183 }
  const layout = { instructions: 6332, tools: 4545, info: 32998, task: 13471, steps: 14362, page: 8870, images: [{ width: 1024, height: 536 }] }
  const total = Object.values(exact).reduce((a, b) => a + b, 0)
  const c = estimate(layout, { prompt_tokens: total }, { provider: 'local', window: 262144 })
  c.parts.forEach(p => {
    const off = Math.abs(p.tokens - exact[p.key]) / exact[p.key]
    assert.ok(off < 0.04, p.key + ' is ' + p.tokens + ', the tokenizer says ' + exact[p.key])
  })
})

test('no window known: no percentage, and a wrong image formula never makes text negative', () => {
  const c = estimate({ instructions: 395, images: [{ width: 4000, height: 4000 }] }, { prompt_tokens: 300 }, {})
  assert.strictEqual(c.window, 0)
  assert.strictEqual(c.percent, null)
  assert.strictEqual(c.free, null)
  assert.ok(c.parts.every(p => p.tokens >= 0))
  assert.strictEqual(c.parts.reduce((a, p) => a + p.tokens, 0), 300)
  // and without usage at all, the estimate still adds up
  const g = estimate({ instructions: 395, images: [] }, null, {})
  assert.strictEqual(g.exact, false)
  assert.strictEqual(g.used, 100)
})

test('context windows from model lists, and the known Claude sizes', () => {
  assert.strictEqual(windowFromModelEntry({ id: 'q', context_length: 262144, meta: { n_ctx: 131072 } }), 131072)
  assert.strictEqual(windowFromModelEntry({ id: 'v', max_model_len: 32768 }), 32768)
  assert.strictEqual(windowFromModelEntry({ id: 'lm', max_context_length: 131072, loaded_context_length: 8192 }), 8192)
  assert.strictEqual(windowFromModelEntry({ id: 'c', max_input_tokens: 1000000 }), 1000000)
  assert.strictEqual(windowFromModelEntry({ id: 'or', top_provider: { context_length: 400000 } }), 400000)
  assert.strictEqual(windowFromModelEntry({ id: 'x' }), 0)
  assert.strictEqual(knownContextWindow('claude-opus-5-5'), 1000000)
  assert.strictEqual(knownContextWindow('claude-sonnet-5-5'), 1000000)
  assert.strictEqual(knownContextWindow('claude-haiku-4-5'), 200000)
  assert.strictEqual(knownContextWindow('gpt-x'), 0)
})

test('history measures every part of the request it builds', () => {
  const h = createHistory({ keepImages: 1 })
  h.start('Find a flight')
  h.setPlan('1. open the site')
  h.addObservation({ url: 'https://a.example', title: 'A', dataUrl: 'data:image/jpeg;base64,AAAA', width: 1024, height: 536 }, 1)
  h.addAssistant('{"thought":"open it","action":{"type":"click","x":1,"y":2}}', 'open it', { type: 'click', x: 1, y: 2 }, 'https://a.example')
  h.addNote('remember the price')
  h.addObservation({ url: 'https://a.example/2', title: 'B', dataUrl: 'data:image/jpeg;base64,BBBB', width: 1024, height: 536 }, 2)
  const sent = h.messages('My info: Ada', 'Project notes: none')
  const layout = h.layout()
  const textLength = sent.reduce((a, m) => a + (typeof m.content === 'string' ? m.content.length
    : m.content.reduce((b, p) => b + (p.type === 'text' ? p.text.length : 0), 0)), 0)
  assert.strictEqual(layout.instructions + layout.tools + layout.info + layout.task + layout.steps + layout.page, textLength)
  assert.ok(layout.tools > 3000, 'the list of actions is counted as tools')
  assert.ok(layout.info >= 'My info: Ada'.length)
  assert.ok(layout.task >= 'Project notes: none'.length)
  assert.deepStrictEqual(layout.images, [{ width: 1024, height: 536 }])
})

test('a nearly full context: Iris forgets its oldest steps before the next request', async () => {
  const clock = virtualClock()
  const replies = []
  for (let i = 0; i < 6; i++) replies.push({ content: json('step ' + i, { type: 'scroll', direction: 'down' }), usage: { prompt_tokens: 9000, completion_tokens: 20 }, ms: 5 })
  replies.push({ content: json('done', { type: 'done', answer: 'ok' }), usage: { prompt_tokens: 3000 }, ms: 5 })
  const events = []
  const agent = createAgent({
    model: new FakeModel(replies),
    computer: new FakeComputer({ width: 1024, height: 640, devicePixelRatio: 1 }),
    delay: clock.delay,
    now: clock.now,
    onEvent: (type, payload) => events.push(Object.assign({ type }, payload)),
    config: { settleDelayMs: 0, markerDwellMs: 0, provider: 'local', contextWindow: () => 10000 }
  })
  const result = await agent.run('scroll a while')
  assert.strictEqual(result.status, 'done')
  const thought = events.find(e => e.type === 'thought')
  assert.strictEqual(thought.context.used, 9000)
  assert.strictEqual(thought.context.window, 10000)
  assert.strictEqual(thought.context.screenshot, imageTokens(1024, 640, 'local'))
  assert.ok(events.some(e => e.type === 'compact' && e.used === 9000 && e.window === 10000))
})
