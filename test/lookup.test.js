'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { createLookup, parseLookups, parseDuckDuckGo, parseOpenAlex, parseArxiv, readableText, looksBlocked, isNever } = require('../iris/agent/lookup')

function fakeFetch (routes, log) {
  return async (url) => {
    log && log.push(url)
    const r = routes.find(x => url.indexOf(x[0]) !== -1)
    if (!r) return { status: 404, text: async () => '', headers: { get: () => 'text/html' } }
    return { status: r[2] || 200, url, text: async () => r[1], headers: { get: () => r[3] || 'text/html' } }
  }
}
const instant = { delay: async () => {}, now: () => 0 }

const DDG = '<div><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fski.test%2Fboots&rut=x">Best &amp; boots</a>' +
  '<a class="result__snippet" href="x">Our <b>top</b> picks</a></div>' +
  '<div><a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=ads.test">Ad</a></div>' +
  '<div><a class="result__a" href="https://two.test/">Two</a><a class="result__snippet">second</a></div>'

test('DuckDuckGo results: real URLs, decoded titles, ads dropped', () => {
  const r = parseDuckDuckGo(DDG, 5)
  assert.deepStrictEqual(r.map(x => x.url), ['https://ski.test/boots', 'https://two.test/'])
  assert.strictEqual(r[0].title, 'Best & boots')
  assert.strictEqual(r[0].snippet, 'Our top picks')
})

test('OpenAlex works: abstract rebuilt, arXiv id found', () => {
  const r = parseOpenAlex({ results: [{ title: 'Harness', publication_year: 2026, cited_by_count: 4, primary_location: { landing_page_url: 'https://arxiv.org/abs/2601.01234' }, abstract_inverted_index: { We: [0], build: [1], harnesses: [2] } }] }, 5)
  assert.strictEqual(r[0].id, 'arXiv 2601.01234')
  assert.strictEqual(r[0].abstract, 'We build harnesses')
  assert.strictEqual(r[0].url, 'https://arxiv.org/abs/2601.01234')
})

test('arXiv Atom entries', () => {
  const xml = '<feed><entry><id>http://arxiv.org/abs/2605.18747v2</id><published>2026-05-20T00:00:00Z</published><title>Code as  Agent Harness</title><summary>Recent LLMs...</summary></entry></feed>'
  const r = parseArxiv(xml, 5)
  assert.strictEqual(r[0].id, 'arXiv 2605.18747')
  assert.strictEqual(r[0].title, 'Code as Agent Harness')
})

test('readable text drops menus and scripts', () => {
  const menu = Array.from({ length: 12 }, (_, i) => '<li>Lang ' + i + '</li>').join('')
  const html = '<title>T</title><script>var captcha=1</script><ul>' + menu + '</ul><p>' + 'Real content sentence. '.repeat(10) + '</p>'
  const r = readableText(html, 5000)
  assert.strictEqual(r.title, 'T')
  assert.ok(!/Lang 3/.test(r.text))
  assert.match(r.text, /Real content sentence/)
  assert.ok(!/captcha/.test(r.text))
})

test('bot walls are recognised, real articles that mention captcha are not', () => {
  assert.ok(looksBlocked(200, '<title>Just a moment...</title>'))
  assert.ok(looksBlocked(429, ''))
  assert.ok(!looksBlocked(200, '<title>Web browser</title>' + 'x'.repeat(50000) + 'captcha'))
})

test('banned sites are never contacted', async () => {
  const log = []
  const lk = createLookup(Object.assign({ fetch: fakeFetch([], log), never: ['example-bank.test'] }, instant))
  assert.ok(isNever('https://www.linkedin.com/jobs/view/1'))
  const r = await lk.lookup({ kind: 'page', query: 'https://www.linkedin.com/in/someone' })
  assert.strictEqual(r.ok, false)
  assert.match(r.text, /bans accounts/)
  const r2 = await lk.lookup({ kind: 'page', query: 'https://login.example-bank.test/' })
  assert.strictEqual(r2.ok, false)
  assert.strictEqual(log.length, 0)
})

test('web falls back to Bing when DuckDuckGo refuses, and results are cached', async () => {
  const log = []
  const bing = '<li class="b_algo"><h2><a href="https://b.test/">B title</a></h2><p>b snippet</p></li>'
  const lk = createLookup(Object.assign({ fetch: fakeFetch([['duckduckgo', 'no', 202], ['bing.com', bing]], log) }, instant))
  const r = await lk.lookup({ kind: 'web', query: 'q' })
  assert.ok(r.ok)
  assert.match(r.text, /\(Bing\)[\s\S]*B title — https:\/\/b\.test\//)
  await lk.lookup({ kind: 'web', query: 'Q' })
  assert.strictEqual(log.length, 2, 'the second identical look-up came from the cache')
})

test('annotate marks things seen before', async () => {
  const lk = createLookup(Object.assign({ fetch: fakeFetch([['duckduckgo', DDG]]) }, instant))
  const r = await lk.lookup({ kind: 'web', query: 'boots' }, { annotate: (it) => it.url === 'https://two.test/' ? 'skipped before' : null })
  assert.match(r.text, /two\.test\/ {2}\[skipped before\]/)
})

test('a failing source becomes readable text, not an exception', async () => {
  const lk = createLookup(Object.assign({ fetch: async () => { throw new Error('offline') } }, instant))
  const r = await lk.lookup({ kind: 'papers', query: 'x' })
  assert.strictEqual(r.ok, false)
  assert.match(r.text, /failed: offline/)
})

test('parseLookups reads the planner\'s request', () => {
  assert.deepStrictEqual(parseLookups('{"lookups":[{"kind":"papers","query":"harness"},"plain words"]}'), [{ kind: 'papers', query: 'harness' }, { kind: 'web', query: 'plain words' }])
  assert.strictEqual(parseLookups('Goal: x'), null)
})
