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

test('fresh lists: 2 a company, "-company" leaves one out, handled jobs gone (10-25: RTX and Dell filled all 15)', async () => {
  const row = (co, i, o) => Object.assign({ active: true, is_visible: true, category: 'Software', title: 'Software Engineer I', company_name: co, locations: ['Austin, TX'], url: 'https://jobs.lever.co/' + co.toLowerCase() + '/' + i, date_posted: -i * 60, degrees: ["Bachelor's"] }, o || {})
  const rows = []
  for (let i = 0; i < 12; i++) rows.push(row('Rotex', i))
  for (let i = 12; i < 20; i++) rows.push(row('Dell', i))
  for (let i = 20; i < 23; i++) rows.push(row('Acme', i))
  rows.push(row('Beta', 23), row('Beta', 24))
  const lk = createLookup(Object.assign({ fetch: fakeFetch([['New-Grad-Positions', JSON.stringify(rows), 200, 'application/json'], ['Internships', '[]', 200, 'application/json']]) }, instant))
  const handled = { annotate: (it) => it.url.endsWith('/beta/23') ? 'you logged this job "applied" on Oct 24' : null }
  const companies = (r) => r.items.map(it => it.company)
  let r = await lk.lookup({ kind: 'jobs', query: 'fresh new grad software engineer' }, handled)
  assert.deepStrictEqual(companies(r), ['Rotex', 'Rotex', 'Dell', 'Dell', 'Acme', 'Acme', 'Beta'])
  assert.match(r.text, /24 not handled yet, the newest 15 shown \(2 a company; add "-company" to leave one out\)/)
  r = await lk.lookup({ kind: 'jobs', query: 'fresh new grad software -rotex -dell' }, handled)
  assert.deepStrictEqual(companies(r), ['Acme', 'Acme', 'Beta'])
  assert.match(r.text, /without rotex \/ dell/)
  // "-intern" is a word left out, not a pick of the internship list
  r = await lk.lookup({ kind: 'jobs', query: 'fresh new grad -intern' }, handled)
  assert.strictEqual(r.items.length, 7)
  r = await lk.lookup({ kind: 'jobs', query: 'fresh new grad -acme -rotex -dell -beta' }, handled)
  assert.strictEqual(r.items.length, 0)
  assert.match(r.text, /nothing found/)
})

