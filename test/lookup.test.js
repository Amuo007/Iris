'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { createLookup, parseHackerNews, parseLookups, parseDuckDuckGo, parseBing, parseOpenAlex, parseArxiv, readableText, looksBlocked, isNever } = require('../iris/agent/lookup')

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
    { title: 'Software Engineer, Backend', location: 'Remote (US)', department: 'Engineering', jobUrl: 'https://jobs.ashbyhq.com/ramp/3' },
    { title: 'Software Engineer, Payments', location: 'Toronto', department: 'Engineering', jobUrl: 'https://jobs.ashbyhq.com/ramp/4' }
  ] }
  const lk = createLookup({ fetch: async (url) => ({ status: 200, url, text: async () => JSON.stringify(board), headers: { get: () => 'application/json' } }), delay: async () => {}, now: () => 0 })
  const r = await lk.lookup({ kind: 'jobs', query: 'jobs.ashbyhq.com/ramp software engineer remote' })
  assert.ok(r.ok)
  assert.match(r.text, /Openings for .*\(ramp on ashby, 4 open\)/)
  assert.match(r.text.split('\n')[1], /Software Engineer, Backend/, 'the best match comes first')
  assert.ok(!/Account Executive/.test(r.text))
  assert.ok(!/Payments/.test(r.text), 'a posting outside the US is not shown')
})

test('a job posting can be read further than a usual page, so its requirements are not cut off', async () => {
  const intro = '<p>' + 'We build sensors that run for years on a coin cell. '.repeat(90) + '</p>'
  const html = '<html><title>Embedded Software Engineer</title><body><h1>Embedded Software Engineer</h1>' + intro + '<h2>What you bring</h2><ul><li>2+ years writing embedded C</li></ul></body></html>'
  const lk = createLookup(Object.assign({ fetch: fakeFetch([['jobs.test', html]]) }, instant))
  const short = await lk.lookup({ kind: 'page', query: 'https://jobs.test/emb' })
  assert.ok(short.ok)
  assert.doesNotMatch(short.text, /2\+ years writing embedded C/)
  const long = await lk.lookup({ kind: 'page', query: 'https://jobs.test/emb', chars: 8000 })
  assert.match(long.text, /2\+ years writing embedded C/)
})

test('an Ashby posting (a JavaScript page) is read from Ashby\'s public posting API', async () => {
  const id = '34413f8d-26bf-4bbc-8ade-eb309a0e2245'
  const board = { jobs: [{ id, title: ' Security Engineer, Cloud', location: 'New York', department: 'Engineering', jobUrl: 'https://jobs.ashbyhq.com/ramp/' + id, descriptionPlain: 'What you bring: 3+ years securing AWS.' }] }
  const log = []
  const lk = createLookup(Object.assign({ fetch: fakeFetch([['api.ashbyhq.com/posting-api/job-board/ramp', JSON.stringify(board), 200, 'application/json']], log) }, instant))
  const r = await lk.lookup({ kind: 'page', query: 'https://jobs.ashbyhq.com/ramp/' + id + '/application', chars: 8000 })
  assert.ok(r.ok)
  assert.strictEqual(r.items[0].title, 'Security Engineer, Cloud')
  assert.match(r.items[0].text, /3\+ years securing AWS/)
  assert.ok(!log.some(u => u.startsWith('https://jobs.ashbyhq.com')), 'the JavaScript page itself is not fetched')
})

test('a Workday posting (a JavaScript page) is read from the site\'s own JSON endpoint', async () => {
  const info = { jobPostingInfo: { title: 'Software Engineer, SPE', location: 'Yokneam', timeType: 'Full time', jobDescription: '<p>We need <b>3+ years</b> of C++.</p><ul><li>Python</li></ul>', externalUrl: 'https://acme.wd5.myworkdayjobs.com/Site/job/X/Software-Engineer_JR1' } }
  const log = []
  const lk = createLookup(Object.assign({ fetch: fakeFetch([['acme.wd5.myworkdayjobs.com/wday/cxs/acme/Site/job/X/Software-Engineer_JR1', JSON.stringify(info), 200, 'application/json']], log) }, instant))
  const r = await lk.lookup({ kind: 'page', query: 'https://acme.wd5.myworkdayjobs.com/en-US/Site/job/X/Software-Engineer_JR1/apply', chars: 8000 })
  assert.ok(r.ok, r.text)
  assert.strictEqual(r.items[0].title, 'Software Engineer, SPE')
  assert.match(r.items[0].text, /3\+ years of C\+\+/)
  assert.match(r.items[0].text, /Python/)
})

