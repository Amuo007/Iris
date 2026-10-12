'use strict'

/*
 * iris/agent/modelClient.js
 *
 * Minimal OpenAI-compatible /v1/chat/completions client that supports image parts.
 * Works in the Electron main process (global fetch) and in Node 18+.
 *
 * IMPORTANT: nothing in this file is ever called by the test suite — tests inject a fake
 * model object with the same `next()` shape.
 */

const DEFAULT_TIMEOUT_MS = 90 * 1000

function joinUrl (baseUrl, path) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  const p = String(path || '').replace(/^\/+/, '')
  if (!base) throw new Error('Iris AI: no model server URL configured')
  if (/^https?:\/\//i.test(path)) return path
  return base + '/' + p
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
  // strip a trailing …</think> reasoning block some chat templates leak
  text = text.replace(/<\|im_start>[\s\S]*?<\|im_end>/g, '').trim() || text.trim()
  return text
}

/**
 * @param {object} config { baseUrl, model, apiKey, temperature, maxTokens, timeoutMs, headers }
 */
function createModelClient (config) {
  const cfg = Object.assign({
    baseUrl: '',
    model: '',
    apiKey: '',
    temperature: 0.2,
    maxTokens: 700,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    headers: {}
  }, config || {})

  const fetchImpl = cfg.fetch || (typeof fetch === 'function' ? fetch : null)

  async function chat (messages, extra) {
    if (!fetchImpl) throw new Error('fetch is not available in this environment')
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    let timer = null
    if (controller) timer = setTimeout(() => controller.abort(), cfg.timeoutMs)

    const body = Object.assign({
      model: cfg.model,
      messages,
      temperature: cfg.temperature,
      max_tokens: cfg.maxTokens,
      stream: false
    }, extra || {})

    const headers = {
      'Content-Type': 'application/json',
      ...cfg.headers
    }
    if (cfg.apiKey) headers.Authorization = 'Bearer ' + cfg.apiKey

    try {
      const res = await fetchImpl(joinUrl(cfg.baseUrl, 'chat/completions'), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined
      })
      if (!res.ok) {
        let detail = ''
        try { detail = (await res.text()).slice(0, 300) } catch (e) { /* ignore */ }
        const err = new Error('model server responded ' + res.status + (detail ? ': ' + detail : ''))
        err.status = res.status
        throw err
      }
      const json = await res.json()
      return normalizeResponse(json)
    } catch (err) {
      if (err && err.name === 'AbortError') throw new Error('model request timed out after ' + cfg.timeoutMs + ' ms')
      throw err
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  return {
    next ({ messages }) {
      return chat(messages)
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

module.exports = { createModelClient, probeServer, normalizeResponse, joinUrl }
