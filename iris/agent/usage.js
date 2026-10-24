'use strict'

/*
 * iris/agent/usage.js
 *
 * Token use, kept per day (as before), per session and per project, with the output speed of
 * each model: what Settings → Usage shows and what the panel's status line reads.
 *
 * One store object, saved as iris-usage.json:
 *   days:     { 'YYYY-MM-DD': { tasks, requests, input, output, ms, lookups } }
 *   sessions: { <id>: { title, project, provider, model, requests, input, output, cached, ms, genMs, genOut, first, last } }
 *   projects: { <id>: { name, requests, input, output, cached, ms, genMs, genOut, last } }
 * genMs / genOut add up only the replies whose generation time is known, so their ratio is a true
 * tokens-per-second figure (prefill time left out).
 */

const MAX_SESSIONS = 200

function dayKey (d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

function emptyStore () {
  return { days: {}, sessions: {}, projects: {} }
}

/* an older file (days only) or a damaged one still loads */
function normalizeStore (store) {
  const s = store && typeof store === 'object' ? store : {}
  return {
    days: s.days && typeof s.days === 'object' ? s.days : {},
    sessions: s.sessions && typeof s.sessions === 'object' ? s.sessions : {},
    projects: s.projects && typeof s.projects === 'object' ? s.projects : {}
  }
}

/* generation time of one reply (first token to last); llama.cpp's own timing when it sends one */
function genTime (usage) {
  if (!usage) return 0
  const tm = usage.timings
  if (tm && tm.predicted_ms) return tm.predicted_ms
  return usage.gen_ms > 0 ? usage.gen_ms : 0
}

function addReply (t, usage, ms) {
  const out = (usage && usage.completion_tokens) || 0
  t.requests = (t.requests || 0) + 1
  t.input = (t.input || 0) + ((usage && usage.prompt_tokens) || 0)
  t.output = (t.output || 0) + out
  t.cached = (t.cached || 0) + ((usage && usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0)
  t.ms = (t.ms || 0) + (ms || 0)
  const gen = genTime(usage)
  if (gen > 0 && out > 0) {
    t.genMs = (t.genMs || 0) + gen
    t.genOut = (t.genOut || 0) + out
  }
}

/* output tokens per second over everything a total holds (null until one reply had a known speed) */
function speedOf (t) {
  return t && t.genMs > 0 && t.genOut > 0 ? t.genOut / (t.genMs / 1000) : null
}

/* keep the newest sessions only: a store that grows forever would slow every save */
function trimSessions (sessions, max) {
  const ids = Object.keys(sessions)
  if (ids.length <= max) return
  ids.sort(function (a, b) { return (sessions[b].last || 0) - (sessions[a].last || 0) })
  ids.slice(max).forEach(function (id) { delete sessions[id] })
}

/**
 * Add one event to the store (changed in place, also returned).
 * kind 'task' | 'lookup' | 'request'; for a request, data = { usage, ms, session: { id, title },
 * project: { id, name }, provider, model }.
 */
function record (store, kind, data, now) {
  const s = normalizeStore(store)
  const when = now instanceof Date ? now : new Date(now || Date.now())
  const key = dayKey(when)
  const day = s.days[key] || (s.days[key] = { tasks: 0, requests: 0, input: 0, output: 0, ms: 0 })
  const d = data || {}
  if (kind === 'task') day.tasks++
  if (kind === 'lookup') day.lookups = (day.lookups || 0) + 1
  if (kind !== 'request') return s

  const usage = d.usage || {}
  day.requests++
  day.input += usage.prompt_tokens || 0
  day.output += usage.completion_tokens || 0
  day.ms += d.ms || 0

  const t = when.getTime()
  if (d.session && d.session.id) {
    const rec = s.sessions[d.session.id] || (s.sessions[d.session.id] = { first: t })
    if (d.session.title) rec.title = String(d.session.title).slice(0, 120)
    if (d.project && d.project.id) rec.project = d.project.id
    if (d.provider) rec.provider = d.provider
    if (d.model) rec.model = String(d.model).slice(0, 80)
    addReply(rec, usage, d.ms)
    rec.last = t
    trimSessions(s.sessions, MAX_SESSIONS)
  }
  if (d.project && d.project.id) {
    const rec = s.projects[d.project.id] || (s.projects[d.project.id] = {})
    if (d.project.name) rec.name = String(d.project.name).slice(0, 80)
    addReply(rec, usage, d.ms)
    rec.last = t
  }
  return s
}

/* the line the panel shows after each model reply */
function summary (store, sessionId, projectId) {
  const s = normalizeStore(store)
  const sess = sessionId ? s.sessions[sessionId] : null
  const proj = projectId ? s.projects[projectId] : null
  return {
    session: sess ? { requests: sess.requests || 0, input: sess.input || 0, output: sess.output || 0, speed: speedOf(sess) } : null,
    project: proj ? { name: proj.name || '', requests: proj.requests || 0, input: proj.input || 0, output: proj.output || 0, speed: speedOf(proj) } : null
  }
}

module.exports = { record, summary, speedOf, emptyStore, normalizeStore, dayKey, MAX_SESSIONS }
