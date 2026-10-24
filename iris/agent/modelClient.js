'use strict'

/*
 * iris/agent/modelClient.js
 *
 * Model client with image parts and streaming, for two wire formats:
 *   provider 'openai'    (also 'local') — OpenAI-style /v1/chat/completions: local servers
 *                        (llama.cpp, LM Studio, Ollama, Lemonade, Halogen) and cloud APIs that
 *                        speak it (OpenAI, OpenRouter, …)
 *   provider 'anthropic' — Claude Messages API /v1/messages (x-api-key + anthropic-version)
 * Iris builds OpenAI-style messages everywhere; for Claude they are turned into Messages API
 * content blocks here, and both kinds of reply come back in one shape.
 * Works in the Electron main process (global fetch) and in Node 18+.
 *
 * Streaming matters for a local model: the panel can show "thinking… 6s" while tokens
 * arrive, a stop press aborts the request at once, and long prefills never look like a
 * dead connection.
 *
 * Thinking levels (`thinking`):
 *   'off'     chat_template_kwargs.enable_thinking = false   (fastest)
 *   'low'     reasoning_effort = 'low'                       (default: short plan, ~7 s/step)
 *   'medium'  reasoning_effort = 'medium'
 *   'full'    nothing sent: the model's own default
 * If a server rejects one of those fields (HTTP 400 naming it), the client retries once
 * without it and remembers, so cloud APIs and other local servers keep working.
 *
 * Tests inject a fake model with the same `next()` shape; `fetch` can be injected too.
 */

const contextMeter = require('./contextMeter')

const DEFAULT_TIMEOUT_MS = 180 * 1000

const MAX_TOKENS_BY_THINKING = {
  off: 1024,
  low: 4096,
  medium: 8192,
  full: 16384
}

function joinUrl (baseUrl, path) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  const p = String(path || '').replace(/^\/+/, '')
  if (!base) throw new Error('Iris AI: no model server URL configured')
  if (/^https?:\/\//i.test(path)) return path
  return base + '/' + p
}

/* Strip reasoning blocks some chat templates leak into the visible content. */
function cleanContent (text) {
  const t = String(text || '')
  const stripped = t
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/^[\s\S]*?<\/think>/, '')
    .replace(/<\|im_start\|>[\s\S]*?<\|im_end\|>/g, '')
    .trim()
  return stripped || t.trim()
}

function normalizeResponse (json) {
  const choice = json && Array.isArray(json.choices) && json.choices[0]
  if (!choice) {
    const err = new Error('model server returned no choices')
    err.detail = JSON.stringify(json).slice(0, 400)
    throw err
  }
  let text = ''
  if (choice.message && typeof choice.message.content === 'string') text = choice.message.content
  else if (typeof choice.text === 'string') text = choice.text
  else if (choice.message && Array.isArray(choice.message.content)) {
    text = choice.message.content.map(p => (typeof p === 'string' ? p : (p.text || ''))).join('')
  }
  return cleanContent(text)
}

/** Fields a given thinking level adds to the request body. */
function thinkingFields (level) {
  switch (level) {
    case 'off': return { chat_template_kwargs: { enable_thinking: false } }
    case 'low': return { reasoning_effort: 'low' }
    case 'medium': return { reasoning_effort: 'medium' }
    default: return {}
  }
}

const ANTHROPIC_VERSION = '2023-06-01'

/* 'local' is an OpenAI-style server on the user's own machine or network */
function wireFormat (provider) {
  return provider === 'anthropic' ? 'anthropic' : 'openai'
}

/* Iris thinking level → Claude effort (current Claude models always think; effort sets how much) */
const EFFORT_BY_THINKING = { off: 'low', low: 'low', medium: 'medium', full: 'high' }
const ANTHROPIC_MAX_TOKENS_BY_THINKING = { off: 8000, low: 16000, medium: 32000, full: 64000 }

/* Claude models that take the server-side refusal fallback (Claude API only) */
function anthropicFallbackModel (model) {
  return /^claude-(opus-5-5|opus-5|fable-5-1|sonnet-5-5)$/.test(String(model || ''))
}

