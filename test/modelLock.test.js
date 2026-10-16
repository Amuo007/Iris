'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createModelLock } = require('../iris/agent/modelLock')

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'iris-lock-')), 'model.lock')

test('two Iris windows never send a request at the same time', async () => {
  const file = tmp()
  const a = createModelLock({ fs, file, pid: 101, alive: () => true, pollMs: 5 })
  const b = createModelLock({ fs, file, pid: 202, alive: () => true, pollMs: 5 })
  let inside = 0
  let maxInside = 0
  let waited = 0
  const job = (lock, ms) => lock.turn(async () => {
    inside++
    maxInside = Math.max(maxInside, inside)
    await new Promise(resolve => setTimeout(resolve, ms))
    inside--
    return ms
  }, () => { waited++ })
  const results = await Promise.all([job(a, 40), job(b, 10), job(a, 20), job(b, 30)])
  assert.deepStrictEqual(results, [40, 10, 20, 30])
  assert.strictEqual(maxInside, 1)
  assert.ok(waited >= 1, 'the second one was told it is waiting')
  assert.ok(!fs.existsSync(file), 'the lock is gone afterwards')
})

test('a lock left by a window that quit is taken over', async () => {
  const file = tmp()
  fs.writeFileSync(file, JSON.stringify({ owner: 'dead', pid: 999999, at: Date.now() }))
  const lock = createModelLock({ fs, file, pid: 303, alive: p => p !== 999999, pollMs: 5 })
  assert.strictEqual(await lock.turn(async () => 'ran'), 'ran')
})

test('a lock nobody refreshed for long is taken over', async () => {
  const file = tmp()
  fs.writeFileSync(file, JSON.stringify({ owner: 'stuck', pid: 404, at: Date.now() - 200000 }))
  const lock = createModelLock({ fs, file, pid: 505, alive: () => true, pollMs: 5, staleMs: 90000 })
  assert.strictEqual(await lock.turn(async () => 'ran'), 'ran')
})

test('an error in the request still frees the lock', async () => {
  const file = tmp()
  const lock = createModelLock({ fs, file, pid: 606, alive: () => true, pollMs: 5 })
  await assert.rejects(lock.turn(async () => { throw new Error('server down') }), /server down/)
  assert.ok(!fs.existsSync(file))
})
