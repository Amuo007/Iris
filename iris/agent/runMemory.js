'use strict'

/*
 * iris/agent/runMemory.js — what one run of a chat hands to the next.
 *
 * A Non-stop run keeps going by starting a new run in the same chat (20 s after "done", a minute after a failure), and
 * every run gets a new "computer" (IrisComputer in main/irisAgent.js). What Iris had learnt about the job in hand and
 * this run's sign-ins lived on the old one and was dropped at each restart: the confirmation pages seen, the password
 * just made for a site, the passwords a site refused, a reset half done, the resume made for the job, the autofill runs
 * on a form, notes not yet shown to the model. (A real run was told to submit AgZen again after a restart had cleared
 * the confirmations; on 10-23/24 passwords went missing between runs.) The next run of the same chat now starts with
 * them; a new chat starts empty.
 *
 * Pure.
 */

const RUN_MEMORY = [
  // which applications went through, and where
  'confirmations', 'unconfirmedLog', 'postingBySite',
  // sign-ins: passwords made, refused or reset in this chat, and what each site said
  'newPasswords', 'takenSites', 'refusedPasswords', 'resetFor', 'resetOffered', 'signInGated', 'accountTyped', 'lastSignIn',
  'lastTypedEmail', 'accountHinted',
  // the job in hand and its papers
  'jobsTailored', 'lastJob', 'lastResume', 'lastCover',
  // forms
  'autofillRuns', 'ghDirectTried', 'refusedNumber',
  // what this chat logged: a second Submit of one of them is held back
  'loggedIds',
  // told to the model but not yet shown to it
  'notes'
]

/** Copy the run memory of the chat's last computer into the new one; nothing when there is none. Returns `to`. */
function carryRunMemory (from, to) {
  if (!from || !to || from === to) return to
  RUN_MEMORY.forEach(function (k) {
    if (from[k] !== undefined && from[k] !== null) to[k] = from[k]
  })
  return to
}

/** How long a non-stop run waits after a "done" before its next round. A round that logged a job did not run out of
 * jobs: it clears the count (real night 10-25: three skips, each followed by a "done", made it wait 30 minutes). Only
 * 3 rounds that logged nothing within 30 minutes mean the postings ran out, and a job run then looks again in 30
 * minutes; otherwise it goes on in 20 s. `session` keeps doneTimes and loggedAtDone; `lastLogged` is the id of the
 * chat's last logged job ('' when none). */
function nextRoundWait (session, lastLogged, jobsMode, now) {
  if (now === undefined) now = Date.now()
  lastLogged = lastLogged || ''
  const logged = lastLogged !== (session.loggedAtDone || '')
  session.loggedAtDone = lastLogged
  session.doneTimes = logged ? [] : (session.doneTimes || []).filter(function (t) { return now - t < 30 * 60000 }).concat(now)
  return jobsMode && session.doneTimes.length >= 3 ? 30 * 60000 : 20000
}

module.exports = { RUN_MEMORY, carryRunMemory, nextRoundWait }