function textOf (content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(function (p) { return typeof p === 'string' ? p : (p && p.type === 'text' ? p.text || '' : '') }).join('')
}

/* one OpenAI-style content part → Messages API blocks */
function anthropicBlocks (content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  const out = []
  for (const p of content) {
    if (typeof p === 'string') { if (p) out.push({ type: 'text', text: p }); continue }
    if (!p) continue
    if (p.type === 'text') { if (p.text) out.push({ type: 'text', text: p.text }); continue }
    if (p.type === 'image_url' || p.type === 'image') {
      const url = typeof p.image_url === 'string' ? p.image_url : (p.image_url && p.image_url.url) || p.url || ''
      const m = /^data:([^;,]+);base64,(.*)$/s.exec(url)
      if (m) out.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } })
      else if (/^https?:\/\//i.test(url)) out.push({ type: 'image', source: { type: 'url', url: url } })
    }
  }
  return out
}

/**
 * OpenAI-style messages → { system, messages } for the Messages API: system messages become the
 * top-level system prompt, turns of the same role are merged (the Messages API alternates user and
 * assistant), the first turn is a user turn and the last one too (no assistant prefill).
 */
function toAnthropicMessages (messages) {
  const system = []
  const out = []
  for (const m of messages || []) {
    if (!m) continue
    if (m.role === 'system') { const t = textOf(m.content); if (t) system.push(t); continue }
    const role = m.role === 'assistant' ? 'assistant' : 'user'
    const blocks = anthropicBlocks(m.content)
    if (!blocks.length) continue
    const last = out[out.length - 1]
    if (last && last.role === role) last.content = last.content.concat(blocks)
    else out.push({ role: role, content: blocks })
  }
  if (!out.length || out[0].role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(start)' }] })
  if (out[out.length - 1].role !== 'user') out.push({ role: 'user', content: [{ type: 'text', text: 'Continue.' }] })
  return { system: system.join('\n\n'), messages: out }
}

/* Messages API usage → the OpenAI-style names the rest of Iris reads (input counts cache reads and writes) */
function normalizeAnthropicUsage (u) {
  if (!u) return null
  const cached = u.cache_read_input_tokens || 0
  const written = u.cache_creation_input_tokens || 0
  return {
    prompt_tokens: (u.input_tokens || 0) + cached + written,
    completion_tokens: u.output_tokens || 0,
    prompt_tokens_details: { cached_tokens: cached },
    cache_creation_input_tokens: written
  }
}

/** Output tokens per second of one reply: the server's own count when it sends one, else tokens / generation time. */
function tokensPerSecond (usage, ms) {
  if (!usage) return null
  const tm = usage.timings
  if (tm && tm.predicted_per_second) return tm.predicted_per_second
  if (tm && tm.predicted_n && tm.predicted_ms) return tm.predicted_n / (tm.predicted_ms / 1000)
  const out = usage.completion_tokens || 0
  const gen = usage.gen_ms || ms || 0
  return out && gen > 0 ? out / (gen / 1000) : null
}

/**
 * Read an SSE body chunk by chunk. Calls onEvent(json) for every `data:` line.
 * Works with WHATWG streams (fetch in Node/Electron).
 */
async function readSse (body, onEvent) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '')
      buffer = buffer.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      let json
      try { json = JSON.parse(data) } catch (e) { continue }
      onEvent(json)
    }
  }
}

/**
 * @param {object} config { baseUrl, model, apiKey, temperature, maxTokens, timeoutMs,
 *                          thinking, stream, headers, fetch }
 */
