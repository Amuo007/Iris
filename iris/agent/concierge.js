'use strict'

/*
 * iris/agent/concierge.js — the WhatsApp agent: one short model call per message the user writes to Iris on WhatsApp.
 * It reads the message with what Iris is doing (the run, today's applications, a question or code Iris waits for, the
 * last messages in the chat) and decides what the user means; Iris's own code then does it. It never browses, clicks
 * or applies: the main agent does the work, untouched. (Fixed commands — "iris status" — were too hard to use.)
 *
 * Pure: the prompt and the reading of the model's answer; main/irisWhatsApp.js makes the call and acts.
 */

const { extractJsonCandidates, parseObjectLoose } = require('./actionSchema')

const ACTIONS = ['none', 'chat', 'pause', 'resume', 'stop', 'apply_link', 'task', 'answer', 'code']

const clean = function (s, max) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max) }

/* the conversation is remembered while it goes on; 20 minutes of silence and the next message starts fresh (a
   WhatsApp chat never ends, and an old exchange would only confuse the next one) */
const MEMORY_MS = 20 * 60 * 1000

/** The last messages of the chat that still count: none once the chat was quiet for MEMORY_MS. */
function liveHistory (history, now) {
  const h = (history || []).slice()
  // walk back from the newest: a gap of MEMORY_MS ends the conversation
  let start = h.length
  for (let i = h.length - 1; i >= 0; i--) {
    const next = i === h.length - 1 ? now : h[i + 1].at
    if (next - h[i].at > MEMORY_MS) break
    start = i
  }
  return h.slice(start)
}

const CAN = 'Iris can: find jobs on career sites and job boards and apply to them (filling forms, uploading the resume, ' +
  'solving CAPTCHAs), log every application (applied / needs the user / skipped / failed), read the user\'s email for ' +
  'verification codes, ask the user on WhatsApp for codes sent to their phone, browse any website, look things up, ' +
  'compare and summarise pages, download files, and keep going non-stop. On WhatsApp the user can ask for progress and ' +
  'numbers, pause, continue or stop it, send a job link to apply to, or give any task.'

function statsText (st) {
  if (!st) return ''
  const part = function (k, x) { return x ? k + ': ' + x.applied + ' applied, ' + x.needsYou + ' need the user, ' + x.skipped + ' skipped, ' + x.failed + ' failed' : '' }
  return ['Applications — ' + [part('today', st.today), part('last 7 days', st.week), part('all time', st.all)].filter(Boolean).join('; ') + '.'].join('')
}

/** What the WhatsApp agent knows, written for the prompt. */
function contextText (ctx) {
  const c = ctx || {}
  const lines = []
  lines.push('Chat: ' + (c.selfChat
    ? 'the user\'s own "Message yourself" chat (Iris is linked to the user\'s number). The user also writes notes to themself here: a message that is not for Iris gets action "none".'
    : 'Iris\'s own WhatsApp number; every message here is for Iris.'))
  const r = c.run || {}
  lines.push('Iris now: ' + (r.status === 'running' ? 'working' + (r.task ? ' on "' + clean(r.task, 160) + '"' : '') + (r.steps ? ', step ' + r.steps : '') + (r.now ? '; this step: ' + clean(r.now, 200) : '')
    : r.status === 'paused' ? 'paused' : 'not running' + (r.reason ? ' (' + clean(r.reason, 100) + ')' : '')) + '.')
  if (c.stats) lines.push(statsText(c.stats))
  else if (r.today) lines.push('Today\'s applications: ' + r.today.applied + ' applied, ' + r.today.needsYou + ' need the user, ' + r.today.skipped + ' skipped.')
  if (r.recent && r.recent.length) lines.push('Latest (newest first): ' + r.recent.slice(0, 8).map(function (x) { return clean(x, 140) }).join('; ') + '.')
  if (c.question) lines.push('Iris is WAITING for the user\'s answer to: "' + clean(c.question, 300) + '"')
  if (c.codeFor) lines.push('Iris is WAITING for a code the site sent to the user\'s phone, for: ' + clean(c.codeFor, 160) + '.')
  if (c.history && c.history.length) {
    lines.push('This conversation so far (it is forgotten after 20 quiet minutes):')
    c.history.slice(-8).forEach(function (h) { lines.push((h.from === 'iris' ? 'Iris: ' : 'User: ') + clean(h.text, 240)) })
  }
  return lines.join('\n')
}

