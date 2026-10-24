'use strict'

/*
 * iris/agent/contextMeter.js
 *
 * What fills the model's context window on a step: the panel's Context card.
 *
 * The total is exact: the model server reports how many tokens it read (usage.prompt_tokens).
 * The split into parts is worked out here. The screenshot uses the model's own image formula
 * (from its pixel size); the text parts use their length, and are then scaled so that every
 * part adds up to the exact total.
 *
 * Pure.
 */

// characters per token of each part, measured with the Qwen tokenizer on a real job run
// (2026-10-23): instructions 3.88, info 3.81, task 3.15, steps 2.90, this step 3.67
const PARTS = [
  { key: 'instructions', label: 'Iris instructions', charsPerToken: 3.9 },
  { key: 'info', label: 'Your info & rules', charsPerToken: 3.8 },
  { key: 'task', label: 'Task & plan', charsPerToken: 3.2 },
  { key: 'steps', label: 'Earlier steps', charsPerToken: 2.9 },
  { key: 'page', label: 'This step', charsPerToken: 3.7 },
  { key: 'screenshot', label: 'Screenshot' }
]

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
 * layout: { instructions, info, task, steps, page } in characters, images: [{ width, height }]
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
  PARTS.forEach(function (p) {
    if (!p.charsPerToken) return
    guess[p.key] = (Number(l[p.key]) || 0) / p.charsPerToken
    guessed += guess[p.key]
  })

  // with an exact total, the text parts share what the screenshot leaves (a wrong image formula
  // can never push the text below zero)
  if (total) image = Math.min(image, Math.round(total * 0.6))
  const scale = total && guessed > 0 ? (total - image) / guessed : 1
  const parts = PARTS.map(function (p) {
    return { key: p.key, label: p.label, tokens: p.key === 'screenshot' ? image : Math.round(guess[p.key] * scale) }
  })
  const sum = parts.reduce(function (a, p) { return a + p.tokens }, 0)
  if (total && sum !== total) {
    // rounding: the biggest part absorbs the last few tokens so the parts add up exactly
    const big = parts.reduce(function (a, p) { return p.tokens > a.tokens ? p : a }, parts[0])
    big.tokens += total - sum
  }

  const used = total || sum
  const window = o.window > 0 ? Math.round(o.window) : 0
  const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0
  return {
    used,
    exact: !!total,
    window,
    percent: window ? Math.min(100, (used / window) * 100) : null,
    free: window ? Math.max(0, window - used) : null,
    compactAt: window ? Math.round(window * COMPACT_AT) : 0,
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
