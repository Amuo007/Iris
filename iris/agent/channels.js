'use strict'

/*
 * iris/agent/channels.js — Iris messaging the user (WhatsApp) for the one thing only the user can give: a code a site
 * sent to the user's phone, or to an inbox Iris cannot open. A real day ended 7 TikTok applications at "enter the
 * 6-digit code we texted you", each one filled in and its CAPTCHA passed.
 *
 * Emergencies only, decided here and not by the model: one message per job, a few per hour, the text written from a
 * template (never a password or other personal data). Nothing waits on the user: the job's tab stays open, the run goes
 * on with the next job, and a code that comes back within the time limit is handed to the model with the tab to go to.
 *
 * Pure: no WhatsApp, Electron or file access here (main/irisWhatsApp.js does that), so all of it is tested.
 */

const WAIT_MS = 15 * 60 * 1000 // how long a code request stays open
const PER_HOUR = 6 // code requests sent per hour at most
const KEEP_MS = 24 * 3600 * 1000 // finished requests are kept this long (to answer a late reply)

/** A phone number as WhatsApp writes it: country code and number, digits only ("+1 (555) 010-2234" → "15550102234"). */
function normalizeNumber (text) {
  const digits = String(text || '').replace(/[^\d]/g, '').replace(/^00/, '')
  return digits.length >= 8 && digits.length <= 15 ? digits : ''
}

/**
 * The user's number with its country code: a number typed without one ("555 010 2234") that is the end of the linked
 * number ("15550102234") is that number (a real setup saved 10 digits and every message went to an address that does
 * not exist). Otherwise as normalizeNumber.
 */
function completeNumber (typed, linked) {
  const digits = normalizeNumber(typed) || String(typed || '').replace(/[^\d]/g, '')
  const me = normalizeNumber(linked)
  if (me && digits.length >= 7 && !/^\s*(\+|00)/.test(String(typed || '')) && me !== digits && me.endsWith(digits)) return me
  return normalizeNumber(typed)
}

/** The chat address of a number. */
function jidFor (number) {
  const n = normalizeNumber(number)
  return n ? n + '@s.whatsapp.net' : ''
}

/* the phone digits of a WhatsApp address ("15550102234:12@s.whatsapp.net" → "15550102234"); a hidden-number (LID)
   address has none */
function phoneOf (jid) {
  const m = /^(\d{8,15})(?::\d+)?@s\.whatsapp\.net$/.exec(String(jid || ''))
  return m ? m[1] : ''
}

/**
 * Whether a message came from the user's own number. WhatsApp may address the sender by a hidden id (…@lid) and give
 * the phone address only in remoteJidAlt / participantAlt; anything not provably from that number is ignored.
 */
function isFromUser (key, userNumber, self) {
  const want = normalizeNumber(userNumber)
  if (!key || !want) return false
  const addresses = [key.remoteJid, key.remoteJidAlt, key.participant, key.participantAlt]
  if (!key.fromMe) return addresses.some(function (j) { return phoneOf(j) === want })
  // Iris linked to the user's own number ("Message yourself"): the user's replies there are "from me" too; only the
  // ones Iris did not send itself count, and only in that chat
  const s = self || {}
  if (!s.me || normalizeNumber(s.me) !== want || (s.sentIds && s.sentIds.has(key.id))) return false
  const lid = String(s.meLid || '').replace(/:\d+@/, '@')
  return [key.remoteJid, key.remoteJidAlt].some(function (j) { return phoneOf(j) === want || (lid && String(j || '').replace(/:\d+@/, '@') === lid) })
}

/** One of Iris's own messages (all start "[Iris]"): never read as a reply, or Iris would answer itself forever in
    "Message yourself", where its messages and the user's are both "from me". */
function isIrisMessage (text) {
  return /^\s*\[Iris\]/.test(String(text || ''))
}

