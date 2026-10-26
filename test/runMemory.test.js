'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { RUN_MEMORY, carryRunMemory } = require('../iris/agent/runMemory')

test('the next run of a chat keeps the job in hand and its sign-ins', () => {
  const confirmations = [{ url: 'https://jobs.lever.co/acme/x/thanks', at: 1 }]
  const old = {
    confirmations,
    newPasswords: { 'hpe.wd5.myworkdayjobs.com': 'pw-made-in-run-1' },
    refusedPasswords: { 'rochester.wd5.myworkdayjobs.com': ['old'] },
    resetFor: { site: 'hpe.wd5.myworkdayjobs.com', at: 5 },
    lastJob: { title: 'Software Engineer', company: 'Acme', resume: '/tmp/r.pdf' },
    lastResume: '/tmp/r.pdf',
    notes: ['Logged … Go on to the next job.'],
    ghDirectTried: new Set(['https://acme.com/jobs?gh_jid=1']),
    // tab and screen state belong to the old run
    pendingDialog: { type: 'alert' },
    pointer: { x: 1, y: 2 },
    tabId: 7
  }
  const fresh = { tabId: 9, ghDirectTried: new Set() }
  carryRunMemory(old, fresh)
  assert.strictEqual(fresh.confirmations, confirmations)
  assert.strictEqual(fresh.newPasswords['hpe.wd5.myworkdayjobs.com'], 'pw-made-in-run-1')
  assert.deepStrictEqual(fresh.refusedPasswords, { 'rochester.wd5.myworkdayjobs.com': ['old'] })
  assert.strictEqual(fresh.resetFor.site, 'hpe.wd5.myworkdayjobs.com')
  assert.strictEqual(fresh.lastResume, '/tmp/r.pdf')
  assert.deepStrictEqual(fresh.notes, ['Logged … Go on to the next job.'])
  assert.ok(fresh.ghDirectTried.has('https://acme.com/jobs?gh_jid=1'))
  assert.strictEqual(fresh.pendingDialog, undefined)
  assert.strictEqual(fresh.pointer, undefined)
  assert.strictEqual(fresh.tabId, 9)
})

test('nothing to carry: the new computer is left as it is', () => {
  const fresh = { tabId: 3 }
  assert.strictEqual(carryRunMemory(null, fresh), fresh)
  assert.deepStrictEqual(fresh, { tabId: 3 })
  // unset fields on the old one do not blank the new one's
  const kept = { notes: ['x'] }
  carryRunMemory({ notes: undefined, lastJob: null }, kept)
  assert.deepStrictEqual(kept, { notes: ['x'] })
  assert.ok(RUN_MEMORY.indexOf('confirmations') >= 0 && RUN_MEMORY.indexOf('newPasswords') >= 0)
  // what the chat logged goes on: a later run of it holds back a second Submit of those jobs too
  assert.ok(RUN_MEMORY.indexOf('loggedIds') >= 0)
})

const { nextRoundWait } = require('../iris/agent/runMemory')

test('a non-stop job run waits 30 minutes only after 3 rounds in 30 minutes that logged nothing', () => {
  const s = {}
  const min = 60000
  // a skip, then a done, three times over (the real night of 10-25): every round logged a job, so it goes on in 20 s
  assert.strictEqual(nextRoundWait(s, 'job-1', true, 0), 20000)
  assert.strictEqual(nextRoundWait(s, 'job-2', true, 5 * min), 20000)
  assert.strictEqual(nextRoundWait(s, 'job-3', true, 10 * min), 20000)
  assert.deepStrictEqual(s.doneTimes, [])
  // rounds that logged nothing new: the third one in 30 minutes means the postings ran out
  assert.strictEqual(nextRoundWait(s, 'job-3', true, 11 * min), 20000)
  assert.strictEqual(nextRoundWait(s, 'job-3', true, 12 * min), 20000)
  assert.strictEqual(nextRoundWait(s, 'job-3', true, 13 * min), 30 * min)
  // a logged job clears the count again
  assert.strictEqual(nextRoundWait(s, 'job-4', true, 50 * min), 20000)
  assert.deepStrictEqual(s.doneTimes, [])
  // empty rounds more than 30 minutes apart never add up to 3
  const t = {}
  assert.strictEqual(nextRoundWait(t, '', true, 0), 20000)
  assert.strictEqual(nextRoundWait(t, '', true, 20 * min), 20000)
  assert.strictEqual(nextRoundWait(t, '', true, 40 * min), 20000)
  assert.strictEqual(nextRoundWait(t, '', true, 45 * min), 30 * min)
  // a run that is not a job run always goes on in 20 s
  const u = {}
  for (let i = 0; i < 4; i++) assert.strictEqual(nextRoundWait(u, '', false, i * min), 20000)
})
