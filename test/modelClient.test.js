'use strict'

const test = require('node:test')
const assert = require('node:assert')

const { createModelClient, cleanContent, thinkingFields } = require('../iris/agent/modelClient')

/* A fetch stand-in: records request bodies and answers from a script. Never touches the network. */
function fakeFetch (responders) {
  const calls = []
  const fn = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, body, headers: init.headers })
    const r = responders[Math.min(calls.length - 1, responders.length - 1)]
    return r(body, init)
  }
  fn.calls = calls
  return fn
}

function sseResponse (chunks) {
  const enc = new TextEncoder()
  const stream = new ReadableStream({
    start (controller) {
      for (const c of chunks) controller.enqueue(enc.encode('data: ' + JSON.stringify(c) + '\n\n'))
      controller.enqueue(enc.encode('data: [DONE]\n\n'))
      controller.close()
    }
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

test('thinking levels map to request fields', () => {
  assert.deepStrictEqual(thinkingFields('off'), { chat_template_kwargs: { enable_thinking: false } })
  assert.deepStrictEqual(thinkingFields('low'), { reasoning_effort: 'low' })
  assert.deepStrictEqual(thinkingFields('full'), {})
})

test('streams reasoning and content, reports progress and usage', async () => {
  const fetch = fakeFetch([() => sseResponse([
    { choices: [{ delta: { reasoning_content: 'The button ' } }] },
    { choices: [{ delta: { reasoning_content: 'is top right.' } }] },
    { choices: [{ delta: { content: '{"thought":"t",' } }] },
    { choices: [{ delta: { content: '"action":{"type":"done"}}' } }] },
    { choices: [], usage: { prompt_tokens: 1400, completion_tokens: 40 } }
  ])])
  const client = createModelClient({ baseUrl: 'http://m.test/v1', model: 'q', apiKey: 'k', thinking: 'low', fetch })
  const phases = []
  const r = await client.next({ messages: [{ role: 'user', content: 'hi' }], onProgress: p => phases.push(p.phase) })
  assert.strictEqual(r.content, '{"thought":"t","action":{"type":"done"}}')
  assert.strictEqual(r.reasoning, 'The button is top right.')
  assert.strictEqual(r.usage.prompt_tokens, 1400)
  assert.strictEqual(phases[0], 'waiting')
  const sent = fetch.calls[0]
  assert.strictEqual(sent.url, 'http://m.test/v1/chat/completions')
  assert.strictEqual(sent.body.stream, true)
  assert.strictEqual(sent.body.reasoning_effort, 'low')
  assert.strictEqual(sent.body.max_tokens, 4096)
  assert.strictEqual(sent.headers.Authorization, 'Bearer k')
})

test('a server that rejects reasoning_effort is retried without it, and remembered', async () => {
  const fetch = fakeFetch([
    () => new Response('{"error":{"message":"Unexpected reasoning effort low"}}', { status: 400 }),
    () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  ])
  const client = createModelClient({ baseUrl: 'http://m.test/v1', model: 'q', thinking: 'low', stream: false, fetch })
  const r = await client.next({ messages: [] })
  assert.strictEqual(r.content, 'ok')
  assert.ok('reasoning_effort' in fetch.calls[0].body)
  assert.ok(!('reasoning_effort' in fetch.calls[1].body))
  await client.next({ messages: [] })
  assert.ok(!('reasoning_effort' in fetch.calls[2].body))
})

test('other HTTP errors surface with their detail', async () => {
  const fetch = fakeFetch([() => new Response('model not loaded', { status: 503 })])
  const client = createModelClient({ baseUrl: 'http://m.test/v1', model: 'q', fetch })
  await assert.rejects(() => client.next({ messages: [] }), /503: model not loaded/)
})

test('an aborted request reports "stopped"', async () => {
  const fetch = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e) })
  })
  const client = createModelClient({ baseUrl: 'http://m.test/v1', model: 'q', fetch })
  const ac = new AbortController()
  const p = client.next({ messages: [], signal: ac.signal })
  ac.abort()
  await assert.rejects(() => p, /^Error: stopped$/)
})

test('leaked think blocks are removed from the content', () => {
  assert.strictEqual(cleanContent('<think>hmm</think>{"a":1}'), '{"a":1}')
  assert.strictEqual(cleanContent('plan...</think>\n{"a":1}'), '{"a":1}')
})
