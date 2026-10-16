'use strict'

/*
 * iris/agent/modelClient.js
 *
 * OpenAI-compatible /v1/chat/completions client with image parts and streaming.
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

  function buildBody (messages, thinking) {
    const level = thinking || cfg.thinking
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
    const headers = Object.assign({ 'Content-Type': 'application/json' }, cfg.headers)
    if (cfg.apiKey) headers.Authorization = 'Bearer ' + cfg.apiKey
    return fetchImpl(joinUrl(cfg.baseUrl, 'chat/completions'), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal
    })
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
        const dropped = ['reasoning_effort', 'chat_template_kwargs', 'stream_options'].find(k => k in body && detail.indexOf(k === 'reasoning_effort' ? 'reasoning' : k) !== -1)
        if (res.status === 400 && dropped && !refused.has(dropped)) {
          refused.add(dropped)
          continue
        }
        const err = new Error('model server responded ' + res.status + (detail ? ': ' + detail : ''))
        err.status = res.status
        throw err
      }

      if (!cfg.stream || !res.body || !(res.headers.get('content-type') || '').includes('event-stream')) {
        const json = await res.json()
        const msg = (json.choices && json.choices[0] && json.choices[0].message) || {}
        return {
          content: normalizeResponse(json),
          reasoning: msg.reasoning_content || '',
          usage: json.usage || null,
          ms: Date.now() - started
        }
      }

      let content = ''
      let reasoning = ''
      let usage = null
      let lastTick = 0
      progress({ phase: 'waiting', reasoningChars: 0, contentChars: 0 })
      await readSse(res.body, function (json) {
        if (json.usage) usage = json.usage
        if (json.error) throw new Error('model server error: ' + (json.error.message || JSON.stringify(json.error)).slice(0, 300))
        const delta = json.choices && json.choices[0] && json.choices[0].delta
        if (!delta) return
        if (delta.reasoning_content) reasoning += delta.reasoning_content
        if (delta.content) content += delta.content
        const now = Date.now()
        if (now - lastTick > 250) {
          lastTick = now
          progress({ phase: content ? 'answering' : 'thinking', reasoningChars: reasoning.length, contentChars: content.length, reasoning })
        }
      })
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

/** Cheap reachability probe used by the settings page ("Test connection"). */
async function probeServer (config) {
  const fetchImpl = config.fetch || (typeof fetch === 'function' ? fetch : null)
  if (!fetchImpl) return { ok: false, error: 'fetch unavailable' }
  try {
    const res = await fetchImpl(joinUrl(config.baseUrl, 'models'), {
      headers: config.apiKey ? { Authorization: 'Bearer ' + config.apiKey } : {},
      signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined
    })
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status }
    const json = await res.json()
    const ids = Array.isArray(json.data) ? json.data.map(m => m.id) : []
    return { ok: true, models: ids }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

module.exports = { createModelClient, probeServer, normalizeResponse, cleanContent, thinkingFields, joinUrl, readSse, MAX_TOKENS_BY_THINKING }
