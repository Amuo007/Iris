'use strict'

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')

const {
  createModelClient,
  probeServer,
  toAnthropicMessages,
  normalizeAnthropicUsage,
  tokensPerSecond
} = require('../iris/agent/modelClient')

/* A fetch stand-in: records requests and answers from a script. Never touches the network. */
function fakeFetch (responders) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null, headers: init.headers || {} })
    const r = responders[Math.min(calls.length - 1, responders.length - 1)]
    return r(calls[calls.length - 1])
  }
  fn.calls = calls
  return fn
}

/* Messages API streaming: `event:` lines plus `data:` lines, as the API sends them */
function anthropicSse (events) {
  const enc = new TextEncoder()
  const stream = new ReadableStream({
    start (controller) {
      for (const e of events) controller.enqueue(enc.encode('event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n'))
      controller.close()
    }
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const SHOT = 'data:image/jpeg;base64,/9j/AAAA'

test('OpenAI-style messages become Messages API turns', () => {
  const conv = toAnthropicMessages([
    { role: 'system', content: 'You are Iris.' },
    { role: 'system', content: 'Rules.' },
    { role: 'user', content: 'Task: apply.' },
    { role: 'user', content: [{ type: 'text', text: 'Step 1.' }, { type: 'image_url', image_url: { url: SHOT } }] },
    { role: 'assistant', content: '{"thought":"x"}' }
  ])
  assert.strictEqual(conv.system, 'You are Iris.\n\nRules.')
  // two user turns merged into one, the screenshot as a base64 image block
  assert.strictEqual(conv.messages[0].role, 'user')
  assert.deepStrictEqual(conv.messages[0].content.map(b => b.type), ['text', 'text', 'image'])
  assert.deepStrictEqual(conv.messages[0].content[2].source, { type: 'base64', media_type: 'image/jpeg', data: '/9j/AAAA' })
  assert.strictEqual(conv.messages[1].role, 'assistant')
  // never ends on an assistant turn (no prefill on current Claude models)
  assert.strictEqual(conv.messages[conv.messages.length - 1].role, 'user')
})

test('a conversation that opens with the assistant still starts with a user turn', () => {
  const conv = toAnthropicMessages([{ role: 'assistant', content: 'hi' }, { role: 'user', content: 'go' }])
  assert.strictEqual(conv.messages[0].role, 'user')
  assert.strictEqual(conv.messages[1].role, 'assistant')
})

test('Claude: request shape, headers and streamed reply', async () => {
  const fetch = fakeFetch([() => anthropicSse([
    { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 1200, cache_read_input_tokens: 300, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'The Apply button.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '{"thought":"t",' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '"action":{"type":"done"}}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } },
    { type: 'message_stop' }
  ])])
  const client = createModelClient({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-opus-5-5', apiKey: 'sk-test', thinking: 'medium', temperature: 0.2, fetch })
  const r = await client.next({ messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: [{ type: 'text', text: 'go' }, { type: 'image_url', image_url: { url: SHOT } }] }] })
  assert.strictEqual(r.content, '{"thought":"t","action":{"type":"done"}}')
  assert.strictEqual(r.reasoning, 'The Apply button.')
  assert.strictEqual(r.usage.prompt_tokens, 1500)
  assert.strictEqual(r.usage.completion_tokens, 42)
  assert.strictEqual(r.usage.prompt_tokens_details.cached_tokens, 300)

  const sent = fetch.calls[0]
  assert.strictEqual(sent.url, 'https://api.anthropic.com/v1/messages')
  assert.strictEqual(sent.headers['x-api-key'], 'sk-test')
  assert.strictEqual(sent.headers['anthropic-version'], '2023-06-01')
  assert.strictEqual(sent.headers.Authorization, undefined)
  assert.strictEqual(sent.body.system, 'sys')
  assert.strictEqual(sent.body.model, 'claude-opus-5-5')
  assert.deepStrictEqual(sent.body.output_config, { effort: 'medium' })
  assert.strictEqual(sent.body.temperature, undefined)
  assert.strictEqual(sent.body.thinking, undefined)
  assert.strictEqual(sent.body.stream, true)
  // a declined request goes to a fallback model on the Claude API
  assert.strictEqual(sent.body.fallbacks, 'default')
  assert.strictEqual(sent.headers['anthropic-beta'], 'server-side-fallback-2026-07-01')
})

test('Claude through another Messages-API server: no fallback field', async () => {
  const fetch = fakeFetch([() => new Response(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } })])
  const client = createModelClient({ provider: 'anthropic', baseUrl: 'https://proxy.example/v1', model: 'claude-opus-5-5', apiKey: 'k', stream: false, fetch })
  const r = await client.next({ messages: [{ role: 'user', content: 'hi' }] })
  assert.strictEqual(r.content, 'ok')
  assert.strictEqual(fetch.calls[0].body.fallbacks, undefined)
  assert.strictEqual(fetch.calls[0].headers['anthropic-beta'], undefined)
})

