'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createListFile } = require('../iris/agent/listFile')

function tempDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'iris-listfile-'))
}

test('a save is read back, the old list kept as .bak, no temporary file left', () => {
  const dir = tempDir()
  const file = path.join(dir, 'iris-applications.json')
  const store = createListFile({ fs, file, key: 'items', keep: 5000 })
  assert.deepStrictEqual(store.load(), [], 'no file yet: no items')
  store.save([{ id: 'a' }])
  store.save([{ id: 'a' }, { id: 'b' }])
  assert.deepStrictEqual(store.load().map(x => x.id), ['a', 'b'])
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(store.bak, 'utf8')).items.map(x => x.id), ['a'])
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['iris-applications.bak.json', 'iris-applications.json'])
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600)
  assert.strictEqual(fs.statSync(store.bak).mode & 0o777, 0o600)
})

test('a broken file is kept aside and the backup is read, never an empty list', () => {
  const dir = tempDir()
  const file = path.join(dir, 'iris-applications.json')
  const logs = []
  const store = createListFile({ fs, file, key: 'items', log: (m) => logs.push(m), now: () => Date.UTC(2026, 9, 24, 22, 0) })
  store.save(Array.from({ length: 3 }, (_, i) => ({ id: 'job' + i })))
  store.save(Array.from({ length: 4 }, (_, i) => ({ id: 'job' + i })))
  fs.writeFileSync(file, '{"items": [ {"id": "job0"}, {"id":') // a write cut off halfway
  const items = store.load()
  assert.strictEqual(items.length, 3, 'the backup (the list before the last save)')
  const names = fs.readdirSync(dir)
  assert.ok(names.some(n => /^iris-applications\.unreadable-2026-10-24T22-00-00-000Z\.json$/.test(n)), names.join(', '))
  assert.ok(!names.includes('iris-applications.json'))
  assert.ok(logs.length === 1 && /broken/.test(logs[0]))
  // the next save writes the full list again, and the backup it read stays as it was
  store.save(items.concat({ id: 'job9' }))
  assert.strictEqual(store.load().length, 4)
  assert.strictEqual(JSON.parse(fs.readFileSync(store.bak, 'utf8')).items.length, 3)
})

test('only the newest items are kept', () => {
  const dir = tempDir()
  const store = createListFile({ fs, file: path.join(dir, 'list.json'), keep: 2 })
  assert.deepStrictEqual(store.save([1, 2, 3]), [2, 3])
  assert.deepStrictEqual(store.load(), [2, 3])
})
