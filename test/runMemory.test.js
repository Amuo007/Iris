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
})
