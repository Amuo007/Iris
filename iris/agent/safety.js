'use strict'

/*
 * iris/agent/safety.js
 *
 * Every stop condition in one place, so "why did the agent stop?" always has an answer.
 * The agent loop asks check() before each model call and before each action.
 *
 * This module is pure: no Electron, no DOM.
 */

const DEFAULTS = {
  maxSteps: 40,
  maxWallClockMs: 20 * 60 * 1000,
  maxModelMsPerStep: 180 * 1000,
  maxRetriesPerStep: 3,
  maxConsecutiveFailures: 3,
  repeatActionLimit: 3,
  // the only thing Iris never does is run code in a page: it acts through the screen like a person
  blockSchemes: ['javascript:'],
  blockHosts: [],
  allowSensitiveActions: true,
  // payments: 'ask' = once card details were typed, pause before the click that pays;
  // 'auto' = no pause. (With payments off, card details are never available to type.)
  paymentGuard: 'ask',
  // job applications: 'ask' = pause before the click that submits one (the user reviews it first)
  applicationGuard: 'auto'
}

/* A card placeholder from My info → Payments, e.g. {{Card number}} */
const CARD_PLACEHOLDER = /\{\{\s*(card|cvc|cvv|expiry|name on card|billing)/i

/* What the step means to do, in the model's own words: pay, order, buy, book… */
const PAY_WORDS = /\b(pay|payment|place (your |the |my )?order|purchase|buy|checkout|check out|subscribe|book now|complete (the |my )?(order|purchase|booking)|confirm (the |my )?(order|purchase|booking|payment)|submit (the |my )?(order|payment))\b/i

/* The step means to send off a job application (not a search box or a filter) */
const APPLY_WORDS = /\b(submit|send|complete|finish)\b[^.]{0,30}\bappl(ication|y)\b|\bapply now\b|\bsubmit\b(?![^.]{0,25}\b(search|query|filter|code|email address|look-?up)\b)/i

/* Words that mean "this action is about to touch money, credentials or destruction". */
const SENSITIVE_PATTERNS = [
  /\b(purchase|buy now|checkout|place order|wire transfer)\b/i,
  /\b(?:\d[ -]?){13,19}\b/, // looks like a card number
  /\b(send|submit)\b[^\n]{0,40}\b(password|otp|verification code)\b/i,
  /\bdrop table\b/i
]

/* Actions whose repetition is normal progress, as long as the page keeps changing. */
const REPEATABLE = new Set(['scroll', 'wait', 'key'])

function normalizeUrl (url) {
  return String(url || '').trim().toLowerCase()
}

function isBlockedUrl (url, safety) {
  const u = normalizeUrl(url)
  if (!u) return { blocked: false }
  for (const scheme of safety.blockSchemes) {
    if (u.startsWith(scheme)) return { blocked: true, reason: `navigation to "${scheme}" URLs is not allowed` }
  }
  for (const host of safety.blockHosts) {
    if (u.includes(host.toLowerCase())) return { blocked: true, reason: `"${host}" is on the block list` }
  }
  return { blocked: false }
}

function normalizeActionKey (action) {
  return JSON.stringify(action)
}

/**
 * A stateful stop-gate. Call note() as the loop progresses and check() at decision points.
 */
function createSafetyGate (options) {
  const cfg = Object.assign({}, DEFAULTS, options || {})
  let startedAt = typeof cfg.now === 'function' ? cfg.now() : Date.now()

  let steps = 0
  let modelCalls = 0
  let retries = 0
  let consecutiveFailures = 0
  const recentActions = []
  let cardTyped = false

  function decision (kind, reason, extra) {
    return Object.assign({ allow: false, kind, reason }, extra || {})
  }

  return {
    config: cfg,

    /** Called once per loop iteration, before asking the model. */
    beforeStep () {
      steps++
      if (cfg.maxSteps > 0 && steps > cfg.maxSteps) {
        return decision('steps', `Reached the limit of ${cfg.maxSteps} steps for this task.`)
      }
      const elapsed = (cfg.now ? cfg.now() : Date.now()) - startedAt
      if (cfg.maxWallClockMs > 0 && elapsed > cfg.maxWallClockMs) {
        return decision('time', `Task exceeded the ${Math.round(cfg.maxWallClockMs / 1000)}s time budget.`)
      }
      return { allow: true, step: steps, elapsedMs: elapsed }
    },

    /** Start counting again for a follow-up message in the same chat. */
    reset () {
      steps = 0
      modelCalls = 0
      retries = 0
      consecutiveFailures = 0
      recentActions.length = 0
      cardTyped = false
      startedAt = cfg.now ? cfg.now() : Date.now()
    },

    /** A step that never reached the model (e.g. the screenshot failed) is not charged. */
    refundStep () {
      if (steps > 0) steps--
    },

    /** Called immediately before every model request. */
    beforeModelCall () {
      modelCalls++
      return { allow: true, modelCalls }
    },

    noteRetry (error) {
      retries++
      consecutiveFailures++
      if (retries > cfg.maxRetriesPerStep) {
        return decision('retries', `Gave up after ${cfg.maxRetriesPerStep} unusable responses in a row${error ? ` (last: ${error})` : ''}.`)
      }
      if (consecutiveFailures > cfg.maxConsecutiveFailures) {
        return decision('failures', `Stopped after ${cfg.maxConsecutiveFailures} consecutive failures.`)
      }
      return { allow: true, retries }
    },

    noteSuccess () {
      retries = 0
      consecutiveFailures = 0
    },

    /** Called after an action is validated and mapped, before it is injected. */
    beforeAction (action, pageState) {
      if (action.type === 'navigate') {
        const b = isBlockedUrl(action.url, cfg)
        if (b.blocked) return decision('blocked', b.reason)
      }

      const key = normalizeActionKey(action)
      recentActions.push(key)
      if (recentActions.length > 16) recentActions.shift()

      let streak = 0
      for (let i = recentActions.length - 1; i >= 0; i--) {
        if (recentActions[i] === key) streak++
        else break
      }
      // scrolling down a long page is the same action many times; only a frozen page is a loop
      const counts = !REPEATABLE.has(action.type) || (pageState && pageState.pageUnchanged)
      if (counts && streak > cfg.repeatActionLimit) {
        return decision('loop', `The same action (${action.type}) had no effect ${streak} times in a row — pausing for you to check.`, { action, key })
      }

      if (action.type === 'type' && CARD_PLACEHOLDER.test(action.text || '')) cardTyped = true
      // the user approves "the payment", not exact pixels: the next pay click after Resume goes through
      if (cfg.paymentGuard !== 'auto' && cardTyped && !(pageState && pageState.approved === 'payment') &&
          (action.type === 'click' || action.type === 'double_click' || (action.type === 'key' && action.key === 'enter') || (action.type === 'type' && action.enter)) &&
          PAY_WORDS.test((pageState && pageState.thought) || '')) {
        return decision('confirmation', 'Iris is about to pay: "' + String(pageState.thought).slice(0, 160) + '". Press ▶ to allow it, or Stop.', { action, key: 'payment', payment: true })
      }

      if (cfg.applicationGuard === 'ask' && !(pageState && pageState.approved === 'application') &&
          (action.type === 'click' || action.type === 'double_click' || (action.type === 'key' && action.key === 'enter') || (action.type === 'type' && action.enter)) &&
          APPLY_WORDS.test((pageState && pageState.thought) || '')) {
        return decision('confirmation', 'Iris is about to submit an application: "' + String(pageState.thought).slice(0, 160) + '". Check it, then press ▶ to submit, or Stop.', { action, key: 'application' })
      }

      if (!cfg.allowSensitiveActions && !(pageState && pageState.approved === key)) {
        for (const re of SENSITIVE_PATTERNS) {
          if (re.test(action.text || '') || re.test(action.url || '') || re.test(action.answer || '')) {
            return decision('confirmation', `Paused before a sensitive action (${action.type}). Review it and press Resume to allow it.`, { action, key })
          }
        }
      }

      if (pageState && pageState.pausedByUser) {
        return decision('takeover', 'Paused because you interacted with the page.', { action })
      }

      return { allow: true }
    },

    snapshot () {
      return {
        steps,
        modelCalls,
        retries,
        consecutiveFailures,
        elapsedMs: (cfg.now ? cfg.now() : Date.now()) - startedAt,
        limits: {
          maxSteps: cfg.maxSteps,
          maxWallClockMs: cfg.maxWallClockMs,
          maxRetriesPerStep: cfg.maxRetriesPerStep,
          maxConsecutiveFailures: cfg.maxConsecutiveFailures,
          repeatActionLimit: cfg.repeatActionLimit
        }
      }
    }
  }
}

module.exports = { createSafetyGate, DEFAULTS, isBlockedUrl, SENSITIVE_PATTERNS, REPEATABLE, APPLY_WORDS }
