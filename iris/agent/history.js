'use strict'

/*
 * iris/agent/history.js
 *
 * The conversation handed to the model on each step.
 *
 * Screenshots are huge, so the history keeps full images only for the most recent
 * `keepImages` observations and replaces older ones with a text marker. Thoughts, actions
 * and outcomes are always kept — the model never loses the plot even though it only
 * remembers the last couple of frames visually.
 *
 * Pure.
 */

const prompts = require('./prompts')

const DEFAULTS = {
  keepImages: 2,
  maxMessages: 40
}

function imagePart (dataUrl) {
  return { type: 'image_url', image_url: { url: dataUrl } }
}

function textPart (text) {
  return { type: 'text', text }
}

function createHistory (options) {
  const cfg = Object.assign({}, DEFAULTS, options || {})
  const entries = []
  let observationCount = 0

  function push (entry) {
    entries.push(entry)
    // keep the array bounded: drop the oldest non-essential entries, never the task
    const overflow = entries.length - cfg.maxMessages
    if (overflow > 0) {
      let dropIndex = -1
      for (let i = 1; i < entries.length; i++) {
        if (entries[i].kind === 'observation' || entries[i].kind === 'correction' || entries[i].kind === 'assistant') {
          dropIndex = i
          break
        }
      }
      if (dropIndex > 0) entries.splice(dropIndex, 1)
    }
    return entry
  }

  return {
    config: cfg,

    start (task) {
      entries.length = 0
      observationCount = 0
      push({ kind: 'task', role: 'user', text: prompts.taskMessage(task) })
      return this
    },

    addObservation (obs) {
      observationCount++
      return push({
        kind: 'observation',
        index: observationCount,
        text: prompts.observationIntro(obs, observationCount) + (obs && obs.loading ? '\n' + prompts.loadingWarning(obs) : ''),
        dataUrl: obs && obs.dataUrl ? obs.dataUrl : null,
        url: obs && obs.url,
        loading: !!(obs && obs.loading)
      })
    },

    addAssistant (rawText, thought, action) {
      return push({ kind: 'assistant', role: 'assistant', text: rawText, thought, action })
    },

    addCorrection (error) {
      return push({ kind: 'correction', role: 'user', text: prompts.correctionMessage(error) })
    },

    addFailure (error) {
      return push({ kind: 'failure', role: 'user', text: prompts.failureMessage(error) })
    },

    addTakeover (info) {
      return push({ kind: 'takeover', role: 'user', text: prompts.takeoverMessage(info) })
    },

    addSystemNote (text) {
      return push({ kind: 'note', role: 'user', text })
    },

    observations () {
      return entries.filter(e => e.kind === 'observation')
    },

    length () {
      return entries.length
    },

    /** Render the chat messages for a chat-completions call. */
    messages (systemExtra) {
      const obsIndexes = new Set()
      const obs = entries.filter(e => e.kind === 'observation')
      for (let i = Math.max(0, obs.length - cfg.keepImages); i < obs.length; i++) obsIndexes.add(obs[i])

      const out = [{ role: 'system', content: prompts.systemPrompt(systemExtra) }]

      for (const e of entries) {
        if (e.kind === 'observation') {
          const parts = [textPart(e.text)]
          if (e.dataUrl && obsIndexes.has(e)) {
            parts.push(imagePart(e.dataUrl))
          } else if (e.dataUrl) {
            parts.push(textPart('[screenshot from this step omitted to save context]'))
          }
          out.push({ role: 'user', content: parts })
        } else if (e.kind === 'assistant') {
          out.push({ role: 'assistant', content: e.text })
        } else {
          out.push({ role: 'user', content: e.text })
        }
      }

      return out
    },

    /** A compact, human/panel-readable transcript. */
    transcript () {
      return entries.map(e => ({
        kind: e.kind,
        text: e.thought || e.text,
        thought: e.thought || null,
        action: e.action || null,
        hasImage: !!e.dataUrl,
        url: e.url || null
      }))
    }
  }
}

module.exports = { createHistory, DEFAULTS }
