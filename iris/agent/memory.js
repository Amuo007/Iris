'use strict'

/*
 * iris/agent/memory.js — what Iris remembers beyond the context window, and how it finds it.
 *
 * Long runs cannot keep everything in the prompt, and a model reading a long list is slow and
 * misses things. So memory works in two ways:
 *
 *   1. Code checks, not the model. "Do I already have this download?" is answered here by
 *      matching identifiers, at no token cost.
 *   2. Search on demand. The model asks with `recall` only when it needs to, and gets the few
 *      best matches back.
 *
 * Saving rules make lookups match however a thing was written: identifiers are pulled out of
 * text and URLs (arXiv IDs without the version, DOIs, normalised URLs), and words are compared
 * lower-cased, without punctuation or tiny filler words.
 *
 * Pure: no Electron, no files. The main process persists `items` as JSON.
 */

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'were', 'you', 'your', 'about', 'into', 'pdf', 'http', 'https', 'www', 'html', 'abs'])

/** Identifiers that mean "the same document" however they are written. */
function extractIds (text) {
  const s = String(text || '')
  const ids = new Set()
  const arxiv = /(?:^|[^\d])(\d{4}\.\d{4,5})(?:v\d+)?(?![\d])/g
  let m
  while ((m = arxiv.exec(s)) !== null) ids.add('arxiv:' + m[1])
  const doi = /\b(10\.\d{4,9}\/[^\s"'<>]+?)(?=[\s"'<>]|\.(?:pdf|html?)\b|$)/gi
  while ((m = doi.exec(s)) !== null) ids.add('doi:' + m[1].toLowerCase().replace(/[.,;)]+$/, ''))
  return Array.from(ids)
}

/** A URL reduced to what identifies the page: no scheme, www, fragment or tracking parameters. */
function normalizeUrl (url) {
  try {
    const u = new URL(url)
    const params = new URLSearchParams()
    Array.from(u.searchParams.keys()).sort().forEach(function (k) {
      if (!/^(utm_|ref$|fbclid|gclid|mc_)/i.test(k)) params.set(k, u.searchParams.get(k))
    })
    const q = params.toString()
    return (u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/+$/, '') + (q ? '?' + q : '')).toLowerCase()
  } catch (e) {
    return String(url || '').trim().toLowerCase()
  }
}

function words (text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s.-]/g, ' ').split(/[\s.-]+/).filter(function (w) {
    return w.length >= 3 && !STOP.has(w)
  })
}

/**
 * @param {Array} items saved items to start from: { kind, text, url?, ids?, at, ...extra }
 */
function createMemory (items) {
  const list = Array.isArray(items) ? items.slice() : []

  function add (kind, text, extra) {
    const e = extra || {}
    const item = Object.assign({}, e, {
      kind,
      text: String(text || '').slice(0, 500),
      url: e.url ? normalizeUrl(e.url) : undefined,
      ids: Array.from(new Set(extractIds(text).concat(extractIds(e.url)).concat(extractIds(e.name)))),
      at: e.at || Date.now()
    })
    list.push(item)
    return item
  }

  /** Is this the same document as something already downloaded? (by id, then by URL) */
  function findDownload (url, name) {
    const ids = extractIds(url).concat(extractIds(name))
    const norm = url ? normalizeUrl(url) : null
    for (let i = list.length - 1; i >= 0; i--) {
      const it = list[i]
      if (it.kind !== 'download') continue
      if (ids.length && it.ids && it.ids.some(function (id) { return ids.includes(id) })) return it
      if (norm && it.url === norm) return it
    }
    return null
  }

  /** Best matches for a question: shared identifiers first, then shared words. */
  function search (query, limit) {
    const qIds = extractIds(query)
    const qWords = words(query)
    const scored = []
    list.forEach(function (it, index) {
      let score = 0
      if (qIds.length && it.ids && it.ids.some(function (id) { return qIds.includes(id) })) score += 100
      const w = words(it.text + ' ' + (it.url || '') + ' ' + (it.name || ''))
      qWords.forEach(function (q) { if (w.includes(q)) score += 2 })
      if (score > 0) scored.push({ it, score: score + index / 1e6 }) // newer wins a tie
    })
    scored.sort(function (a, b) { return b.score - a.score })
    return scored.slice(0, limit || 8).map(function (s) { return s.it })
  }

  function count (kind) {
    return list.filter(function (it) { return !kind || it.kind === kind }).length
  }

  return { add, findDownload, search, count, items: function () { return list.slice() } }
}

/** One line per recalled item, for the model. */
function describeItem (it) {
  const when = new Date(it.at).toISOString().slice(0, 16).replace('T', ' ')
  if (it.kind === 'download') return '- downloaded ' + (it.name || it.text) + (it.url ? ' from ' + it.url : '') + ' (' + when + ')'
  if (it.kind === 'visit') return '- visited ' + (it.title ? '"' + it.title + '" ' : '') + it.url + ' (' + when + ')'
  return '- note: ' + it.text + ' (' + when + ')'
}

module.exports = { createMemory, extractIds, normalizeUrl, describeItem, words }
