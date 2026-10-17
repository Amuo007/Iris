'use strict'

/*
 * iris/agent/lookup.js — quick look-ups outside the browser.
 *
 * Before Iris opens a single tab, Smart mode can learn about a task: search the web, list papers
 * with their abstracts, read an encyclopedia summary, skim a public page. That turns a vague
 * request into a plan that knows where to go, at the cost of a few small text requests instead
 * of dozens of screenshot steps.
 *
 * These requests are kept apart from the user:
 *   • they never use the browser's tabs, cookies or logins (the main process passes a fetch bound
 *     to an empty, in-memory session), so no website can tie them to the user's accounts;
 *   • sites that ban accounts for automated reading (LinkedIn, Facebook, ...) are never contacted;
 *   • they are few and slow: a budget per task, one request at a time per site, and a cache.
 * The task itself — forms, sign-ups, downloads, payments — always happens in the browser.
 *
 * Pure apart from the injected `fetch`.
 */

const KINDS = ['web', 'papers', 'arxiv', 'wiki', 'page', 'jobs', 'hn']
const ARXIV_STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'about', 'into', 'using', 'based', 'via', 'of', 'in', 'on', 'to', 'a', 'an', 'new', 'recent', 'latest', 'paper', 'papers', '2024', '2025', '2026', 'or'])

/* Never contacted directly (search results that merely mention them are fine). */
const NEVER = ['linkedin.com', 'facebook.com', 'instagram.com', 'x.com', 'twitter.com', 'tiktok.com', 'threads.net', 'snapchat.com', 'pinterest.com']

const DEFAULTS = {
  timeoutMs: 12000,
  perHostGapMs: 1500,
  cacheMs: 60 * 60 * 1000,
  maxResults: 6,
  pageChars: 3500,
  abstractChars: 320,
  snippetChars: 220,
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
}

function hostOf (url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase() } catch (e) { return '' }
}

function isNever (url, extra) {
  const h = hostOf(url)
  if (!h) return false
  return NEVER.concat(extra || []).some(function (d) {
    d = String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')
    return d && (h === d || h.endsWith('.' + d))
  })
}

/* ---- tiny HTML helpers (no DOM in this process) ---- */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", '#x2F': '/', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' }

function decodeEntities (s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, function (all, e) {
    if (ENTITIES[e] !== undefined) return ENTITIES[e]
    if (/^#x/i.test(e)) return String.fromCodePoint(parseInt(e.slice(2), 16))
    if (/^#\d/.test(e)) return String.fromCodePoint(parseInt(e.slice(1), 10))
    return all
  })
}

function stripTags (html) {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

function clip (s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s
}

/** The readable text of a page: title + main content, without menus, scripts and footers. */
function readableText (html, maxChars) {
  let s = String(html || '')
  const title = stripTags((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(s) || [])[1] || '')
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|form|button|select)[\s\S]*?<\/\1>/gi, ' ')
  const main = /<(article|main)[^>]*>([\s\S]*?)<\/\1>/i.exec(s)
  if (main && stripTags(main[2]).length > 400) s = main[2]
  else s = s.replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, ' ')
  s = s.replace(/<(nav|aside)[\s\S]*?<\/\1>/gi, ' ')
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|br|section)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n')
  const lines = decodeEntities(s.replace(/<[^>]+>/g, ' '))
    .split('\n').map(function (l) { return l.replace(/\s+/g, ' ').trim() }).filter(function (l) { return l.length > 1 })
  // menus, language lists and link footers are long runs of short lines: drop those runs
  const kept = []
  for (let i = 0; i < lines.length;) {
    let j = i
    while (j < lines.length && lines[j].length <= 30) j++
    if (j - i >= 8) { i = j; continue }
    for (; i < j; i++) kept.push(lines[i])
    if (i < lines.length) kept.push(lines[i++])
  }
  const text = kept.join('\n')
  return { title, text: text.length > maxChars ? text.slice(0, maxChars) + '\n…(cut)' : text }
}

