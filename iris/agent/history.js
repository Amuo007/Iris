'use strict'

/*
 * iris/agent/history.js
 *
 * The conversation handed to the model on each step.
 *
 * Screenshots are huge, so the history keeps full images only for the most recent
 * `keepImages` observations and replaces older ones with a text marker. Thoughts, actions
 * and outcomes are kept until `maxMessages`, then the oldest steps are dropped — never the
 * task or the user's follow-ups. Facts the model chose to "remember" live outside that
 * window, so a run that lasts hours still knows what it found.
 *
 * Only the newest observation carries the notes and the tab list, so everything before it
 * stays byte-identical from step to step and the server's prompt cache keeps working.
 *
 * Pure.
 */

const prompts = require('./prompts')

const DEFAULTS = {
  keepImages: 1,
  maxMessages: 40,
  maxSteps: 0,
  maxNotes: 60
}

function imagePart (dataUrl) {
  return { type: 'image_url', image_url: { url: dataUrl } }
}

function textPart (text) {
  return { type: 'text', text }
}

const KEEP_KINDS = new Set(['task', 'followup'])

function createHistory (options) {
  const cfg = Object.assign({}, DEFAULTS, options || {})
  let entries = []
  let notes = []
  let observationCount = 0

  function push (entry) {
    entries.push(entry)
    // keep the array bounded: drop the oldest step entries, never the task or follow-ups
    while (entries.length > cfg.maxMessages) {
      const dropIndex = entries.findIndex(e => !KEEP_KINDS.has(e.kind))
      if (dropIndex < 0) break
      entries.splice(dropIndex, 1)
    }
    return entry
  }

  return {
    config: cfg,

    start (task) {
      entries = []
      notes = []
      observationCount = 0
      push({ kind: 'task', role: 'user', text: prompts.taskMessage(task) })
      return this
    },

    /** The user typed another message in the same chat: keep everything, add the new ask. */
    addFollowUp (text) {
      if (!entries.length) return this.start(text)
      push({ kind: 'followup', role: 'user', text: prompts.followUpMessage(text) })
      return this
    },

    /** Drop the older half of the steps (never the task, follow-ups or notes). */
    compact () {
      const droppable = entries.map((e, i) => KEEP_KINDS.has(e.kind) ? -1 : i).filter(i => i >= 0)
      // always keep the newest observation so the model can still see the page
      const lastObs = entries.map(e => e.kind).lastIndexOf('observation')
      const candidates = droppable.filter(i => i !== lastObs)
      if (candidates.length < 2) return false
      const drop = new Set(candidates.slice(0, Math.ceil(candidates.length / 2)))
      entries = entries.filter((e, i) => !drop.has(i))
      return true
    },

    addNote (text) {
      const t = String(text || '').trim()
      if (!t || notes.includes(t)) return
      notes.push(t)
      if (notes.length > cfg.maxNotes) notes.shift()
    },

    notes () {
      return notes.slice()
    },

    addObservation (obs, step) {
      observationCount++
      const extra = []
      if (obs && obs.note) extra.push(obs.note)
      if (obs && obs.loading) extra.push(prompts.loadingWarning(obs))
      return push({
        kind: 'observation',
        index: observationCount,
        text: prompts.observationIntro(obs, step || observationCount, { maxSteps: cfg.maxSteps }) + (extra.length ? '\n' + extra.join('\n') : ''),
        tabs: obs && obs.tabs ? obs.tabs : null,
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
      const obs = entries.filter(e => e.kind === 'observation')
      const withImage = new Set(obs.slice(Math.max(0, obs.length - cfg.keepImages)))
      const newest = obs[obs.length - 1]

      const out = [{ role: 'system', content: prompts.systemPrompt(systemExtra) }]

      for (const e of entries) {
        if (e.kind === 'observation') {
          let text = e.text
          if (e === newest) {
            if (e.tabs && e.tabs.length > 1) text += '\n' + prompts.tabsText(e.tabs)
            if (notes.length) text += '\n' + prompts.notesText(notes)
          }
          const parts = [textPart(text)]
          if (e.dataUrl && withImage.has(e) && e.dataUrl !== 'omitted') parts.push(imagePart(e.dataUrl))
          else if (e.dataUrl) parts.push(textPart('[older screenshot omitted]'))
          out.push({ role: 'user', content: parts })
        } else if (e.kind === 'assistant') {
          out.push({ role: 'assistant', content: e.text })
        } else {
          out.push({ role: 'user', content: e.text })
        }
      }

      return out
    },

    /** Text-only copy for saving a session (screenshots are dropped). */
    export () {
      return {
        entries: entries.map(e => Object.assign({}, e, { dataUrl: e.dataUrl ? 'omitted' : null })),
        notes: notes.slice(),
        observationCount
      }
    },

    import (data) {
      if (!data || !Array.isArray(data.entries)) return this
      entries = data.entries.map(e => Object.assign({}, e))
      notes = Array.isArray(data.notes) ? data.notes.slice() : []
      observationCount = data.observationCount || entries.filter(e => e.kind === 'observation').length
      return this
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
