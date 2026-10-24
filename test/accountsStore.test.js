'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { load, write, backups, backupsDir } = require('../iris/agent/accountsStore')

function place () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-accounts-'))
  return path.join(dir, 'iris-accounts.json')
}

const a = { site: 'a.test', username: 'me@x.test', password: 'enc:A' }
const b = { site: 'b.test', username: 'me@x.test', password: 'enc:B' }

test('no file yet: no accounts, and the first write makes no backup', () => {
  const file = place()
  assert.deepStrictEqual(load(file), [])
  write(file, [a])
  assert.deepStrictEqual(load(file), [a])
  assert.strictEqual(backups(file).length, 0)
})

test('every write keeps the file as it was in the backups folder', () => {
  const file = place()
  write(file, [a], { now: Date.UTC(2026, 9, 24, 1, 0, 0) })
  write(file, [a, b], { now: Date.UTC(2026, 9, 24, 1, 0, 0) })
  write(file, [a, Object.assign({}, b, { password: 'enc:B2' })], { now: Date.UTC(2026, 9, 24, 1, 0, 0) })
  const kept = backups(file)
  assert.strictEqual(kept.length, 2)
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(kept[0], 'utf8')).accounts, [a])
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(kept[1], 'utf8')).accounts, [a, b])
  // the same name twice in one second gets a number, not an overwrite
  assert.ok(/-2\.json$/.test(kept[1]))
  // private, like the file itself
  assert.strictEqual(fs.statSync(kept[0]).mode & 0o777, 0o600)
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600)
  // writing the same content again adds no copy
  write(file, [a, Object.assign({}, b, { password: 'enc:B2' })])
  write(file, [a, Object.assign({}, b, { password: 'enc:B2' })])
  assert.strictEqual(backups(file).length, 3)
})

test('a write that would drop a saved sign-in is refused; a delete on purpose is not', () => {
  const file = place()
  write(file, [a, b])
  assert.throws(() => write(file, [a]), /would drop 1 saved sign-in\(s\) \(b\.test\)/)
  assert.throws(() => write(file, []), /would drop 2/)
  assert.deepStrictEqual(load(file), [a, b])
  write(file, [a], { remove: [{ site: 'b.test', username: 'me@x.test' }] })
  assert.deepStrictEqual(load(file), [a])
  // and the deleted one is still in the backup
  const kept = backups(file)
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(kept[kept.length - 1], 'utf8')).accounts, [a, b])
})

test('a file that cannot be read falls back to its newest backup that can', () => {
  const file = place()
  write(file, [a])
  write(file, [a, b])
  fs.writeFileSync(file, '{"accounts": [ {"site": "a.te')
  assert.deepStrictEqual(load(file), [a])
  // a broken newest backup is skipped too
  fs.writeFileSync(path.join(backupsDir(file), 'iris-accounts-29990101-000000.json'), 'not json')
  assert.deepStrictEqual(load(file), [a])
  // a save on top of the broken file keeps the broken bytes as a backup first
  write(file, [a, b])
  const kept = backups(file).map(p => fs.readFileSync(p, 'utf8'))
  assert.ok(kept.some(t => t.indexOf('"site": "a.te') >= 0 && t.length < 40))
  assert.deepStrictEqual(load(file), [a, b])
})

test('a lost file comes back from its backups; nothing readable at all is an error, not "no accounts"', () => {
  const file = place()
  write(file, [a])
  write(file, [a, b])
  fs.unlinkSync(file)
  assert.deepStrictEqual(load(file), [a])
  const other = place()
  fs.writeFileSync(other, 'garbage')
  assert.throws(() => load(other), /cannot be read/)
})

test('a crash halfway through a write leaves the old file whole', () => {
  const file = place()
  write(file, [a, b])
  const realRename = fs.renameSync
  fs.renameSync = function () { throw new Error('power cut') }
  try {
    assert.throws(() => write(file, [a, Object.assign({}, b, { password: 'enc:B3' })]), /power cut/)
  } finally {
    fs.renameSync = realRename
  }
  assert.deepStrictEqual(load(file), [a, b])
})

test('old copies are thinned to the newest 200 and the last of each day', () => {
  const file = place()
  write(file, [a])
  const day = Date.UTC(2026, 9, 1, 12, 0, 0)
  // 50 copies on day 1, then 210 on day 2: the newest 200 are all from day 2
  let n = 0
  const stamps = []
  for (let i = 0; i < 50; i++) stamps.push(day + i * 1000)
  for (let i = 0; i < 210; i++) stamps.push(day + 86400000 + i * 1000)
  stamps.forEach(t => write(file, [Object.assign({}, a, { password: 'enc:' + (n++) })], { now: t }))
  const names = backups(file).map(p => path.basename(p))
  assert.strictEqual(names.length, 201)
  // the very first copy is gone, but day 1 still has its last copy
  const first = new Date(day)
  const d1 = String(first.getFullYear()) + String(first.getMonth() + 1).padStart(2, '0') + String(first.getDate()).padStart(2, '0')
  assert.ok(names.some(x => x.indexOf('iris-accounts-' + d1) === 0))
})