/* A bot wall or error page is not content. */
function looksBlocked (status, body) {
  if (status === 403 || status === 429 || status === 503 || status === 202) return true
  const s = String(body || '')
  // bot walls are small pages; a real article may merely mention "captcha" in its scripts
  if (s.length > 40000) return /<title>\s*(just a moment|attention required|access denied)/i.test(s.slice(0, 4000))
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(s) || [])[1] || ''
  return /just a moment|attention required|access denied|robot|captcha|security check/i.test(title) ||
    /checking your browser|cf-browser-verification|are you a robot|unusual traffic|enable javascript and cookies to continue/i.test(stripTags(s).slice(0, 3000))
}

/* ---- parsers for each source (exported for tests) ---- */

function parseDuckDuckGo (html, max) {
  const out = []
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class="[^"]*result__a|$)/gi
  let m
  while ((m = re.exec(html)) !== null && out.length < max) {
    let href = decodeEntities(m[1])
    const uddg = /[?&]uddg=([^&]+)/.exec(href)
    if (uddg) href = decodeURIComponent(uddg[1])
    if (/^\/\//.test(href)) href = 'https:' + href
    if (!/^https?:/.test(href) || /duckduckgo\.com\/y\.js|ad_domain|ad_provider/.test(href)) continue
    const snip = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(a|div|td)>/i.exec(m[3])
    out.push({ title: stripTags(m[2]), url: href, snippet: snip ? stripTags(snip[1]) : '' })
  }
  return out
}

/* Bing wraps results in bing.com/ck/a?…&u=a1<base64url of the real address> */
function unwrapBing (href) {
  const m = /^https?:\/\/(?:www\.)?bing\.com\/ck\/a\?.*?[?&]u=a1([A-Za-z0-9_-]+)/.exec(href)
  if (!m) return href
  try {
    const real = Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    return /^https?:\/\//.test(real) ? real : href
  } catch (e) { return href }
}

function parseBing (html, max) {
  const out = []
  const re = /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)<\/li>/gi
  let m
  while ((m = re.exec(html)) !== null && out.length < max) {
    const href = unwrapBing(decodeEntities(m[1]))
    if (!/^https?:/.test(href) || /^https?:\/\/(www\.)?bing\.com\/ck\//.test(href)) continue
    const p = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(m[3])
    out.push({ title: stripTags(m[2]), url: href, snippet: p ? stripTags(p[1]) : '' })
  }
  return out
}

function openAlexAbstract (inv) {
  if (!inv || typeof inv !== 'object') return ''
  const words = []
  Object.keys(inv).forEach(function (w) { (inv[w] || []).forEach(function (i) { words[i] = w }) })
  return words.filter(Boolean).join(' ')
}