/** The model call: a system prompt, the context, and the user's new message. */
function conciergeMessages (ctx, message) {
  const system = [
    'You are Iris on WhatsApp. Iris is an AI browser that applies to jobs for the user and does tasks in the browser.',
    'You do not browse or click: you read the user\'s message, decide what they mean, and write the reply. Iris\'s code then does it.',
    CAN,
    'Answer with one JSON object only: {"action": one of ' + ACTIONS.map(function (a) { return '"' + a + '"' }).join(', ') + ', "reply": str, "task": str, "url": str, "when": "now"|"next", "answer": str, "code": str}.',
    'Actions:',
    '- none: the message is not for Iris (a note the user writes to themself). reply "". Only when it clearly is not about Iris, jobs, applications or a task.',
    '- chat: greetings, thanks, "how are you", questions about progress, numbers, skips, what Iris can do. Reply from the facts given (never make up numbers or jobs; say so if a number is not given).',
    '- pause / resume / stop: only when the user plainly asks to pause, continue or stop Iris\'s work.',
    '- apply_link: the user gives a job link to apply to. url = that link.',
    '- task: the user wants something done in the browser (look up, check email, open a site, apply, find jobs). task = a clear instruction in the user\'s own words (with any link).',
    '  when = "now" if the user wants it before the current work ("first", "now", "right away", "pause this and do"), else "next".',
    '- answer: Iris is waiting for an answer and this message answers it. answer = the answer, as the user gave it.',
    '- code: Iris is waiting for a code and this message has it. code = the code exactly.',
    'reply: what Iris says back, friendly and short (one or two sentences, plain text, no markdown). For apply_link / task say it will do it (next, after the step it is on, when it is working). Never promise a result.'
  ].join('\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: contextText(ctx) + '\n\nThe user\'s new message:\n' + clean(message, 1200) }
  ]
}

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/i

/** The message names Iris ("hi iris", "hey Iris, how many…"): a conversation with Iris starts. */
function addressesIris (text) {
  return /\biris\b/i.test(String(text || ''))
}

/* "do it now" only when the user says so (a real model put "now" on "check my gmail", which would have dropped the
   application in progress) */
const NOW_RE = /\b(first|now|right away|right now|immediately|asap|urgent|before (that|this|anything))\b/i

/**
 * The model's answer as a decision { action, reply, task, url, answer, code }, checked against what is possible now:
 * an answer with no question waiting is a task, a code with no code waiting is chat, a link must be in the user's
 * message. null when nothing usable came back (the caller falls back to the plain rules).
 */
function parseDecision (text, ctx, message) {
  let obj = null
  for (const c of extractJsonCandidates(String(text || ''))) { obj = parseObjectLoose(c); if (obj) break }
  if (!obj || typeof obj !== 'object') return null
  let action = String(obj.action || '').toLowerCase().trim()
  if (ACTIONS.indexOf(action) === -1) return null
  const c = ctx || {}
  const msg = String(message || '')
  const d = {
    action: action,
    reply: clean(obj.reply || obj.response || obj.message || obj.text, 400).replace(/^\[iris\]\s*/i, ''),
    task: clean(obj.task, 800),
    url: clean(obj.url, 500),
    when: String(obj.when || '').toLowerCase() === 'now' && NOW_RE.test(String(message || '')) ? 'now' : 'next',
    answer: clean(obj.answer, 600),
    code: clean(obj.code, 20)
  }
  // a link is only one the user wrote (never one the model made up)
  const inMsg = (URL_RE.exec(msg) || [''])[0].replace(/[).,;!?]+$/, '')
  if (d.url && msg.indexOf(d.url) === -1) d.url = inMsg
  if (action === 'apply_link' && !d.url) { if (inMsg) d.url = inMsg; else action = d.action = 'task' }
  // "work on this first <job link>": a job the user found, whatever the model called it (its result goes back)
  if (action === 'task' && inMsg && /\b(apply|job|position|role|posting|opening)\b/i.test(msg + ' ' + d.task)) { action = d.action = 'apply_link'; d.url = d.url || inMsg }
  if (action === 'task' && !d.task) d.task = clean(msg, 800)
  if (action === 'answer' && !c.question) { action = d.action = 'task'; d.task = d.task || clean(msg, 800) }
  if (action === 'answer' && !d.answer) d.answer = clean(msg, 600)
  if (action === 'code' && (!c.codeFor || !/^[A-Za-z0-9]{4,10}$/.test(d.code) || msg.replace(/[\s-]/g, '').indexOf(d.code) === -1)) { action = d.action = 'chat' }
  // no reply written: the caller says something useful instead (for chat, the status); never an empty message
  if (action !== 'none' && !d.reply && action !== 'chat') d.reply = 'OK.'
  return d
}

module.exports = { ACTIONS, MEMORY_MS, liveHistory, addressesIris, contextText, conciergeMessages, parseDecision }
