'use strict'

/*
 * iris/agent/contextMeter.js
 *
 * What fills the model's context window on a step: the panel's Context card.
 *
 * The total is exact: the model server reports how many tokens it read (usage.prompt_tokens).
 * The split (system prompt, tools, memory, messages) is worked out here. The screenshot uses the
 * model's own image formula (from its pixel size); the text parts use their length, and are then
 * scaled so that every part adds up to the exact total.
 *
 * Pure.
 */

// What the panel shows, in the words Claude Code and Codex use. Each is made of measured parts.
const PARTS = [
  { key: 'system', label: 'System prompt', of: ['instructions'] },
  { key: 'tools', label: 'Tools', of: ['tools'] },
  { key: 'memory', label: 'Memory', of: ['info'] },
  { key: 'messages', label: 'Messages', of: ['task', 'steps', 'page', 'images'] }
]

// characters per token of each measured part, from the Qwen tokenizer on a real job run (2026-10-23):
// instructions 3.95, tools 3.80, info 3.81, task 3.15, steps 2.90, this step's page text 3.67
const CHARS_PER_TOKEN = { instructions: 3.95, tools: 3.8, info: 3.8, task: 3.2, steps: 2.9, page: 3.7 }

// Iris forgets its oldest steps before the context gets this full
const COMPACT_AT = 0.85

/* Python's round(): halves go to the even neighbour (what Qwen's image resizer uses) */
function roundHalfEven (x) {
  const f = Math.floor(x)
  const d = x - f
  if (d > 0.5) return f + 1
  if (d < 0.5) return f
  return f % 2 === 0 ? f : f + 1
}

/**
 * Tokens one image costs.
 * Claude: about one token per 750 pixels. Local and other servers: Qwen-VL's 32 px patches
 * (2x2 merged) plus the two vision markers, which is what Halogen reports exactly
 * (1024x536 → 546, 800x400 → 302).
 */
function imageTokens (width, height, provider) {
  const w = Number(width) || 0
  const h = Number(height) || 0
  if (!w || !h) return 0
  if (provider === 'anthropic') return Math.ceil((w * h) / 750)
  return Math.max(1, roundHalfEven(w / 32)) * Math.max(1, roundHalfEven(h / 32)) + 2
}

/**
 * Split one request's context into its parts.
 * layout: characters of { instructions, tools, info, task, steps, page }, images: [{ width, height }]
 * usage:  the reply's usage ({ prompt_tokens, completion_tokens, prompt_tokens_details })
 * opts:   { provider, window }
 */
function estimate (layout, usage, opts) {
  const o = opts || {}
  const l = layout || {}
  const u = usage || {}
  const total = u.prompt_tokens > 0 ? u.prompt_tokens : 0

  let image = 0
  ;(l.images || []).forEach(function (im) { image += imageTokens(im && im.width, im && im.height, o.provider) })

  const guess = {}
  let guessed = 0
  Object.keys(CHARS_PER_TOKEN).forEach(function (k) {
    guess[k] = (Number(l[k]) || 0) / CHARS_PER_TOKEN[k]
    guessed += guess[k]
  })

  // with an exact total, the text shares what the screenshot leaves (a wrong image formula can never
  // push the text below zero)
  if (total) image = Math.min(image, Math.round(total * 0.6))
  const scale = total && guessed > 0 ? (total - image) / guessed : 1
  guess.images = image / (scale || 1)
  const parts = PARTS.map(function (p) {
    const raw = p.of.reduce(function (a, k) { return a + (guess[k] || 0) }, 0)
    return { key: p.key, label: p.label, tokens: Math.round(raw * scale) }
  })
  const sum = parts.reduce(function (a, p) { return a + p.tokens }, 0)
  if (total && sum !== total) {
    // rounding: the biggest part absorbs the last few tokens so the parts add up exactly
    const big = parts.reduce(function (a, p) { return p.tokens > a.tokens ? p : a }, parts[0])
    big.tokens += total - sum
  }

  const used = total || sum
  const window = o.window > 0 ? Math.round(o.window) : 0
  const compactAt = window ? Math.round(window * COMPACT_AT) : 0
  const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0
  return {
    used,
    exact: !!total,
    window,
    percent: window ? Math.min(100, (used / window) * 100) : null,
    // the last 15% is kept free: Iris forgets old steps before it would be needed (Claude Code's "autocompact buffer")
    buffer: window ? window - compactAt : 0,
    free: window ? Math.max(0, compactAt - used) : null,
    compactAt,
    screenshot: image,
    output: u.completion_tokens || 0,
    cached: Math.min(cached, used),
    parts
  }
}

/* the context window a /models entry states (llama.cpp, vLLM, LM Studio, Lemonade, OpenRouter, Claude) */
function windowFromModelEntry (entry) {
  if (!entry || typeof entry !== 'object') return 0
  const meta = entry.meta || {}
  const top = entry.top_provider || {}
  const found = [entry.max_input_tokens, entry.loaded_context_length, meta.n_ctx, entry.context_length, entry.max_model_len,
    entry.max_context_length, entry.context_window, top.context_length, meta.n_ctx_train]
    .map(Number).find(function (n) { return n > 0 })
  return found || 0
}

/* models whose window is known without asking: current Claude models have 1M, Haiku 4.5 and older 200K */
function knownContextWindow (model) {
  const m = String(model || '').toLowerCase()
  if (!/^claude-/.test(m)) return 0
  if (/^claude-(3|haiku-4-5|sonnet-4-5|sonnet-4-0|opus-4-[01]|sonnet-4-20|opus-4-20)/.test(m)) return 200000
  return 1000000
}

module.exports = { PARTS, COMPACT_AT, imageTokens, estimate, windowFromModelEntry, knownContextWindow, roundHalfEven }