function parseOpenAlex (json, max) {
  return ((json && json.results) || []).slice(0, max).map(function (w) {
    const ids = w.ids || {}
    const loc = w.primary_location || {}
    let arxiv = ''
    const landing = (loc.landing_page_url || '') + ' ' + (ids.arxiv || '') + ' ' + ((w.best_oa_location && w.best_oa_location.landing_page_url) || '')
    const am = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/.exec(landing)
    if (am) arxiv = am[1]
    const doi = (w.doi || '').replace(/^https?:\/\/doi\.org\//, '')
    return {
      title: stripTags(w.title || w.display_name || ''),
      year: w.publication_year || null,
      cited: typeof w.cited_by_count === 'number' ? w.cited_by_count : null,
      venue: (loc.source && loc.source.display_name) || '',
      url: arxiv ? 'https://arxiv.org/abs/' + arxiv : (loc.landing_page_url || (doi ? 'https://doi.org/' + doi : w.id || '')),
      pdf: (w.best_oa_location && w.best_oa_location.pdf_url) || (arxiv ? 'https://arxiv.org/pdf/' + arxiv : ''),
      id: arxiv ? 'arXiv ' + arxiv : (doi ? 'doi ' + doi : ''),
      abstract: openAlexAbstract(w.abstract_inverted_index)
    }
  })
}

function parseArxiv (xml, max) {
  const out = []
  const re = /<entry>([\s\S]*?)<\/entry>/g
  let m
  while ((m = re.exec(xml)) !== null && out.length < max) {
    const e = m[1]
    const pick = function (tag) { const x = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>').exec(e); return x ? stripTags(x[1]) : '' }
    const idUrl = pick('id')
    const id = (/abs\/([^v\s]+)/.exec(idUrl) || [])[1] || ''
    out.push({
      title: pick('title'),
      year: Number(pick('published').slice(0, 4)) || null,
      published: pick('published').slice(0, 10),
      url: id ? 'https://arxiv.org/abs/' + id : idUrl,
      pdf: id ? 'https://arxiv.org/pdf/' + id : '',
      id: id ? 'arXiv ' + id : '',
      abstract: pick('summary')
    })
  }
  return out
}

/* ---- job boards: Greenhouse, Lever and Ashby publish every opening as a public list ---- */

/** "jobs.ashbyhq.com/ramp software engineer toronto" → { ats, company, words } or null */
function parseJobBoardQuery (query) {
  const q = String(query || '')
  const m = /(?:https?:\/\/)?(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([A-Za-z0-9_-]+)/i.exec(q) ||
    null
  if (m) return { ats: 'greenhouse', company: m[1], words: jobWords(q.replace(m[0], '')) }
  const l = /(?:https?:\/\/)?jobs\.(?:eu\.)?lever\.co\/([A-Za-z0-9_.-]+)/i.exec(q)
  if (l) return { ats: 'lever', company: l[1], words: jobWords(q.replace(l[0], '')) }
  const a = /(?:https?:\/\/)?jobs\.ashbyhq\.com\/([A-Za-z0-9_.%-]+)/i.exec(q)
  if (a) return { ats: 'ashby', company: decodeURIComponent(a[1]), words: jobWords(q.replace(a[0], '')) }
  // Workday: <tenant>.wd<N>.myworkdayjobs.com/[en-US/]<site>
  const w = /(?:https?:\/\/)?(([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com)\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)/i.exec(q)
  if (w) return { ats: 'workday', host: w[1].toLowerCase(), company: w[2].toLowerCase(), site: w[3], words: jobWords(q.replace(w[0], '')) }
  return null
}

/* Hacker News search (Algolia's public API) → [{ title, url, snippet, year }] — stories and the talk about them */
function parseHackerNews (json, max) {
  return ((json && json.hits) || []).filter(function (h) { return h.title || h.story_title }).slice(0, max).map(function (h) {
    const id = h.story_id || h.objectID
    const discussion = 'https://news.ycombinator.com/item?id=' + id
    const text = String(h.comment_text || h.story_text || '').replace(/<[^>]+>/g, ' ')
      .replace(/&#x([0-9a-f]+);/gi, function (m, n) { return String.fromCharCode(parseInt(n, 16)) })
      .replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(Number(n)) })
      .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
    return {
      title: clip(h.title || h.story_title, 140),
      url: discussion,
      snippet: clip((h.url || h.story_url ? 'link: ' + (h.url || h.story_url) + '. ' : '') + (h.points ? h.points + ' points, ' : '') + (h.num_comments ? h.num_comments + ' comments. ' : '') + text, 220),
      year: h.created_at ? Number(String(h.created_at).slice(0, 4)) : undefined
    }
  })
}

function jobWords (s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9+#.\s-]/g, ' ').split(/\s+/).filter(function (w) { return w.length > 1 && !/^(and|or|the|in|at|for|of|jobs?|roles?)$/.test(w) })
}

function boardApiUrl (b) {
  if (b.ats === 'greenhouse') return 'https://boards-api.greenhouse.io/v1/boards/' + encodeURIComponent(b.company) + '/jobs'
  if (b.ats === 'lever') return 'https://api.lever.co/v0/postings/' + encodeURIComponent(b.company) + '?mode=json'
  return 'https://api.ashbyhq.com/posting-api/job-board/' + encodeURIComponent(b.company)
}

/** The board's JSON → [{ title, location, team, url }] */
function parseBoardJobs (ats, json) {
  if (ats === 'greenhouse') {
    return ((json && json.jobs) || []).map(function (j) { return { title: clip(j.title, 120), location: clip(j.location && j.location.name, 80), team: '', url: j.absolute_url } })
  }
  if (ats === 'lever') {
    return (Array.isArray(json) ? json : []).map(function (j) {
      const c = j.categories || {}
      return { title: clip(j.text, 120), location: clip((c.allLocations && c.allLocations.join(' / ')) || c.location, 80), team: clip(c.team, 40), url: j.hostedUrl }
    })
  }
  return ((json && json.jobs) || []).filter(function (j) { return j.isListed !== false }).map(function (j) {
    const more = (j.secondaryLocations || []).map(function (x) { return x.location }).filter(Boolean)
    return { title: clip(String(j.title || '').trim(), 120), location: clip([j.location].concat(more).join(' / ') + (j.isRemote ? ' (remote ok)' : ''), 100), team: clip(j.department, 40), url: j.jobUrl }
  })
}

/* the best matches for the words, by how many of them appear in the title, team and place */
function filterBoardJobs (jobs, words, max) {
  if (!words.length) return jobs.slice(0, max)
  return jobs.map(function (j) {
    const hay = (j.title + ' ' + j.team + ' ' + j.location).toLowerCase()
    const score = words.filter(function (w) { return hay.indexOf(w) !== -1 }).length
    return { j: j, score: score }
  }).filter(function (x) { return x.score >= Math.min(2, words.length) }).sort(function (a, b) { return b.score - a.score }).slice(0, max).map(function (x) { return x.j })
}

/**
 * @param {object} opts
 * @param {function} opts.fetch      fetch(url, {headers, signal}) -> Response (isolated session)
 * @param {function} [opts.now]
 * @param {function} [opts.delay]
 * @param {string[]} [opts.never]    extra domains the user never wants contacted
 */
function createLookup (opts) {
  const o = opts || {}
  if (typeof o.fetch !== 'function') throw new TypeError('lookup needs fetch')
  const cfg = Object.assign({}, DEFAULTS, o.config || {})
  const now = o.now || Date.now
  const delay = o.delay || function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms) }) }
  const cache = new Map()
  const lastHit = {}
  let queue = Promise.resolve()

  /* one request at a time, and never two to the same site within perHostGapMs */
  function get (url, accept, json) {
    const run = async function () {
      const host = hostOf(url)
      const wait = lastHit[host] === undefined ? 0 : lastHit[host] + cfg.perHostGapMs - now()
      if (wait > 0) await delay(wait)
      lastHit[host] = now()
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null
      const timer = setTimeout(function () { if (ctrl) ctrl.abort() }, cfg.timeoutMs)
      try {
        const headers = { 'User-Agent': cfg.userAgent, Accept: accept || 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' }
        // a small JSON search (Workday's job search is a POST); everything else is a plain GET
        if (json) headers['Content-Type'] = 'application/json'
        const res = await o.fetch(url, Object.assign({ headers: headers, signal: ctrl ? ctrl.signal : undefined, redirect: 'follow' }, json ? { method: 'POST', body: JSON.stringify(json) } : {}))
        const body = await res.text()
        return { status: res.status, body: body, type: (res.headers && res.headers.get && res.headers.get('content-type')) || '', url: res.url || url }
      } finally {
        clearTimeout(timer)
      }
    }
    const p = queue.then(run, run)
    queue = p.catch(function () {})
    return p
  }

  async function web (query) {
    const ddg = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query)
    // "site:example.com …" — results from elsewhere are no answer (Bing ignores site: for simple clients)
    const site = (/(?:^|\s)site:([^\s]+)/i.exec(query) || [])[1]
    const onSite = function (items) { return site ? items.filter(function (it) { const h = hostOf(it.url); const d = site.toLowerCase().replace(/^www\./, ''); return h === d || h.endsWith('.' + d) }) : items }
    // "site:jobs.lever.co …": a search engine that ignores site: may still bring postings from other job boards
    const BOARDS = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|smartrecruiters\.com|workable\.com|recruitee\.com)$/
    const onBoards = function (items) { return site && BOARDS.test(site.toLowerCase()) ? items.filter(function (it) { return BOARDS.test(hostOf(it.url)) }) : [] }
    const tries = [
      [ddg, parseDuckDuckGo, 'DuckDuckGo'],
      // DuckDuckGo sometimes turns away one request in a row of quick ones: one more try after a pause
      [ddg, parseDuckDuckGo, 'DuckDuckGo', 2500],
      ['https://www.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=en', parseBing, 'Bing']
    ]
    let lastError = 'no results'
    for (const t of tries) {
      try {
        if (t[3]) await delay(t[3])
        const r = await get(t[0])
        if (looksBlocked(r.status, r.body)) { lastError = t[2] + ' refused the request'; continue }
        const found = t[1](r.body, cfg.maxResults * (site ? 2 : 1))
        const items = onSite(found).slice(0, cfg.maxResults)
        if (items.length) return { source: t[2], items }
        const boards = onBoards(found).slice(0, cfg.maxResults)
        if (boards.length) return { source: t[2] + ', other job boards (none on ' + site + ')', items: boards }
        lastError = t[2] + ' returned no results'
      } catch (e) {
        lastError = t[2] + ': ' + (e && e.message ? e.message : e)
      }
    }
    throw new Error(lastError)
  }

  async function papers (query) {
    const url = 'https://api.openalex.org/works?search=' + encodeURIComponent(query) + '&per-page=' + cfg.maxResults +
      '&select=id,doi,title,display_name,publication_year,cited_by_count,primary_location,best_oa_location,abstract_inverted_index,ids'
    const r = await get(url, 'application/json')
    if (r.status !== 200) throw new Error('OpenAlex answered ' + r.status)
    return { source: 'OpenAlex', items: parseOpenAlex(JSON.parse(r.body), cfg.maxResults) }
  }

  /* arXiv needs every word to match: use the key words, and fewer of them if nothing comes back */
  async function arxiv (query) {
    const words = String(query).toLowerCase().split(/\s+/).map(function (w) { return w.replace(/[^\w.-]/g, '') })
      .filter(function (w) { return w.length > 1 && !ARXIV_STOP.has(w) })
    let items = []
    for (const n of [5, 3, 2]) {
      const use = words.slice(0, n)
      if (!use.length) break
      const url = 'https://export.arxiv.org/api/query?search_query=' + use.map(function (w) { return 'all:' + w }).join('+AND+') +
        '&max_results=' + cfg.maxResults + '&sortBy=relevance'
      const r = await get(url, 'application/atom+xml')
      if (r.status !== 200) throw new Error('arXiv answered ' + r.status)
      items = parseArxiv(r.body, cfg.maxResults)
      if (items.length || words.length <= n) break
    }
    return { source: 'arXiv', items }
  }

  async function wiki (query) {
    const s = await get('https://en.wikipedia.org/w/rest.php/v1/search/page?q=' + encodeURIComponent(query) + '&limit=3', 'application/json')
    if (s.status !== 200) throw new Error('Wikipedia answered ' + s.status)
    const pages = (JSON.parse(s.body).pages || []).slice(0, 2)
    const items = []
    for (const p of pages) {
      try {
        const r = await get('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(p.key), 'application/json')
        const j = JSON.parse(r.body)
        items.push({ title: j.title || p.title, url: (j.content_urls && j.content_urls.desktop && j.content_urls.desktop.page) || 'https://en.wikipedia.org/wiki/' + p.key, snippet: j.extract || stripTags(p.excerpt || '') })
      } catch (e) {
        items.push({ title: p.title, url: 'https://en.wikipedia.org/wiki/' + p.key, snippet: stripTags(p.excerpt || '') })
      }
    }
    return { source: 'Wikipedia', items }
  }

  async function hn (query) {
    const r = await get('https://hn.algolia.com/api/v1/search?hitsPerPage=' + cfg.maxResults + '&query=' + encodeURIComponent(query), 'application/json')
    if (r.status !== 200) throw new Error('Hacker News search answered ' + r.status)
    return { source: 'Hacker News', items: parseHackerNews(JSON.parse(r.body), cfg.maxResults) }
  }

  async function jobs (query) {
    const board = parseJobBoardQuery(query)
    if (!board) throw new Error('give a Greenhouse, Lever, Ashby or Workday board address (e.g. jobs.lever.co/acme) and the words to match')
    if (board.ats === 'workday') {
      // Workday searches on its side and wants every word ("firmware Toronto" finds nothing, as the place is not
      // in the text): with no hits, drop words from the end (the place, usually) and rank by them here instead
      const words = board.words.slice()
      const dropped = []
      let data = {}
      for (;;) {
        const r = await get('https://' + board.host + '/wday/cxs/' + board.company + '/' + board.site + '/jobs', 'application/json',
          { appliedFacets: {}, limit: 20, offset: 0, searchText: words.join(' ') })
        if (r.status === 404) throw new Error('no Workday job site "' + board.site + '" at ' + board.host)
        if (r.status !== 200) throw new Error('workday answered ' + r.status)
        data = JSON.parse(r.body) || {}
        if ((data.total || (data.jobPostings || []).length) > 0 || words.length <= 1) break
        dropped.unshift(words.pop())
      }
      const all = (data.jobPostings || []).filter(function (j) { return j.externalPath }).map(function (j) {
        return { title: clip(j.title, 120), location: clip(j.locationsText, 80), team: '', url: 'https://' + board.host + '/' + board.site + j.externalPath }
      })
      const score = function (j) { const hay = (j.title + ' ' + j.location).toLowerCase(); return dropped.filter(function (w) { return hay.indexOf(w) !== -1 }).length }
      const items = dropped.length ? all.slice().sort(function (a, b) { return score(b) - score(a) }) : all
      return { source: board.company + ' on workday, ' + (data.total || all.length) + ' matching "' + words.join(' ') + '"' + (dropped.length ? ' (ranked by: ' + dropped.join(' ') + ')' : ''), items: items.slice(0, 15) }
    }
    const r = await get(boardApiUrl(board), 'application/json')
    if (r.status === 404) throw new Error('no job board called "' + board.company + '" on ' + board.ats)
    if (r.status !== 200) throw new Error(board.ats + ' answered ' + r.status)
    const all = parseBoardJobs(board.ats, JSON.parse(r.body))
    const items = filterBoardJobs(all, board.words, 15)
    return { source: board.company + ' on ' + board.ats + ', ' + all.length + ' open', items: items }
  }

  /* An Ashby posting page is built by JavaScript; its public posting API has the same text. */
  async function ashbyPosting (url, chars) {
    const m = /^https?:\/\/jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f-]{36})/i.exec(url)
    if (!m) return null
    const r = await get(boardApiUrl({ ats: 'ashby', company: decodeURIComponent(m[1]) }), 'application/json')
    if (r.status !== 200) return null
    const job = ((JSON.parse(r.body) || {}).jobs || []).find(function (j) { return String(j.id).toLowerCase() === m[2].toLowerCase() })
    if (!job || !job.descriptionPlain) return null
    const title = String(job.title || '').trim()
    const head = [title, job.location, job.department].filter(Boolean).join(' · ')
    return { source: 'ashby posting api', items: [{ title: title, url: job.jobUrl || url, text: clip(head + '\n' + job.descriptionPlain, chars || cfg.pageChars) }] }
  }

  /* A Workday posting page is built by JavaScript too; the site's own JSON endpoint (/wday/cxs/…) has the text. */
  async function workdayPosting (url, chars) {
    const m = /^https?:\/\/(([^./]+)\.wd\d+\.myworkdayjobs\.com)\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)\/job\/([^?#]+?)(?:\/apply[^?#]*)?(?:[?#]|$)/.exec(url)
    if (!m) return null
    const r = await get('https://' + m[1] + '/wday/cxs/' + m[2] + '/' + m[3] + '/job/' + m[4], 'application/json')
    if (r.status !== 200) return null
    const info = (JSON.parse(r.body) || {}).jobPostingInfo
    if (!info || !info.jobDescription) return null
    const title = String(info.title || '').trim()
    const head = [title, info.location, info.timeType].filter(Boolean).join(' · ')
    const body = readableText('<html><body>' + info.jobDescription + '</body></html>', chars || cfg.pageChars).text
    return { source: 'workday posting api', items: [{ title: title, url: info.externalUrl || url, text: clip(head + '\n' + body, chars || cfg.pageChars) }] }
  }

  async function page (url, chars) {
    if (!/^https?:\/\//i.test(url)) url = 'https://' + String(url).replace(/^\/+/, '')
    const posting = (await ashbyPosting(url, chars)) || (await workdayPosting(url, chars))
    if (posting) return posting
    const r = await get(url)
    if (looksBlocked(r.status, r.body)) throw new Error(hostOf(url) + ' blocks quick reading; open it in the browser instead')
    if (r.status >= 400) throw new Error(hostOf(url) + ' answered ' + r.status)
    if (/pdf/i.test(r.type)) throw new Error('that is a PDF; open or download it in the browser')
    const rt = readableText(r.body, chars || cfg.pageChars)
    if (rt.text.length < 200) throw new Error(hostOf(url) + ' shows almost no text without a browser (it needs JavaScript); open it in the browser instead')
    return { source: hostOf(r.url || url), items: [{ title: rt.title, url: r.url || url, text: rt.text }] }
  }

  /**
   * @param {{kind: string, query: string}} req
   * @param {{annotate?: function(item): string|null}} [extra]
   * @returns {Promise<{ok: boolean, text: string, count: number}>}
   */
  async function lookup (req, extra) {
    const kind = KINDS.includes(req && req.kind) ? req.kind : 'web'
    const query = String((req && req.query) || '').trim().slice(0, 300)
    if (!query) return { ok: false, text: 'Lookup needs a query.', count: 0 }
    if (kind === 'page' && isNever(query, o.never)) {
      return { ok: false, text: 'Lookup skipped ' + hostOf(query) + ': that site bans accounts for automated reading. Open it in the browser if you need it.', count: 0 }
    }
    // a longer read of one page (a job posting's requirements often come after a long intro)
    const chars = kind === 'page' && req.chars > 0 ? Math.min(20000, Math.round(req.chars)) : 0
    const key = kind + ':' + (chars ? chars + ':' : '') + query.toLowerCase()
    const hit = cache.get(key)
    let result
    if (hit && now() - hit.at < cfg.cacheMs) {
      result = hit.result
    } else {
      try {
        result = await ({ web, papers, arxiv, wiki, page, jobs, hn })[kind](query, chars || undefined)
      } catch (e) {
        return { ok: false, text: 'Lookup (' + kind + ') "' + clip(query, 80) + '" failed: ' + (e && e.message ? e.message : e), count: 0 }
      }
      cache.set(key, { at: now(), result })
    }
    return { ok: true, text: format(kind, query, result, extra), count: result.items.length, items: result.items }
  }

  function format (kind, query, result, extra) {
    const annotate = extra && typeof extra.annotate === 'function' ? extra.annotate : function () { return null }
    const head = kind === 'page'
      ? 'Text of ' + (result.items[0] && result.items[0].url) + ':'
      : (kind === 'papers' || kind === 'arxiv' ? 'Papers' : kind === 'wiki' ? 'Encyclopedia' : kind === 'jobs' ? 'Openings' : kind === 'hn' ? 'Discussions' : 'Web search') + ' for "' + clip(query, 100) + '" (' + result.source + '):'
    if (!result.items.length) return head + ' nothing found.'
    if (kind === 'page') {
      const it = result.items[0]
      return head + (it.title ? '\nTitle: ' + it.title : '') + '\n' + it.text
    }
    const lines = [head]
    result.items.forEach(function (it, i) {
      const meta = []
      if (it.location) meta.push(it.location)
      if (it.team) meta.push(it.team)
      if (it.year) meta.push(it.year)
      if (typeof it.cited === 'number') meta.push('cited ' + it.cited)
      if (it.id) meta.push(it.id)
      const note = annotate(it)
      lines.push((i + 1) + '. ' + clip(it.title, 140) + (meta.length ? ' (' + meta.join(', ') + ')' : '') + ' — ' + it.url + (note ? '  [' + note + ']' : ''))
      const body = it.abstract ? clip(it.abstract, cfg.abstractChars) : clip(it.snippet, cfg.snippetChars)
      if (body) lines.push('   ' + body)
    })
    return lines.join('\n')
  }

  return { lookup, isNever: function (url) { return isNever(url, o.never) } }
}

/** {"lookups":[{"kind":"web","query":"..."}]} from a planner reply, or null. */
function parseLookups (text, max) {
  const m = /\{[\s\S]*"lookups"[\s\S]*\}/.exec(String(text || ''))
  if (!m) return null
  try {
    const obj = JSON.parse(m[0])
    const list = (obj.lookups || []).map(function (l) {
      if (typeof l === 'string') return { kind: 'web', query: l }
      return { kind: KINDS.includes(l.kind) ? l.kind : 'web', query: String(l.query || l.q || l.url || '').trim() }
    }).filter(function (l) { return l.query }).slice(0, max || 4)
    return list.length ? list : null
  } catch (e) {
    return null
  }
}

module.exports = {
  parseHackerNews, createLookup, parseJobBoardQuery, parseBoardJobs, filterBoardJobs, parseLookups, parseDuckDuckGo, parseBing, parseOpenAlex, parseArxiv, readableText, looksBlocked, isNever, KINDS, NEVER }