/** The text of a message, if it is plain text. */
function messageText (message) {
  const m = message || {}
  return String(m.conversation || (m.extendedTextMessage && m.extendedTextMessage.text) || '').trim()
}

const clean = function (s, max) { return String(s || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) }

/** The job a request is about, for the user to recognise. */
function jobName (req) {
  return [clean(req.company, 60), clean(req.title, 90)].filter(Boolean).join(' — ') || clean(req.site, 60) || 'a job'
}

/** The message asking for a code. Written here, from the request's few fields only. */
function codeRequestText (req) {
  return '[Iris] ' + jobName(req) + ': ' + (clean(req.what, 160) || 'the site sent a code to your phone') + '.\n' +
    'Reply here with just the code within ' + Math.round(WAIT_MS / 60000) + ' minutes. I keep applying to other jobs meanwhile.'
}

/**
 * The code in a reply: the one token of 4-10 letters and digits with at least one digit ("482913", "code: 482913",
 * "5X1D22yy" from an email). Several such tokens, or none: null (a sentence is not guessed at).
 */
function extractCode (text) {
  // only digits, grouped the way phones show them ("482 913", "482-913")
  const bare = String(text || '').trim()
  if (/^\d[\d\s-]{2,14}\d$/.test(bare) && bare.replace(/[\s-]/g, '').length >= 4 && bare.replace(/[\s-]/g, '').length <= 10) return bare.replace(/[\s-]/g, '')
  const tokens = bare.split(/[\s,.;:!?()"'-]+/).filter(function (t) { return /^[A-Za-z0-9]{4,10}$/.test(t) && /\d/.test(t) })
  return tokens.length === 1 ? tokens[0] : null
}

/** Requests still waiting for the user's reply. */
function openRequests (requests, now) {
  return (requests || []).filter(function (r) { return r.state === 'sent' && (now - r.at) < WAIT_MS })
}

/**
 * May Iris ask now? { ok } or { ok: false, reason } — one open request per job, PER_HOUR an hour, and only one waiting
 * at a time (a second code would be a guess which one the user means).
 */
function canAsk (requests, req, now) {
  const all = requests || []
  const open = openRequests(all, now)
  const job = jobName(req)
  if (open.some(function (r) { return jobName(r) === job })) return { ok: false, reason: 'already waiting for the user\'s code for ' + job }
  if (open.length) return { ok: false, reason: 'already waiting for a code for ' + jobName(open[0]) + ' (one at a time)' }
  if (all.filter(function (r) { return now - r.at < 3600 * 1000 }).length >= PER_HOUR) return { ok: false, reason: 'already asked the user ' + PER_HOUR + ' times this hour' }
  return { ok: true }
}

/** A new request, as sent. */
function newRequest (req, now, id) {
  return {
    id: id || now.toString(36),
    at: now,
    state: 'sent',
    company: clean(req.company, 60),
    title: clean(req.title, 90),
    site: clean(req.site, 80),
    what: clean(req.what, 160),
    url: String(req.url || '').slice(0, 500),
    tabId: req.tabId === undefined ? null : req.tabId,
    sessionId: req.sessionId || null
  }
}

/**
 * The user replied: { request, code } for the open request the reply answers, or { late } when the newest request
 * already timed out, or {} when nothing waits. One open request at a time, so the reply is for it.
 */
function matchReply (requests, text, now) {
  const code = extractCode(text)
  const open = openRequests(requests, now)
  if (open.length && code) return { request: open[open.length - 1], code: code }
  if (open.length) return { request: open[open.length - 1], code: null }
  const recent = (requests || []).filter(function (r) { return r.state !== 'answered' && now - r.at < KEEP_MS }).slice(-1)[0]
  if (recent && code && recent.state === 'closed') return { closed: recent }
  return recent && code ? { late: recent } : {}
}

/**
 * A job was logged (applied, needs you, skipped, failed): its waiting code request is closed, so a code that comes later
 * is answered "no longer needed" and the model is not sent back to an old tab (a real BNY code came 4 minutes after
 * the model had read it in the inbox itself and logged the job). Returns the requests closed.
 */
function closeFor (requests, rec) {
  const name = jobName(rec || {})
  const url = String((rec && rec.url) || '').split('?')[0]
  const out = []
  ;(requests || []).forEach(function (r) {
    if (r.state !== 'sent') return
    if (jobName(r) === name || (url && String(r.url || '').split('?')[0] === url)) { r.state = 'closed'; out.push(r) }
  })
  return out
}

/** Requests whose time is up (still marked sent): the caller tells the model and the user, then marks them expired. */
function dueToExpire (requests, now) {
  return (requests || []).filter(function (r) { return r.state === 'sent' && now - r.at >= WAIT_MS })
}

/** Old finished requests dropped. */
function prune (requests, now) {
  return (requests || []).filter(function (r) { return r.state === 'sent' || now - r.at < KEEP_MS })
}

/** What the model is told when the code arrives. tab: the waiting tab's number now, or 0 when it was closed. */
function codeArrivedNote (req, code, tab) {
  return 'WhatsApp: the user sent the code ' + code + ' for ' + jobName(req) + '. ' + (tab
    ? 'Codes expire fast: finish only the step you are on, then switch_tab ' + tab + ', type ' + code + ' into the code box there and submit that application; log it, then go back to what you were doing.'
    : 'Its tab was closed: open ' + (req.url || 'that job') + ' again, ask the site to send a new code only if the old one is refused, and finish that application.')
}

/** What the model is told when no code came in time. */
function codeExpiredNote (req, tab) {
  return 'WhatsApp: no code came from the user for ' + jobName(req) + ' within ' + Math.round(WAIT_MS / 60000) + ' minutes. ' +
    (tab ? 'Close tab ' + tab + ' when you are between steps, and ' : '') + 'log that job needs_you ("the code went to the user\'s phone; no reply in time").'
}

function ackText (req, code) {
  return '[Iris] Got ' + code + ' — entering it for ' + jobName(req) + ' now.'
}

function expiredText (req) {
  return '[Iris] No code for ' + jobName(req) + ' in time. I left it for you in the Applications list (needs you) and went on.'
}

function lateText (req) {
  return '[Iris] That came after ' + jobName(req) + ' timed out, so I could not use it. It is in the Applications list (needs you).'
}

function closedText (req) {
  return '[Iris] Thanks — no longer needed: ' + jobName(req) + ' was already handled.'
}

function noCodeText (req) {
  return '[Iris] I need just the code for ' + jobName(req) + ' (letters and digits, nothing else).'
}

function noCodeWaitingText () {
  return '[Iris] Nothing is waiting for a code right now.'
}

/** A message that is nothing but a code ("482913", "482 913"), not a task. */
function isJustCode (text) {
  const c = extractCode(text)
  return !!c && String(text || '').trim().replace(/[\s-]/g, '').replace(/^code:?/i, '') === c
}

function helpText (selfChat) {
  const p = selfChat ? 'iris ' : ''
  return '[Iris] Write ' + (selfChat ? 'starting with "iris"' : 'to me here') + ':\n' +
    '• ' + p + 'status — what I am doing\n' +
    '• ' + p + 'pause / ' + p + 'continue / ' + p + 'stop\n' +
    '• ' + p + '<a job link> — I apply to it next\n' +
    '• ' + p + '<anything else> — a task for me, like typing it in my panel\n' +
    'A code a site sent you: just the code' + (selfChat ? ', no "iris" needed.' : '.')
}

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/i

/** The first link in a message, without trailing punctuation. */
function firstUrl (text) {
  const m = URL_RE.exec(String(text || ''))
  return m ? m[0].replace(/[).,;!?]+$/, '') : ''
}

/**
 * What the user's message asks for: { kind: 'status'|'pause'|'resume'|'stop'|'help'|'link'|'task', text, url } or null
 * when it is not for Iris. In "Message yourself" (selfChat) only messages that start with "iris" (or "/") are for Iris —
 * the user writes notes to themself there too; to a second number every message is.
 */
function parseCommand (text, opts) {
  const raw = String(text || '').trim()
  if (!raw || isIrisMessage(raw)) return null
  const prefix = /^(?:\/|iris\b[\s,:;.!-]*)/i
  const self = !!(opts && opts.selfChat)
  if (self && !prefix.test(raw)) return null
  const body = raw.replace(prefix, '').trim()
  if (!body) return { kind: 'help', text: '' }
  const word = body.toLowerCase().replace(/[.!?]+$/, '').trim()
  if (/^(status|progress|update|updates|what are you doing|what're you doing|how is it going|how's it going|where are you)$/.test(word)) return { kind: 'status', text: body }
  if (/^(pause|wait|hold on|hold)$/.test(word)) return { kind: 'pause', text: body }
  if (/^(continue|resume|go on|carry on|keep going)$/.test(word)) return { kind: 'resume', text: body }
  if (/^(stop|stop it|stop the run|cancel)$/.test(word)) return { kind: 'stop', text: body }
  if (/^(help|commands|\?)$/.test(word)) return { kind: 'help', text: body }
  const url = firstUrl(body)
  // a link alone, or with only "apply"/"apply to this": a job to apply to
  if (url && /^(apply( to)?( this( job)?)?[\s:,-]*)?$/i.test(body.replace(url, '').trim())) return { kind: 'link', text: body, url: url }
  return { kind: 'task', text: body, url: url }
}

/** The answer to "status": the run, the step it is on, today's applications. */
function statusText (info) {
  const i = info || {}
  const head = i.status === 'running' ? 'Working' + (i.task ? ' on: ' + clean(i.task, 120) : '') + (i.steps ? ' (step ' + i.steps + ')' : '')
    : i.status === 'paused' ? 'Paused' + (i.question ? ', waiting for you: ' + clean(i.question, 200) : '')
      : 'Not running' + (i.reason ? ' (' + clean(i.reason, 120) + ')' : '')
  const lines = ['[Iris] ' + head + '.']
  if (i.now) lines.push('Now: ' + clean(i.now, 200))
  if (i.today) lines.push('Today: ' + i.today.applied + ' applied, ' + i.today.needsYou + ' need you, ' + i.today.skipped + ' skipped.')
  if (i.last) lines.push('Last: ' + clean(i.last, 160))
  return lines.join('\n')
}

/** One application, for the updates (applied, needs you, failed — skips are not sent). */
function applicationText (rec) {
  const r = rec || {}
  const job = jobName(r)
  if (r.status === 'applied') return '[Iris] Applied: ' + job
  if (r.status === 'needs_you') return '[Iris] Needs you: ' + job + (r.note ? ' — ' + clean(r.note, 200) : '')
  if (r.status === 'failed') return '[Iris] Could not apply: ' + job + (r.note ? ' — ' + clean(r.note, 160) : '')
  return ''
}

function askText (question) {
  return '[Iris] I am waiting for your answer: ' + clean(question, 400) + '\nReply here (or in my panel).'
}

module.exports = {
  WAIT_MS,
  PER_HOUR,
  normalizeNumber,
  completeNumber,
  jidFor,
  phoneOf,
  isFromUser,
  isIrisMessage,
  messageText,
  jobName,
  codeRequestText,
  extractCode,
  openRequests,
  canAsk,
  newRequest,
  matchReply,
  dueToExpire,
  closeFor,
  closedText,
  prune,
  codeArrivedNote,
  codeExpiredNote,
  ackText,
  expiredText,
  lateText,
  noCodeText,
  helpText,
  noCodeWaitingText,
  isJustCode,
  firstUrl,
  parseCommand,
  statusText,
  applicationText,
  askText
}