function createModelClient (config) {
  const cfg = Object.assign({
    provider: 'openai', // openai | local | anthropic
    baseUrl: '',
    model: '',
    apiKey: '',
    temperature: 0.2,
    maxTokens: 0, // 0 = pick from the thinking level
    timeoutMs: DEFAULT_TIMEOUT_MS,
    thinking: 'low',
    stream: true,
    headers: {}
  }, config || {})

  const fetchImpl = cfg.fetch || (typeof fetch === 'function' ? fetch : null)
  // fields the server refused once; never sent again by this client
  const refused = new Set()

  const format = wireFormat(cfg.provider)

  function levelOf (thinking) {
    // 'auto' is decided per step by the agent loop; a call without its own level thinks a little
    return (thinking && thinking !== 'auto') ? thinking : (cfg.thinking === 'auto' ? 'low' : cfg.thinking)
  }

  /* Claude: no temperature (current models reject sampling settings), effort instead of a thinking switch */
  function buildAnthropicBody (messages, thinking) {
    const level = levelOf(thinking)
    const conv = toAnthropicMessages(messages)
    const body = {
      model: cfg.model,
      max_tokens: cfg.maxTokens || ANTHROPIC_MAX_TOKENS_BY_THINKING[level] || 16000,
      messages: conv.messages,
      stream: !!cfg.stream
    }
    if (conv.system) body.system = conv.system
    if (!refused.has('output_config')) body.output_config = { effort: EFFORT_BY_THINKING[level] || 'low' }
    // a declined request is answered by a fallback model instead of stopping (Claude API only)
    if (!refused.has('fallbacks') && anthropicFallbackModel(cfg.model) && /^https:\/\/api\.anthropic\.com\b/i.test(cfg.baseUrl)) body.fallbacks = 'default'
    return body
  }

  function buildBody (messages, thinking) {
    if (format === 'anthropic') return buildAnthropicBody(messages, thinking)
    const level = levelOf(thinking)
    const body = {
      model: cfg.model,
      messages,
      temperature: cfg.temperature,
      max_tokens: cfg.maxTokens || MAX_TOKENS_BY_THINKING[level] || 4096,
      stream: !!cfg.stream
    }
    if (cfg.stream && !refused.has('stream_options')) body.stream_options = { include_usage: true }
    const extra = thinkingFields(level)
    for (const k of Object.keys(extra)) {
      if (!refused.has(k)) body[k] = extra[k]
    }
    return body
  }

  async function post (body, signal) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, format === 'anthropic' ? anthropicHeaders(cfg.apiKey) : {}, cfg.headers)
    if (format === 'anthropic' && body.fallbacks) headers['anthropic-beta'] = 'server-side-fallback-2026-07-01'
    if (format !== 'anthropic' && cfg.apiKey) headers.Authorization = 'Bearer ' + cfg.apiKey
    return fetchImpl(joinUrl(cfg.baseUrl, format === 'anthropic' ? 'messages' : 'chat/completions'), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal
    })
  }

  /* a Messages API reply, streamed (SSE events) or whole */
  async function readAnthropic (res, started, progress) {
    const declined = function (stop) {
      if (stop === 'refusal') throw new Error('the model declined this request (refusal)')
    }
    if (!cfg.stream || !res.body || !(res.headers.get('content-type') || '').includes('event-stream')) {
      const json = await res.json()
      if (json && json.type === 'error') throw new Error('model server error: ' + ((json.error && json.error.message) || JSON.stringify(json)).slice(0, 300))
      declined(json && json.stop_reason)
      const blocks = (json && Array.isArray(json.content)) ? json.content : []
      return {
        content: cleanContent(blocks.filter(b => b && b.type === 'text').map(b => b.text || '').join('')),
        reasoning: blocks.filter(b => b && b.type === 'thinking').map(b => b.thinking || '').join(''),
        usage: normalizeAnthropicUsage(json && json.usage),
        ms: Date.now() - started
      }
    }
    let content = ''
    let reasoning = ''
    let startUsage = null
    let outputTokens = 0
    let stop = null
    let firstToken = 0
    let lastTick = 0
    progress({ phase: 'waiting', reasoningChars: 0, contentChars: 0 })
    await readSse(res.body, function (json) {
      if (json.type === 'error') throw new Error('model server error: ' + ((json.error && json.error.message) || JSON.stringify(json.error)).slice(0, 300))
      if (json.type === 'message_start' && json.message) startUsage = json.message.usage || null
      if (json.type === 'content_block_start' && !firstToken) firstToken = Date.now()
      if (json.type === 'content_block_delta' && json.delta) {
        if (json.delta.type === 'text_delta') content += json.delta.text || ''
        if (json.delta.type === 'thinking_delta') reasoning += json.delta.thinking || ''
      }
      if (json.type === 'message_delta') {
        if (json.usage && json.usage.output_tokens != null) outputTokens = json.usage.output_tokens
        if (json.delta && json.delta.stop_reason) stop = json.delta.stop_reason
      }
      const now = Date.now()
      if (now - lastTick > 250) {
        lastTick = now
        progress({ phase: content ? 'answering' : 'thinking', reasoningChars: reasoning.length, contentChars: content.length, reasoning })
      }
    })
    declined(stop)
    const usage = normalizeAnthropicUsage(Object.assign({}, startUsage || {}, { output_tokens: outputTokens }))
    usage.ttft_ms = firstToken ? firstToken - started : null
    usage.gen_ms = firstToken ? Date.now() - firstToken : null
    return { content: cleanContent(content), reasoning, usage, ms: Date.now() - started }
  }

  /**
   * One completion. Returns { content, reasoning, usage, ms }.
   * opts.onProgress({ phase: 'waiting'|'thinking'|'answering', reasoningChars, contentChars })
   * opts.signal aborts the request (stop button).
   */
  async function chat (messages, opts) {
    if (!fetchImpl) throw new Error('fetch is not available in this environment')
    const o = opts || {}
    const started = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('timeout')), cfg.timeoutMs)
    const onOuterAbort = () => controller.abort(new Error('stopped'))
    if (o.signal) {
      if (o.signal.aborted) onOuterAbort()
      else o.signal.addEventListener('abort', onOuterAbort, { once: true })
    }
    const progress = typeof o.onProgress === 'function' ? o.onProgress : function () {}

    try {
      let res
      for (let attempt = 0; attempt < 3; attempt++) {
        const body = buildBody(messages, o.thinking)
        res = await post(body, controller.signal)
        if (res.ok) break
        let detail = ''
        try { detail = (await res.text()).slice(0, 400) } catch (e) { /* ignore */ }
        // a server that does not understand an optional field: drop it and try again
        const optional = format === 'anthropic' ? ['output_config', 'fallbacks'] : ['reasoning_effort', 'chat_template_kwargs', 'stream_options']
        const dropped = optional.find(k => k in body && detail.indexOf(k === 'reasoning_effort' ? 'reasoning' : k === 'output_config' ? 'effort' : k) !== -1)
        if (res.status === 400 && dropped && !refused.has(dropped)) {
          refused.add(dropped)
          continue
        }
        const err = new Error('model server responded ' + res.status + (detail ? ': ' + detail : ''))
        err.status = res.status
        throw err
      }

      if (format === 'anthropic') return await readAnthropic(res, started, progress)

      if (!cfg.stream || !res.body || !(res.headers.get('content-type') || '').includes('event-stream')) {
        const json = await res.json()
        const msg = (json.choices && json.choices[0] && json.choices[0].message) || {}
        // llama.cpp adds its own timings (prompt_ms = prefill, predicted_ms = generation)
        const usage0 = json.usage ? Object.assign({}, json.usage, json.timings ? { timings: json.timings } : {}) : null
        return {
          content: normalizeResponse(json),
          reasoning: msg.reasoning_content || '',
          usage: usage0,
          ms: Date.now() - started
        }
      }

      let content = ''
      let reasoning = ''
      let usage = null
      let lastTick = 0
      progress({ phase: 'waiting', reasoningChars: 0, contentChars: 0 })
      let firstToken = 0
      let timings = null
      await readSse(res.body, function (json) {
        if (json.usage) usage = json.usage
        if (json.timings) timings = json.timings
        if (json.error) throw new Error('model server error: ' + (json.error.message || JSON.stringify(json.error)).slice(0, 300))
        const delta = json.choices && json.choices[0] && json.choices[0].delta
        if (!delta) return
        if (!firstToken && (delta.reasoning_content || delta.content)) firstToken = Date.now()
        if (delta.reasoning_content) reasoning += delta.reasoning_content
        if (delta.content) content += delta.content
        const now = Date.now()
        if (now - lastTick > 250) {
          lastTick = now
          progress({ phase: content ? 'answering' : 'thinking', reasoningChars: reasoning.length, contentChars: content.length, reasoning })
        }
      })
      // time to the first token (prefill as the user feels it) and the server's own timings, when it sends them
      // gen_ms: first token to the end, so tokens per second leaves the prefill out
      if (usage) usage = Object.assign({}, usage, { ttft_ms: firstToken ? firstToken - started : null, gen_ms: firstToken ? Date.now() - firstToken : null }, timings ? { timings: timings } : {})
      return { content: cleanContent(content), reasoning, usage, ms: Date.now() - started }
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.name === 'TimeoutError' || controller.signal.aborted)) {
        const why = controller.signal.reason && controller.signal.reason.message
        if (why === 'stopped') throw new Error('stopped')
        throw new Error('the model did not answer within ' + Math.round(cfg.timeoutMs / 1000) + ' s')
      }
      if (err && /fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|ETIMEDOUT|UND_ERR/i.test(err.message + (err.cause ? ' ' + err.cause.code : ''))) {
        // keep the low-level reason (refused, reset, timed out): it tells a network blip from a server restart
        throw new Error('cannot reach the model server at ' + cfg.baseUrl + (err.cause && err.cause.code ? ' (' + err.cause.code + ')' : ''))
      }
      throw err
    } finally {
      clearTimeout(timer)
      if (o.signal) o.signal.removeEventListener('abort', onOuterAbort)
    }
  }

  return {
    next (ctx) {
      return chat(ctx.messages, { onProgress: ctx.onProgress, signal: ctx.signal, thinking: ctx.thinking })
    },
    chat,
    config: cfg
  }
}