test('a Workday board is searched on its side; with no hits the last words (a place) only rank the results', async () => {
  const asked = []
  const fetch = async (url, opts) => {
    const body = JSON.parse(opts.body)
    asked.push(body.searchText)
    const hits = body.searchText === 'firmware' ? [
      { title: 'Firmware Engineer', locationsText: 'US, Santa Clara', externalPath: '/job/US/Firmware-Engineer_JR1' },
      { title: 'Firmware Engineer II', locationsText: 'US, Austin', externalPath: '/job/US-Austin/Firmware-Engineer-II_JR2' },
      { title: 'Firmware Engineer III', locationsText: 'Canada, Toronto', externalPath: '/job/Canada-Toronto/Firmware-Engineer-III_JR3' }
    ] : []
    return { status: 200, url, text: async () => JSON.stringify({ total: hits.length, jobPostings: hits }), headers: { get: () => 'application/json' } }
  }
  const lk = createLookup(Object.assign({ fetch }, instant))
  const r = await lk.lookup({ kind: 'jobs', query: 'acme.wd5.myworkdayjobs.com/en-US/External firmware austin' })
  assert.deepStrictEqual(asked, ['firmware austin', 'firmware'])
  assert.strictEqual(r.items[0].title, 'Firmware Engineer II', 'the one in Austin first')
  assert.strictEqual(r.items[0].url, 'https://acme.wd5.myworkdayjobs.com/External/job/US-Austin/Firmware-Engineer-II_JR2')
  assert.ok(!r.items.some(j => /Toronto/.test(j.location)), 'a posting outside the US is not shown')
})

test('Hacker News discussions come from its public search, with entities decoded', () => {
  const items = parseHackerNews({ hits: [{ objectID: '1', story_id: 42, title: 'Strix Halo for local LLMs', url: 'https://example.test/post', points: 120, num_comments: 80, created_at: '2026-03-01T00:00:00Z', story_text: 'Runs Qwen at 40 t&#x2F;s &amp; more' }] }, 5)
  assert.strictEqual(items[0].url, 'https://news.ycombinator.com/item?id=42')
  assert.match(items[0].snippet, /120 points, 80 comments\. Runs Qwen at 40 t\/s & more/)
  assert.strictEqual(items[0].year, 2026)
})

test('a site: search for one job board keeps postings from other boards when that board has none', async () => {
  const bing = '<li class="b_algo"><h2><a href="https://boards.greenhouse.io/acme/jobs/1">Software Engineer - Acme</a></h2><p>Toronto</p></li>' +
    '<li class="b_algo"><h2><a href="https://en.wikipedia.org/wiki/Software_engineer">Software engineer</a></h2><p>x</p></li>'
  const lk = createLookup(Object.assign({ fetch: fakeFetch([['duckduckgo.com', '<html>no results</html>'], ['bing.com/search', bing]]) }, instant))
  const r = await lk.lookup({ kind: 'web', query: 'site:jobs.lever.co software engineer Toronto' })
  assert.ok(r.ok, r.text)
  assert.match(r.text, /other job boards/)
  assert.match(r.text, /boards\.greenhouse\.io\/acme\/jobs\/1/)
  assert.doesNotMatch(r.text, /wikipedia/)
})


test('fresh lists (SimplifyJobs rows): US computer work, open, not over, newest day first and easy boards first', () => {
  const { parseFreshListings } = require('../iris/agent/lookup.js')
  const now = Date.UTC(2026, 9, 18, 12) / 1000
  const row = (o) => Object.assign({ active: true, is_visible: true, category: 'Software', title: 'Software Engineer Intern', company_name: 'Acme', locations: ['Austin, TX'], url: 'https://x.example/' + Math.random(), date_posted: now - 3600, terms: ['Summer 2027'], degrees: ["Bachelor's"] }, o)
  const rows = [
    row({ company_name: 'Old', date_posted: now - 5 * 86400 }),
    row({ company_name: 'Hard', url: 'https://acme.wd1.myworkdayjobs.com/x', date_posted: now - 1800 }),
    row({ company_name: 'Easy', url: 'https://jobs.lever.co/easy/1/apply', date_posted: now - 7200 }),
    row({ company_name: 'Abroad', locations: ['Toronto, ON, Canada'] }),
    row({ company_name: 'Closed', active: false }),
    row({ company_name: 'Ops', title: 'Operations Intern' }),
    row({ company_name: 'Past', terms: ['Summer 2026'] }),
    row({ company_name: 'PhD', degrees: ['PhD'] }),
    row({ company_name: 'Citizen', sponsorship: 'U.S. Citizenship is Required' }),
    row({ company_name: 'Chips', category: 'Hardware', title: 'Firmware Engineer Intern' }),
    row({ company_name: 'Mech', category: 'Hardware', title: 'Mechanical Design Intern' })
  ]
  const names = parseFreshListings(rows, [], now).map(j => j.title.split(' — ')[0])
  assert.deepStrictEqual(names, ['Easy', 'Hard', 'Chips', 'Old'])
  assert.deepStrictEqual(parseFreshListings(rows, ['firmware'], now).map(j => j.title.split(' — ')[0]), ['Chips'])
  assert.match(parseFreshListings(rows, [], now)[0].year, /posted 2 h ago/)
})