test('fresh new grad: the second list joins in, without Simplify repeats or jobs that do not sponsor', async () => {
  const row = (co, title, o) => Object.assign({ active: true, is_visible: true, category: 'Software', title: title, company_name: co, locations: ['Austin, TX'], url: 'https://jobs.lever.co/' + co.toLowerCase() + '/' + title.length, date_posted: -60, degrees: ["Bachelor's"] }, o || {})
  const simplify = [row('Acme', 'Software Engineer I'), row('NoVisa', 'Software Engineer', { sponsorship: 'Does Not Offer Sponsorship' })]
  // the vanshb03 list: no categories, short links
  const vansh = [
    { active: true, is_visible: true, company_name: 'Acme', title: 'Software Engineer I', locations: ['Austin, TX'], url: 'https://go.vansh.nyc/a1', date_posted: -30 },
    { active: true, is_visible: true, company_name: 'Softheon', title: 'Software Engineer I - Membership', locations: ['Remote', 'US'], url: 'https://go.vansh.nyc/s9', date_posted: -30, sponsorship: 'Other' },
    { active: true, is_visible: true, company_name: 'Shop', title: 'Store Associate', locations: ['Austin, TX'], url: 'https://go.vansh.nyc/x', date_posted: -30 }
  ]
  const routes = [['New-Grad-Positions', JSON.stringify(simplify), 200, 'application/json'], ['vanshb03/New-Grad-2027', JSON.stringify(vansh), 200, 'application/json']]
  const lk = createLookup(Object.assign({ fetch: fakeFetch(routes) }, instant))
  const r = await lk.lookup({ kind: 'jobs', query: 'fresh new grad' })
  assert.deepStrictEqual(r.items.map(it => it.company + ' / ' + it.role + ' / ' + it.shortLink), ['Acme / Software Engineer I / false', 'Softheon / Software Engineer I - Membership / true'])
  // the short link does not answer here (404): it stays a short link, told by company and title
  assert.match(r.text, /SimplifyJobs new grad \+ vanshb03 new grad lists/)
  assert.match(r.text, /Softheon — Software Engineer I - Membership \(Remote, new grad/)
  // the second list down: Simplify's alone, no error
  const lk2 = createLookup(Object.assign({ fetch: fakeFetch(routes.slice(0, 1)) }, instant))
  const r2 = await lk2.lookup({ kind: 'jobs', query: 'fresh new grad' })
  assert.ok(r2.ok)
  assert.deepStrictEqual(r2.items.map(it => it.company), ['Acme'])
})

test('fresh new grad: a short link is read for the posting address, so a job handled there stays out', async () => {
  const vansh = [
    { active: true, is_visible: true, company_name: 'Palantir', title: 'New Grad 2027: Forward Deployed Software Engineer, Warp Speed', locations: ['New York, NY'], url: 'https://go.vansh.nyc/p1', date_posted: -10 },
    { active: true, is_visible: true, company_name: 'Softheon', title: 'Software Engineer I', locations: ['Remote', 'US'], url: 'https://go.vansh.nyc/s9', date_posted: -20 }
  ]
  const where = { 'https://go.vansh.nyc/p1': 'https://jobs.lever.co/palantir/66b495eb-aaf9-4bf9-a759-41854534add7', 'https://go.vansh.nyc/s9': 'https://jobs.lever.co/softheon/1234' }
  const heads = []
  const fetch = async (url, opts) => {
    if (/go\.vansh\.nyc/.test(url)) {
      heads.push((opts || {}).method + ' ' + (opts || {}).redirect)
      return { status: 302, url, headers: { get: (h) => h === 'location' ? where[url] : null }, text: async () => '' }
    }
    if (/vanshb03/.test(url)) return { status: 200, url, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(vansh) }
    return { status: 200, url, headers: { get: () => 'application/json' }, text: async () => '[]' }
  }
  const lk = createLookup(Object.assign({ fetch }, instant))
  const handled = { annotate: (it) => /66b495eb/.test(it.url) ? 'you logged this job "applied" on Oct 22' : null }
  const r = await lk.lookup({ kind: 'jobs', query: 'fresh new grad' }, handled)
  assert.deepStrictEqual(r.items.map(it => it.url), ['https://jobs.lever.co/softheon/1234'])
  assert.strictEqual(r.items[0].shortLink, false)
  assert.match(r.text, /1 not handled yet/)
  assert.deepStrictEqual(heads, ['HEAD manual', 'HEAD manual'])
  // read once for the session
  await lk.lookup({ kind: 'jobs', query: 'fresh new grad software' }, handled)
  assert.strictEqual(heads.length, 2)
})

test('fresh lists: "(Master\'s)" titles are left out, "-rtx" matches the address too', () => {
  const { parseFreshListings } = require('../iris/agent/lookup.js')
  const row = (o) => Object.assign({ active: true, is_visible: true, category: 'Software', title: 'Software Engineer I', company_name: 'Acme', locations: ['Austin, TX'], url: 'https://jobs.lever.co/acme/' + Math.random(), date_posted: 0 }, o)
  const rows = [
    row({ company_name: 'Collins Aerospace', url: 'https://globalhr.wd5.myworkdayjobs.com/en-US/rec_rtx/job/x_01' }),
    row({ company_name: 'Intel', title: 'Software Engineer, CAD/EDA Tools (Master\'s)' }),
    row({ company_name: 'Lab', title: 'Research Engineer (PhD)' }),
    row({ company_name: 'Acme' })
  ]
  assert.deepStrictEqual(parseFreshListings(rows, [], 0, ['rtx']).map(j => j.company), ['Acme'])
  assert.deepStrictEqual(parseFreshListings(rows, [], 0, []).map(j => j.company), ['Acme', 'Collins Aerospace'])
})

test('fresh lists: "-applied-materials" and "-brain-co" leave those companies out, "-ea" only Electronic Arts\' own jobs', () => {
  const { parseFreshListings } = require('../iris/agent/lookup.js')
  const row = (co, o) => Object.assign({ active: true, is_visible: true, category: 'Software', title: 'Software Engineer I', company_name: co, locations: ['Austin, TX'], url: 'https://jobs.lever.co/' + co.replace(/\W/g, '').toLowerCase() + '/1', date_posted: 0 }, o || {})
  const rows = [
    row('Applied Materials'), row('Brain Co.'), row('D.R. Horton'), row('Johns Hopkins University Applied Physics Laboratory'),
    row('Electronic Arts', { url: 'https://jobs.ea.com/en_US/careers/JobDetail/1' }),
    row('Learning Co', { title: 'Machine Learning Engineer' }),
    row('Sephora'), row('Citizens Bank')
  ]
  const left = (not) => parseFreshListings(rows, [], 0, not).map(j => j.company)
  assert.deepStrictEqual(left(['applied-materials', 'brain-co', 'dr-horton', 'johns-hopkins', 'ea']), ['Learning Co', 'Sephora', 'Citizens Bank'])
  // short words only as whole names or words: "-sep" is no Sephora, "-citi" no Citizens Bank
  assert.deepStrictEqual(left(['sep', 'citi']).length, 7)
  // and the start of a name only in whole words: "-intel" is no Intellias, "-amazon" is Amazon Web Services too
  const more = [row('Intellias'), row('Intel'), row('Amazon Web Services')]
  assert.deepStrictEqual(parseFreshListings(more, [], 0, ['intel', 'amazon']).map(j => j.company), ['Intellias'])
})

test('fresh look-up: a long "-company" list is read whole, and shown short', async () => {
  const rows = []
  for (let i = 0; i < 130; i++) rows.push({ active: true, is_visible: true, category: 'Software', title: 'Software Engineer', company_name: 'Company ' + i, locations: ['Austin, TX'], url: 'https://jobs.lever.co/c' + i + '/1', date_posted: 0 })
  const lk = createLookup(Object.assign({ fetch: fakeFetch([['New-Grad-Positions', JSON.stringify(rows), 200, 'application/json']]) }, instant))
  const not = []
  for (let i = 0; i < 129; i++) not.push('-company-' + i)
  const r = await lk.lookup({ kind: 'jobs', query: 'fresh new grad ' + not.join(' ') })
  assert.deepStrictEqual(r.items.map(it => it.company), ['Company 129'])
  assert.match(r.text, /without company-0 \/ company-1 \/ company-2 \/ company-3 \/ company-4 \/ company-5 and 123 more/)
})

test('fresh look-up: a state\'s name keeps the jobs there ("fresh new grad software texas")', async () => {
  const row = (co, locs) => ({ active: true, is_visible: true, category: 'Software', title: 'Software Engineer I', company_name: co, locations: locs, url: 'https://jobs.lever.co/' + co.toLowerCase() + '/1', date_posted: 0 })
  const rows = [row('Austin Co', ['Austin, TX']), row('Bay Co', ['San Francisco, CA']), row('Both Co', ['Seattle, WA', 'Dallas, TX']), row('Spelled Co', ['Houston, Texas']), row('Remote Co', ['Remote in USA']), row('WV Co', ['Charleston, WV']), row('VA Co', ['Reston, VA'])]
  const lk = createLookup(Object.assign({ fetch: fakeFetch([['New-Grad-Positions', JSON.stringify(rows), 200, 'application/json']]) }, instant))
  const r = await lk.lookup({ kind: 'jobs', query: 'fresh new grad software texas' })
  assert.deepStrictEqual(r.items.map(it => it.company).sort(), ['Austin Co', 'Both Co', 'Spelled Co'])
  assert.match(r.text, /, in texas/)
  // "west virginia" is not Virginia
  const w = await lk.lookup({ kind: 'jobs', query: 'fresh new grad west virginia' })
  assert.deepStrictEqual(w.items.map(it => it.company), ['WV Co'])
  // no state: every US place, as before
  const all = await lk.lookup({ kind: 'jobs', query: 'fresh new grad software' })
  assert.strictEqual(all.items.length, 7)
})

test('a posting\'s eligibility lines: sponsorship, citizenship, clearance — not equal-opportunity boilerplate', () => {
  const { eligibilityLines } = require('../iris/agent/lookup')
  const text = 'Build services in Go.\nWe do not offer any type of employment-based immigration sponsorship for this program. ' +
    'Must be a U.S. citizen with an active Secret clearance.\nQualified applicants will receive consideration without regard to race, citizenship status or national origin. ' +
    'We participate in E-Verify.\nBenefits: 401k.'
  assert.deepStrictEqual(eligibilityLines(text), ['We do not offer any type of employment-based immigration sponsorship for this program.', 'Must be a U.S. citizen with an active Secret clearance.'])
  assert.deepStrictEqual(eligibilityLines('Build services in Go. Great team.'), [])
})

test('fresh lists leave out US-person-only employers and titles with a clearance, unless the look-up names the company', () => {
  const { parseFreshListings } = require('../iris/agent/lookup.js')
  const row = (co, o) => Object.assign({ active: true, is_visible: true, category: 'Software', title: 'Software Engineer I', company_name: co, locations: ['Austin, TX'], url: 'https://jobs.lever.co/' + co.replace(/\W/g, '').toLowerCase() + '/1', date_posted: 0 }, o || {})
  const rows = [row('SpaceX'), row('Anduril Industries'), row('Lawrence Livermore National Laboratory'), row('Amentum', { title: 'Entry Level Software Engineer - SECRET' }),
    row('Microsoft', { title: 'Software Engineer - CTJ - Poly (New Grad)' }), row('Microsoft'), row('Boeing'), row('Acme')]
  assert.deepStrictEqual(parseFreshListings(rows, [], 0, []).map(j => j.company).sort(), ['Acme', 'Boeing', 'Microsoft'])
  assert.deepStrictEqual(parseFreshListings(rows, ['spacex'], 0, []).map(j => j.company), ['SpaceX'])
})

test('fresh new grad: the caller\'s redirect reader resolves short links (Electron\'s fetch cannot)', async () => {
  const vansh = [{ active: true, is_visible: true, company_name: 'Citi', title: 'New Grad 2027: Software Developer', locations: ['Jacksonville, FL'], url: 'https://go.vansh.nyc/Br', date_posted: -10 },
    { active: true, is_visible: true, company_name: 'Rilla', title: 'New Grad: Software Engineer', locations: ['New York, NY'], url: 'https://go.vansh.nyc/Vn', date_posted: -20 }]
  const fetch = async (url) => /vanshb03/.test(url) ? { status: 200, url, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(vansh) } : { status: 200, url, headers: { get: () => 'application/json' }, text: async () => '[]' }
  const asked = []
  const redirectOf = async (u) => { asked.push(u); return { 'https://go.vansh.nyc/Br': 'https://citi.wd5.myworkdayjobs.com/2/job/X_261004412', 'https://go.vansh.nyc/Vn': 'https://jobs.ashbyhq.com/rilla/123a6a38-c7f9-4378-b00d-c6ae54688bd5' }[u] || '' }
  const lk = createLookup(Object.assign({ fetch, redirectOf }, instant))
  const r = await lk.lookup({ kind: 'jobs', query: 'fresh new grad' }, { annotate: (it) => /citi\.wd5/.test(it.url) ? 'you logged this job "applied"' : null })
  assert.deepStrictEqual(r.items.map(it => it.url), ['https://jobs.ashbyhq.com/rilla/123a6a38-c7f9-4378-b00d-c6ae54688bd5'])
  assert.deepStrictEqual(asked.sort(), ['https://go.vansh.nyc/Br', 'https://go.vansh.nyc/Vn'])
})

test('fresh lists leave out labeling, data-collection, operator and technician roles', () => {
  const { parseFreshListings } = require('../iris/agent/lookup.js')
  const row = (title) => ({ active: true, is_visible: true, category: 'AI/ML/Data', title, company_name: 'Tesla', locations: ['Austin, TX'], url: 'https://x.test/' + encodeURIComponent(title), date_posted: 0 })
  const rows = ['Data Labeler', 'Data Collection Operator - Optimus', 'Engineering Technician Trainee', 'Data Annotation Specialist', 'Machine Learning Engineer', 'Data Engineer I'].map(row)
  assert.deepStrictEqual(parseFreshListings(rows, [], 0, []).map(j => j.role).sort(), ['Data Engineer I', 'Machine Learning Engineer'])
})
