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

/** A phone number as WhatsApp writes it: country code and number, digits only ("+1 (832) 263-4489" → "18322634489"). */
function normalizeNumber (text) {
  const digits = String(text || '').replace(/[^\d]/g, '').replace(/^00/, '')
  return digits.length >= 8 && digits.length <= 15 ? digits : ''
}

/**
 * The user's number with its country code: a number typed without one ("832 263 4489") that is the end of the linked
 * number ("18322634489") is that number (a real setup saved 10 digits and every message went to an address that does
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

/* the phone digits of a WhatsApp address ("18322634489:12@s.whatsapp.net" → "18322634489"); a hidden-number (LID)
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
  return recent && code ? { late: recent } : {}
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

function noCodeText (req) {
  return '[Iris] I need just the code for ' + jobName(req) + ' (letters and digits, nothing else).'
}

function helpText () {
  return '[Iris] Nothing is waiting for a code right now. I only message you here when a site sends a code to your phone.'
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
  prune,
  codeArrivedNote,
  codeExpiredNote,
  ackText,
  expiredText,
  lateText,
  noCodeText,
  helpText
}
