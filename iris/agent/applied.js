'use strict'

/*
 * iris/agent/applied.js — when an "applied" log is believed: the confirmation page Iris saw must be this job's own.
 *
 * Iris remembers every confirmation page it sees (noteConfirmation in main/irisAgent.js) and, when the model logs a
 * job as applied, looks for one that belongs to that job:
 *   • Posting ids of the same kind that differ mean another job, whatever else matches: a recruiting firm posts many
 *     jobs on one board, and one thank-you page must not stand for all of them (10-24: seven jobs at one firm on Ashby,
 *     where any one thank-you page within 45 minutes covered every other job there).
 *   • LinkedIn counts: Easy Apply's "Application sent" pop-up, or a job's own page saying "Application submitted",
 *     filed under the job's number. LinkedIn was left out, so an Easy Apply that went through could never be logged as
 *     applied (Explore Logistics, 10-24, logged needs_you).
 *   • Without such a page nothing is called applied: a second try after looking again is filed needs_you, with a note
 *     to check it (10-24: IV.AI was taken as applied with no confirmation at all).
 *
 * Pure: the job keys, ids and sites come from main/irisJobs.js (irisJobKey, irisJobIds, irisSiteKey).
 */

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const CONFIRM_MS = 45 * 60 * 1000 // a confirmation counts for this long
const HERE_MS = 10 * 60 * 1000 // the page in front of Iris, seen as a confirmation this recently, counts as the job's

/** A LinkedIn job's number from any of its addresses (/jobs/view/N, a search or collection with ?currentJobId=N), or ''. */
function linkedinJobId (url) {
  let u
  try { u = new URL(url) } catch (e) { return '' }
  if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return ''
  const view = /\/jobs\/view\/(?:[^/]*-)?(\d{6,})(?:\/|$)/.exec(u.pathname)
  if (view) return view[1]
  const current = u.searchParams.get('currentJobId') || ''
  return /^\d{6,}$/.test(current) ? current : ''
}

/** Posting ids in a job key, by kind: UUIDs (Lever, Ashby, Pinpoint) and the numbers main finds (irisJobIds). */
function postingIds (key, numbers) {
  return {
    uuids: (String(key || '').match(UUID_RE) || []).map(function (s) { return s.toLowerCase() }),
    nums: (numbers || []).map(String)
  }
}

function overlap (a, b) {
  return a.some(function (x) { return b.indexOf(x) >= 0 })
}

/** Easy Apply went through, by what LinkedIn shows: its "Application sent" pop-up, or the job's own page. */
function linkedinConfirmed (peek, url) {
  if (!peek) return false
  if (/\b(your )?application (was )?sent\b|\bapplication submitted\b/i.test(String(peek.dialog || ''))) return true
  // the newer /jobs/search-results/ page: the pop-up is no role=dialog, and the open job's pane heads "Application status"
  // once it is in (11-04: a dozen Easy Applies that LinkedIn confirmed were filed needs_you)
  if (/\byour application was sent to\b/i.test(String(peek.text || ''))) return true
  if (/[?&]currentJobId=/i.test(String(url || '')) && /\bapplication status\b/i.test(String(peek.heads || ''))) return true
  // a search page lists other jobs beside this one: only the job's own page is read for it
  return /\/jobs\/view\//i.test(String(url || '')) && /\bapplication submitted\b/i.test(String(peek.text || ''))
}

/* Job pages whose Apply button turns to "Applied" once the application is sent, with no thank-you page after it: Work
 * at a Startup (10-25: AviaryAI and Infer went through and were filed needs_you), and YC's own job pages. Only a
 * single job's page: a list page can show other jobs' "Applied". */
const APPLIED_BUTTON_PAGE = /^https:\/\/(www\.)?(workatastartup\.com\/jobs\/\d+|ycombinator\.com\/companies\/[^/]+\/jobs\/[^/?#]+)/i

/** The job's own page shows its button as "Applied" (peek.applied: a visible button whose whole label is "Applied"). */
function appliedButtonShown (peek, url) {
  return !!(peek && peek.applied) && APPLIED_BUTTON_PAGE.test(String(url || ''))
}

/**
 * Whether confirmation c belongs to the job being logged.
 *   c:   { url, at, key, ids, site, squashed }        (ids: postingIds; squashed: the address, letters and digits only)
 *   log: { key, ids, site, co, here, strict }         (co: the company's first letters; here: the page Iris is on;
 *                                                      strict: a LinkedIn job, matched by its number only)
 */
function confirmationMatches (c, log, now) {
  const age = now - c.at
  if (!(age < CONFIRM_MS)) return false
  const a = log.ids
  const b = c.ids
  if ((a.uuids.length && b.uuids.length && !overlap(a.uuids, b.uuids)) || (a.nums.length && b.nums.length && !overlap(a.nums, b.nums))) return false
  if (log.here && c.url === log.here && age < HERE_MS) return true
  if (log.key && c.key && (c.key === log.key || c.key.indexOf(log.key) === 0 || log.key.indexOf(c.key) === 0)) return true
  if (overlap(a.uuids, b.uuids) || overlap(a.nums, b.nums)) return true
  if (log.strict) return false
  // no posting id to tell them apart: the company's own site, or its name in the address
  return !!((log.co && String(c.squashed || '').indexOf(log.co) >= 0) || (log.site && c.site === log.site))
}

/*
 * The button that sends an application, or opens the form for one, by its own words: a click on it for a job that is
 * already in the Applications list is held back (a real run submitted Pinterest twice and was on its form a third
 * time; another went back through IBM's Apply for a job applied to the day before). Words only, the whole label:
 * "Submit" on a search box or "Apply filters" is not one.
 */
const SUBMIT_LABEL = /^(submit|submit (my |your |the )?application|submit (and|&) (apply|finish|send)|send( my)? application|complete (my |your )?application|finish (and submit|application)|apply|apply now|apply (for|to) (this|the) (job|position|role)|easy apply|apply with (linkedin|indeed|resume)|i'?m interested)$/i

/** Whether a button's label is one that sends an application or opens its form. */
function isSubmitLabel (text) {
  const t = String(text || '').replace(/\s+/g, ' ').replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '').trim()
  return t.length > 0 && t.length <= 40 && SUBMIT_LABEL.test(t)
}

module.exports = { linkedinJobId, postingIds, linkedinConfirmed, appliedButtonShown, confirmationMatches, isSubmitLabel, CONFIRM_MS, HERE_MS }
