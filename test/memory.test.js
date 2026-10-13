'use strict'

const test = require('node:test')
const assert = require('node:assert')

const { createMemory, extractIds, normalizeUrl } = require('../iris/agent/memory')

test('identifiers ignore versions and how the paper was written down', () => {
  assert.deepStrictEqual(extractIds('2610.05861v1.pdf'), ['arxiv:2610.05861'])
  assert.deepStrictEqual(extractIds('https://arxiv.org/abs/2610.05861'), ['arxiv:2610.05861'])
  assert.deepStrictEqual(extractIds('see doi 10.1145/3611643.3616243.'), ['doi:10.1145/3611643.3616243'])
  assert.deepStrictEqual(extractIds('version 12.34 of the app'), [])
})

test('urls are compared without scheme, www, fragments or tracking', () => {
  assert.strictEqual(normalizeUrl('https://www.Example.com/a/?utm_source=x&q=cats#top'), 'example.com/a?q=cats')
})

test('the same paper is found as already downloaded however it is linked', () => {
  const m = createMemory()
  m.add('download', 'Downloaded 2610.05861v1.pdf', { name: '2610.05861v1.pdf', url: 'https://arxiv.org/pdf/2610.05861v1' })
  assert.ok(m.findDownload('https://arxiv.org/pdf/2610.05861v2', '2610.05861v2.pdf'))
  assert.ok(m.findDownload('https://export.arxiv.org/abs/2610.05861', ''))
  assert.strictEqual(m.findDownload('https://arxiv.org/pdf/2610.09999v1', '2610.09999v1.pdf'), null)
})

test('a plain file without ids matches by its exact url', () => {
  const m = createMemory()
  m.add('download', 'Downloaded report.pdf', { name: 'report.pdf', url: 'https://site.test/files/report.pdf?utm_campaign=z' })
  assert.ok(m.findDownload('https://www.site.test/files/report.pdf', 'report.pdf'))
  assert.strictEqual(m.findDownload('https://site.test/files/other.pdf', 'other.pdf'), null)
})

test('recall finds by id first, then by shared words, newest first on a tie', () => {
  const m = createMemory()
  m.add('note', 'PhoneCLI (2609.35671) is about mobile GUI agents')
  m.add('note', 'WebPageBench evaluates web agents on real pages')
  m.add('visit', 'arXiv listing', { url: 'https://arxiv.org/list/cs.AI/recent', title: 'Artificial Intelligence' })
  assert.match(m.search('2609.35671v2')[0].text, /PhoneCLI/)
  assert.match(m.search('benchmark for web agents')[0].text, /WebPageBench/)
  assert.strictEqual(m.search('quantum chemistry').length, 0)
})

test('memory survives a save and load', () => {
  const m = createMemory()
  m.add('download', 'Downloaded a.pdf', { name: '2601.00001v1.pdf', url: 'https://arxiv.org/pdf/2601.00001v1' })
  const again = createMemory(JSON.parse(JSON.stringify(m.items())))
  assert.ok(again.findDownload('https://arxiv.org/abs/2601.00001', ''))
  assert.strictEqual(again.count('download'), 1)
})
