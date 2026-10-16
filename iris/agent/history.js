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
const { extractIds } = require('./memory')

const DEFAULTS = {
  keepImages: 1,
  maxMessages: 40,
  maxSteps: 0,
  maxNotes: 120,
  notesShown: 15,
  maxDigest: 40,
  maxFiles: 400
}

function imagePart (dataUrl) {
  return { type: 'image_url', image_url: { url: dataUrl } }
}

function textPart (text) {
  return { type: 'text', text }
}

const KEEP_KINDS = new Set(['task', 'followup', 'plan'])
const KEEP_FOLLOWUPS = 6 // a repeating run adds one per repeat: only the newest few are pinned

function createHistory (options) {
  const cfg = Object.assign({}, DEFAULTS, options || {})
  let entries = []
  let notes = []
  let files = [] // every file downloaded in this chat, kept compactly for long runs
  let kept = [] // judge decisions: names kept
  let skipped = 0
  let judgedIds = [] // arXiv IDs / DOIs of everything judged, kept or not: never opened again
  let digest = [] // one line per step that fell out of the window
  let digestDropped = 0
  let observationCount = 0
  let sites = {} // host -> { steps, last: thought on that site, order } : where this task has been

  function hostOf (url) {
    const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(String(url || ''))
    return m ? m[1].replace(/^www\./, '').toLowerCase() : ''
  }

  function noteSite (url, thought) {
    const h = hostOf(url)
    if (!h || /^(duckduckgo\.com|www\.google\.|google\.|bing\.com)/.test(h)) return
    const rec = sites[h] || (sites[h] = { steps: 0, last: '', order: 0 })
    rec.steps++
    rec.order = observationCount
    if (thought) rec.last = String(thought).slice(0, 110)
  }

  function remember (e) {
    if (e.kind === 'followup') {
      digest.push('- (earlier message from the user) ' + String(e.text || '').replace(/^New message from the user[^:]*: /, '').slice(0, 140))
      return
    }
    if (e.kind !== 'assistant' || !e.action) return
    const where = e.url ? ' on ' + String(e.url).replace(/^https?:\/\//, '').slice(0, 60) : ''
    digest.push('- ' + prompts.digestLine(e.action, e.thought) + where)
    if (digest.length > cfg.maxDigest) {
      digestDropped += digest.length - cfg.maxDigest
      digest = digest.slice(-cfg.maxDigest)
    }
  }

  /* pinned: the task, the plan and the newest follow-ups; everything else can be summarised away */
  function pinned (e, i) {
    if (!KEEP_KINDS.has(e.kind)) return false
    if (e.kind !== 'followup') return true
    let newer = 0
    for (let j = i + 1; j < entries.length; j++) if (entries[j].kind === 'followup') newer++
    return newer < KEEP_FOLLOWUPS
  }

  function push (entry) {
    entries.push(entry)
    // keep the array bounded: drop the oldest step entries, never the task or follow-ups
    // Compact in one chunk, down to half the window. Dropping one entry per step would
    // change the start of the prompt every time and defeat the server's prompt cache; a
    // chunk keeps the prefix byte-identical for the next maxMessages/2 steps.
    if (entries.length > cfg.maxMessages) {
      const target = Math.floor(cfg.maxMessages / 2)
      while (entries.length > target) {
        const dropIndex = entries.findIndex((e, i) => !pinned(e, i))
        if (dropIndex < 0) break
        remember(entries[dropIndex])
        entries.splice(dropIndex, 1)
      }
    }
    return entry
  }

  return {
    config: cfg,

    start (task) {
      entries = []
      notes = []
      files = []
      kept = []
      skipped = 0
      judgedIds = []
      digest = []
      digestDropped = 0
      observationCount = 0
      sites = {}
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
      const droppable = entries.map((e, i) => pinned(e, i) ? -1 : i).filter(i => i >= 0)
      // always keep the newest observation so the model can still see the page
      const lastObs = entries.map(e => e.kind).lastIndexOf('observation')
      const candidates = droppable.filter(i => i !== lastObs)
      if (candidates.length < 2) return false
      const drop = new Set(candidates.slice(0, Math.ceil(candidates.length / 2)))
      entries.forEach((e, i) => { if (drop.has(i)) remember(e) })
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

    setPlan (text) {
      const existing = entries.find(e => e.kind === 'plan')
      if (existing) {
        // a revised plan replaces the old one in place: it is never lost to compaction
        existing.text = prompts.planText(text)
        existing.plan = text
        return existing
      }
      return push({ kind: 'plan', role: 'user', text: prompts.planText(text), plan: text })
    },

    plan () {
      const e = entries.find(x => x.kind === 'plan')
      return e ? e.plan || null : null
    },

    addVerdict (item, keep, url) {
      if (keep) { if (!kept.includes(item)) kept.push(item) } else skipped++
      extractIds(String(item || '') + ' ' + String(url || '')).forEach(function (id) {
        const short = id.replace(/^arxiv:/, '').replace(/^doi:/, 'doi ')
        if (!judgedIds.includes(short)) judgedIds.push(short)
      })
    },

    decisions () {
      return { kept: kept.slice(), skipped }
    },

    addFile (name) {
      const n = String(name || '').trim()
      if (!n || files.includes(n)) return
      files.push(n)
      if (files.length > cfg.maxFiles) files.shift()
    },

    files () {
      return files.slice()
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
        skills: obs && obs.skills && obs.skills.tips && obs.skills.tips.length ? obs.skills : null,
        dataUrl: obs && obs.dataUrl ? obs.dataUrl : null,
        url: obs && obs.url,
        loading: !!(obs && obs.loading)
      })
    },

    addAssistant (rawText, thought, action, url) {
      noteSite(url, thought)
      return push({ kind: 'assistant', role: 'assistant', text: rawText, thought, action, url })
    },

    digest () {
      return digest.slice()
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
    messages (systemExtra, liveExtra) {
      // systemExtra stays the same from step to step (the server keeps it cached); liveExtra is
      // what changes during a run, so it rides on the newest observation instead
      const obs = entries.filter(e => e.kind === 'observation')
      const withImage = new Set(obs.slice(Math.max(0, obs.length - cfg.keepImages)))
      const newest = obs[obs.length - 1]

      const out = [{ role: 'system', content: prompts.systemPrompt(systemExtra) }]
      // the summary of forgotten steps sits right after the task and plan: it changes only when Iris
      // forgets a chunk of steps (which changes the prompt right there anyway), so the server keeps it
      // cached between those times instead of reading ~2,000 tokens again on every step
      let digestAt = entries.findIndex(e => e.kind !== 'task' && e.kind !== 'plan')
      if (digestAt === -1) digestAt = entries.length

      for (let ei = 0; ei < entries.length; ei++) {
        const e = entries[ei]
        if (ei === digestAt && digest.length) out.push({ role: 'user', content: prompts.digestText(digest, digestDropped) })
        if (e.kind === 'observation') {
          let text = e.text
          if (e === newest) {
            if (e.tabs && e.tabs.length > 1) text += '\n' + prompts.tabsText(e.tabs)
            if (e.skills) text += '\n' + prompts.skillsText(e.skills)
            const visited = Object.keys(sites).map(h => Object.assign({ host: h }, sites[h])).sort((a, b) => b.order - a.order)
            if (visited.length > 1 || (visited[0] && visited[0].host !== hostOf(e.url))) text += '\n' + prompts.sitesText(visited.slice(0, 6), hostOf(e.url))
            if (kept.length || skipped) text += '\n' + prompts.decisionsText(kept, skipped, judgedIds)
            if (files.length) text += '\n' + prompts.filesText(files)
            if (notes.length) text += '\n' + prompts.notesText(notes.slice(-cfg.notesShown), Math.max(0, notes.length - cfg.notesShown))
            const plan = entries.find(x => x.kind === 'plan')
            if (plan) { const r = prompts.planReminder(plan.plan); if (r) text += '\n' + r }
            if (liveExtra) text += '\n' + liveExtra
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
      if (digestAt === entries.length && digest.length) out.push({ role: 'user', content: prompts.digestText(digest, digestDropped) })

      return out
    },

    /** Text-only copy for saving a session (screenshots are dropped). */
    export () {
      return {
        entries: entries.map(e => Object.assign({}, e, { dataUrl: e.dataUrl ? 'omitted' : null })),
        notes: notes.slice(),
        files: files.slice(),
        kept: kept.slice(),
        skipped,
        judgedIds: judgedIds.slice(),
        digest: digest.slice(),
        digestDropped,
        observationCount,
        sites: Object.assign({}, sites)
      }
    },

    import (data) {
      if (!data || !Array.isArray(data.entries)) return this
      entries = data.entries.map(e => Object.assign({}, e))
      notes = Array.isArray(data.notes) ? data.notes.slice() : []
      digest = Array.isArray(data.digest) ? data.digest.slice() : []
      files = Array.isArray(data.files) ? data.files.slice() : []
      kept = Array.isArray(data.kept) ? data.kept.slice() : []
      skipped = data.skipped || 0
      judgedIds = Array.isArray(data.judgedIds) ? data.judgedIds.slice() : []
      digestDropped = data.digestDropped || 0
      observationCount = data.observationCount || entries.filter(e => e.kind === 'observation').length
      sites = data.sites && typeof data.sites === 'object' ? Object.assign({}, data.sites) : {}
      return this
    },

    /** A compact, human/panel-readable transcript. */
    transcript () {
      return entries.map(e => ({
        kind: e.kind,
        text: e.thought || e.text,
        thought: e.thought || null,
        action: e.action || null,
        raw: e.kind === 'assistant' ? e.text : null,
        hasImage: !!e.dataUrl,
        url: e.url || null
      }))
    }
  }
}

module.exports = { createHistory, DEFAULTS }