test('Claude: a server that refuses an optional field gets the request again without it', async () => {
  const fetch = fakeFetch([
    () => new Response('{"type":"error","error":{"type":"invalid_request_error","message":"output_config.effort: Extra inputs are not permitted"}}', { status: 400 }),
    () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } })
  ])
  const client = createModelClient({ provider: 'anthropic', baseUrl: 'https://proxy.example/v1', model: 'claude-haiku-4-5', apiKey: 'k', stream: false, fetch })
  const r = await client.next({ messages: [{ role: 'user', content: 'hi' }] })
  assert.strictEqual(r.content, 'ok')
  assert.ok('output_config' in fetch.calls[0].body)
  assert.ok(!('output_config' in fetch.calls[1].body))
})

test('Claude: a refusal is an error, not an empty answer', async () => {
  const fetch = fakeFetch([() => anthropicSse([
    { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { output_tokens: 0 } }
  ])])
  const client = createModelClient({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-opus-5-5', apiKey: 'k', fetch })
  await assert.rejects(client.next({ messages: [{ role: 'user', content: 'hi' }] }), /declined/)
})

test('Claude: an error event mid-stream is reported', async () => {
  const fetch = fakeFetch([() => anthropicSse([
    { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }
  ])])
  const client = createModelClient({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-opus-5-5', apiKey: 'k', fetch })
  await assert.rejects(client.next({ messages: [{ role: 'user', content: 'hi' }] }), /Overloaded/)
})

test('OpenAI-style cloud API: Bearer key, OpenAI fields, speed from generation time', async () => {
  const enc = new TextEncoder()
  const fetch = fakeFetch([() => new Response(new ReadableStream({
    start (c) {
      c.enqueue(enc.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }) + '\n\n'))
      c.enqueue(enc.encode('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } }) + '\n\n'))
      c.enqueue(enc.encode('data: [DONE]\n\n'))
      c.close()
    }
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })])
  const client = createModelClient({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: 'sk-o', fetch })
  const r = await client.next({ messages: [{ role: 'user', content: 'hi' }] })
  assert.strictEqual(fetch.calls[0].url, 'https://api.openai.com/v1/chat/completions')
  assert.strictEqual(fetch.calls[0].headers.Authorization, 'Bearer sk-o')
  assert.strictEqual(r.usage.completion_tokens, 20)
  assert.ok(typeof r.usage.gen_ms === 'number')
})

test('tokens per second: the server timing first, else output over generation time', () => {
  assert.strictEqual(tokensPerSecond({ completion_tokens: 100, timings: { predicted_per_second: 63.5 } }, 9000), 63.5)
  assert.strictEqual(tokensPerSecond({ completion_tokens: 100, timings: { predicted_n: 100, predicted_ms: 2000 } }, 9000), 50)
  assert.strictEqual(tokensPerSecond({ completion_tokens: 100, gen_ms: 4000 }, 9000), 25)
  assert.strictEqual(tokensPerSecond({ completion_tokens: 90 }, 3000), 30)
  assert.strictEqual(tokensPerSecond({ completion_tokens: 0 }, 3000), null)
  assert.strictEqual(tokensPerSecond(null, 3000), null)
})

test('Messages API usage counts cache reads and writes as input', () => {
  assert.deepStrictEqual(normalizeAnthropicUsage({ input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5, output_tokens: 7 }), {
    prompt_tokens: 105, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 90 }, cache_creation_input_tokens: 5
  })
  assert.strictEqual(normalizeAnthropicUsage(null), null)
})

test('probe: each provider gets its own headers and model list path', async () => {
  const fetch = fakeFetch([() => new Response(JSON.stringify({ data: [{ id: 'claude-opus-5-5' }] }), { status: 200 })])
  const a = await probeServer({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'k', fetch })
  assert.deepStrictEqual(a, { ok: true, models: ['claude-opus-5-5'], windows: {}, contextWindow: 0 })
  assert.strictEqual(fetch.calls[0].url, 'https://api.anthropic.com/v1/models?limit=100')
  assert.strictEqual(fetch.calls[0].headers['x-api-key'], 'k')
  const fetch2 = fakeFetch([() => new Response(JSON.stringify({ data: [{ id: 'q' }] }), { status: 200 })])
  await probeServer({ provider: 'local', baseUrl: 'http://127.0.0.1:1234/v1', apiKey: '', fetch: fetch2 })
  assert.strictEqual(fetch2.calls[0].url, 'http://127.0.0.1:1234/v1/models')
  assert.deepStrictEqual(fetch2.calls[0].headers, {})
})

test('probe: the model\'s context window from its /models entry, then /props, then what is known', async () => {
  // Halogen / vLLM / Lemonade style: the window is on the model entry
  const f1 = fakeFetch([() => new Response(JSON.stringify({ data: [{ id: 'q', context_length: 262144, meta: { n_ctx: 262144 } }, { id: 'other', max_model_len: 32768 }] }), { status: 200 })])
  const r1 = await probeServer({ provider: 'local', baseUrl: 'http://h:8731/v1', model: 'q', fetch: f1 })
  assert.strictEqual(r1.contextWindow, 262144)
  assert.deepStrictEqual(r1.windows, { q: 262144, other: 32768 })
  assert.strictEqual(f1.calls.length, 1)
  // plain llama.cpp: nothing on the entry, so /props at the server root (beside /v1)
  const f2 = fakeFetch([
    () => new Response(JSON.stringify({ data: [{ id: 'q' }] }), { status: 200 }),
    () => new Response(JSON.stringify({ default_generation_settings: { n_ctx: 65536 } }), { status: 200 })
  ])
  const r2 = await probeServer({ provider: 'local', baseUrl: 'http://h:8080/v1/', model: 'q', fetch: f2 })
  assert.strictEqual(f2.calls[1].url, 'http://h:8080/props')
  assert.strictEqual(r2.contextWindow, 65536)
  // Claude: the Models API's max_input_tokens, else the known size; /props is never asked
  const f3 = fakeFetch([() => new Response(JSON.stringify({ data: [{ id: 'claude-opus-5-5', max_input_tokens: 1000000 }] }), { status: 200 })])
  assert.strictEqual((await probeServer({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'k', model: 'claude-opus-5-5', fetch: f3 })).contextWindow, 1000000)
  const f4 = fakeFetch([() => new Response(JSON.stringify({ data: [] }), { status: 200 })])
  assert.strictEqual((await probeServer({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'k', model: 'claude-haiku-4-5', fetch: f4 })).contextWindow, 200000)
  assert.strictEqual(f4.calls.length, 1)
  // an OpenAI-style cloud that states nothing and has no /props: unknown (0), not a guess
  const f5 = fakeFetch([
    () => new Response(JSON.stringify({ data: [{ id: 'gpt-x' }] }), { status: 200 }),
    () => new Response('not found', { status: 404 })
  ])
  assert.strictEqual((await probeServer({ provider: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'gpt-x', fetch: f5 })).contextWindow, 0)
})

/* A real HTTP server on 127.0.0.1 speaking both wire formats, so the client runs over a socket with real SSE framing. */
test('end to end over HTTP: both formats against a local mock server', async () => {
  const seen = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', d => { raw += d })
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null })
      if (req.url === '/v1/messages') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const send = (e) => res.write('event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n')
        send({ type: 'message_start', message: { usage: { input_tokens: 50, output_tokens: 1 } } })
        send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'claude ok' } })
        send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } })
        send({ type: 'message_stop' })
        return res.end()
      }
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'openai ok' } }] }) + '\n\n')
        res.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 2 } }) + '\n\n')
        res.write('data: [DONE]\n\n')
        return res.end()
      }
      res.writeHead(404)
      res.end()
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port + '/v1'
  try {
    const claude = createModelClient({ provider: 'anthropic', baseUrl: base, model: 'claude-opus-5-5', apiKey: 'k' })
    const a = await claude.next({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: SHOT } }] }] })
    assert.strictEqual(a.content, 'claude ok')
    assert.strictEqual(a.usage.prompt_tokens, 50)
    assert.strictEqual(a.usage.completion_tokens, 3)
    assert.strictEqual(seen[0].headers['x-api-key'], 'k')
    assert.strictEqual(seen[0].body.messages[0].content[1].type, 'image')

    const local = createModelClient({ provider: 'local', baseUrl: base, model: 'q' })
    const b = await local.next({ messages: [{ role: 'user', content: 'hi' }] })
    assert.strictEqual(b.content, 'openai ok')
    assert.strictEqual(b.usage.completion_tokens, 2)
    assert.strictEqual(seen[1].headers.authorization, undefined)
  } finally {
    server.close()
  }
})