function anthropicHeaders (apiKey) {
  const h = { 'anthropic-version': ANTHROPIC_VERSION }
  if (apiKey) h['x-api-key'] = apiKey
  return h
}

/** Cheap reachability probe used by the settings page ("Test connection"): GET /models in either format. */
async function probeServer (config) {
  const fetchImpl = config.fetch || (typeof fetch === 'function' ? fetch : null)
  if (!fetchImpl) return { ok: false, error: 'fetch unavailable' }
  try {
    const anthropic = wireFormat(config.provider) === 'anthropic'
    const res = await fetchImpl(joinUrl(config.baseUrl, anthropic ? 'models?limit=100' : 'models'), {
      headers: anthropic ? anthropicHeaders(config.apiKey) : (config.apiKey ? { Authorization: 'Bearer ' + config.apiKey } : {}),
      signal: AbortSignal.timeout ? AbortSignal.timeout(config.timeoutMs || 8000) : undefined
    })
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status }
    const json = await res.json()
    const list = Array.isArray(json.data) ? json.data : []
    const ids = list.map(m => m.id)
    // each model's context window, where the server says it (most local servers and Claude do; OpenAI does not)
    const windows = {}
    list.forEach(m => { const n = contextMeter.windowFromModelEntry(m); if (m.id && n) windows[m.id] = n })
    let contextWindow = config.model ? windows[config.model] || 0 : 0
    if (!contextWindow && config.model && !anthropic) contextWindow = await serverContextSize(fetchImpl, config.baseUrl)
    if (!contextWindow) contextWindow = contextMeter.knownContextWindow(config.model)
    return { ok: true, models: ids, windows, contextWindow }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

/* llama.cpp's /props (at the server root, beside /v1) states the context it was started with */
async function serverContextSize (fetchImpl, baseUrl) {
  try {
    const root = String(baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '')
    const res = await fetchImpl(joinUrl(root, 'props'), { signal: AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined })
    if (!res.ok) return 0
    const json = await res.json()
    const gen = json.default_generation_settings || {}
    return Number(gen.n_ctx) || Number(json.n_ctx) || 0
  } catch (e) {
    return 0
  }
}

module.exports = {
  createModelClient,
  probeServer,
  serverContextSize,
  normalizeResponse,
  cleanContent,
  thinkingFields,
  joinUrl,
  readSse,
  toAnthropicMessages,
  normalizeAnthropicUsage,
  tokensPerSecond,
  wireFormat,
  MAX_TOKENS_BY_THINKING
}
