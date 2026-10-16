'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { createLookup, parseLookups, parseDuckDuckGo, parseBing, parseOpenAlex, parseArxiv, readableText, looksBlocked, isNever } = require('../iris/agent/lookup')

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
  assert.strictEqual(log.length, 3, 'DuckDuckGo twice, then Bing; the second identical look-up came from the cache')
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

test('a page that needs JavaScript is reported, not returned empty', async () => {
  const lk = createLookup(Object.assign({ fetch: fakeFetch([['spa.test', '<html><title>App</title><body><div id="root"></div><script>boot()</script></body></html>']]) }, instant))
  const r = await lk.lookup({ kind: 'page', query: 'https://spa.test/' })
  assert.strictEqual(r.ok, false)
  assert.match(r.text, /needs JavaScript/)
})

test('a PDF is left to the browser', async () => {
  const lk = createLookup(Object.assign({ fetch: fakeFetch([['paper.test', '%PDF-1.4 ' + 'x'.repeat(500), 200, 'application/pdf']]) }, instant))
  const r = await lk.lookup({ kind: 'page', query: 'paper.test/a.pdf' })
  assert.strictEqual(r.ok, false)
  assert.match(r.text, /PDF/)
})

test('requests to the same site are spaced out', async () => {
  let clock = 0
  const waits = []
  const lk = createLookup({
    fetch: fakeFetch([['duckduckgo', DDG]]),
    now: () => clock,
    delay: async (ms) => { waits.push(ms); clock += ms }
  })
  await lk.lookup({ kind: 'web', query: 'one' })
  await lk.lookup({ kind: 'web', query: 'two' })
  assert.deepStrictEqual(waits, [1500])
})

test('arXiv: long queries fall back to fewer key words when nothing matches', async () => {
  const log = []
  const entry = '<feed><entry><id>http://arxiv.org/abs/2605.18747v1</id><published>2026-05-01</published><title>Code as Agent Harness</title><summary>x</summary></entry></feed>'
  const lk = createLookup(Object.assign({
    fetch: async (url) => { log.push(url); const hits = (url.match(/all:/g) || []).length <= 3; return { status: 200, url, text: async () => hits ? entry : '<feed></feed>', headers: { get: () => 'application/atom+xml' } } }
  }, instant))
  const r = await lk.lookup({ kind: 'arxiv', query: 'browser agent LLM visual perception desktop 2026 papers' })
  assert.strictEqual(r.count, 1)
  assert.strictEqual(log.length, 2)
  assert.ok(!/all:2026|all:papers/.test(log[0]), 'years and filler words are not search terms')
})

test('Bing redirect links become the real addresses', () => {
  const real = Buffer.from('https://jobs.lever.co/acme/123').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const html = '<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=a1' + real + '&amp;ntb=1">ML Engineer - Acme</a></h2><p>Remote</p></li>'
  const r = parseBing(html, 5)
  assert.strictEqual(r[0].url, 'https://jobs.lever.co/acme/123')
})

test('site: searches only return that site; DuckDuckGo gets a second try', async () => {
  const log = []
  let ddgCalls = 0
  const fetch = async (url) => {
    log.push(url)
    if (/duckduckgo/.test(url)) {
      ddgCalls++
      return { status: ddgCalls === 1 ? 202 : 200, url, text: async () => ddgCalls === 1 ? '' : '<a class="result__a" href="https://jobs.lever.co/acme/1">ML Engineer</a><a class="result__a" href="https://example.com/x">Other</a>', headers: { get: () => 'text/html' } }
    }
    return { status: 404, url, text: async () => '', headers: { get: () => 'text/html' } }
  }
  const lk = createLookup({ fetch, delay: async () => {}, now: () => 0 })
  const r = await lk.lookup({ kind: 'web', query: 'site:jobs.lever.co ml engineer' })
  assert.ok(r.ok)
  assert.strictEqual(r.count, 1)
  assert.match(r.text, /jobs\.lever\.co\/acme\/1/)
  assert.ok(!/example\.com/.test(r.text))
  assert.strictEqual(ddgCalls, 2)
})

test('job boards: the address picks the board, words pick the openings', async () => {
  const { parseJobBoardQuery } = require('../iris/agent/lookup')
  assert.deepStrictEqual(parseJobBoardQuery('https://jobs.ashbyhq.com/ramp software engineer Canada'), { ats: 'ashby', company: 'ramp', words: ['software', 'engineer', 'canada'] })
  assert.strictEqual(parseJobBoardQuery('boards.greenhouse.io/gitlab').ats, 'greenhouse')
  assert.strictEqual(parseJobBoardQuery('jobs.lever.co/palantir backend').company, 'palantir')
  const board = { jobs: [
    { title: 'Security Engineer', location: 'New York', secondaryLocations: [{ location: 'Remote (Canada)' }], department: 'Engineering', jobUrl: 'https://jobs.ashbyhq.com/ramp/1', isRemote: true },
    { title: 'Account Executive', location: 'Toronto', department: 'Sales', jobUrl: 'https://jobs.ashbyhq.com/ramp/2' },
    { title: 'Software Engineer, Backend', location: 'Remote (Canada)', department: 'Engineering', jobUrl: 'https://jobs.ashbyhq.com/ramp/3' }
  ] }
  const lk = createLookup({ fetch: async (url) => ({ status: 200, url, text: async () => JSON.stringify(board), headers: { get: () => 'application/json' } }), delay: async () => {}, now: () => 0 })
  const r = await lk.lookup({ kind: 'jobs', query: 'jobs.ashbyhq.com/ramp software engineer canada' })
  assert.ok(r.ok)
  assert.match(r.text, /Openings for .*\(ramp on ashby, 3 open\)/)
  assert.match(r.text.split('\n')[1], /Software Engineer, Backend/, 'the best match comes first')
  assert.ok(!/Account Executive/.test(r.text))
})
