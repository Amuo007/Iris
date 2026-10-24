/*
 * js/iris/bookmarksBar.js — Chrome-style bookmarks for Iris.
 *
 *  • a bookmarks bar (third toolbar row, can be turned off in Settings)
 *  • a star in the address field: one click adds the page to the bar, another removes it
 *  • import from Google Chrome (bar order, folders) — the file is read by the main process
 *  • the agent can bookmark the page it is on and look bookmarks up
 *
 * Bookmarks are Min's own places (isBookmarked + tags), so the bookmark manager, search and
 * export keep working. Bar items carry the tag "bar"; items in a bar folder "barfolder:<name>".
 */

const places = require('places/places.js')
const webviews = require('webviews.js')
const settings = require('util/settings/settings.js')
const searchbar = require('searchbar/searchbar.js')

const BASE_HEIGHT = 80
const BAR_HEIGHT = 30

let bar = null
let star = null
let menu = null
let bookmarks = []

const STAR_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 3.8l2.5 5.1 5.6.8-4 3.9.9 5.6-5-2.6-5 2.6.9-5.6-4-3.9 5.6-.8L12 3.8z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>'
const STAR_FILLED_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 3.8l2.5 5.1 5.6.8-4 3.9.9 5.6-5-2.6-5 2.6.9-5.6-4-3.9 5.6-.8L12 3.8z" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>'
const FOLDER_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>'

function el (tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function isOn () {
  return settings.get('irisBookmarksBar') !== false
}

/* The page area starts lower when the bar is shown. */
function applyHeight () {
  const on = isOn()
  document.body.classList.toggle('iris-has-bookmarks-bar', on)
  window.IRIS_NAVBAR_HEIGHT = BASE_HEIGHT + (on ? BAR_HEIGHT : 0)
  document.documentElement.style.setProperty('--iris-navbar-height', window.IRIS_NAVBAR_HEIGHT + 'px')
  try { webviews.resize() } catch (e) { /* views not ready yet */ }
}

function openUrl (url, background) {
  searchbar.events.emit('url-selected', { url: url, background: !!background })
}

function shortTitle (b) {
  const t = (b.title && b.title !== b.url ? b.title : b.url.replace(/^https?:\/\/(www\.)?/, '')) || b.url
  return t.length > 24 ? t.slice(0, 23) + '…' : t
}

function chip (b) {
  let letter = '•'
  try { letter = new URL(b.url).hostname.replace(/^www\./, '').charAt(0).toUpperCase() } catch (e) { /* not a URL */ }
  return el('span', 'iris-bm-chip', letter)
}

function order (a, b) {
  const ai = typeof a.barIndex === 'number' ? a.barIndex : Infinity
  const bi = typeof b.barIndex === 'number' ? b.barIndex : Infinity
  return ai - bi || (a.lastVisit || 0) - (b.lastVisit || 0)
}

function closeMenu () {
  if (!menu) return
  menu.remove()
  menu = null
  webviews.hidePlaceholder('bookmarksMenu')
}

/* A folder's items drop down over the page: a sharp picture of the page stands in meanwhile. */
function openMenu (anchor, items) {
  closeMenu()
  webviews.requestSharpPlaceholder('bookmarksMenu')
  menu = el('div', 'iris-bm-menu')
  items.forEach(function (b) {
    const row = el('button', 'iris-bm-menu-item')
    row.type = 'button'
    row.title = b.url
    row.appendChild(chip(b))
    row.appendChild(el('span', '', b.title || b.url))
    row.addEventListener('click', function (e) {
      closeMenu()
      openUrl(b.url, e.metaKey || e.ctrlKey)
    })
    menu.appendChild(row)
  })
  const r = anchor.getBoundingClientRect()
  menu.style.left = Math.min(r.left, window.innerWidth - 300) + 'px'
  menu.style.top = (r.bottom + 4) + 'px'
  document.body.appendChild(menu)
}

function render () {
  if (!bar) return
  bar.innerHTML = ''
  const top = bookmarks.filter(function (b) { return b.tags.includes('bar') }).sort(order)
  const folders = {}
  bookmarks.forEach(function (b) {
    b.tags.forEach(function (t) {
      if (t.indexOf('barfolder:') === 0) (folders[t.slice(10)] = folders[t.slice(10)] || []).push(b)
    })
  })

  const items = el('div', 'iris-bm-items')
  Object.keys(folders).forEach(function (name) {
    const f = el('button', 'iris-bm-item iris-bm-folder')
    f.type = 'button'
    f.innerHTML = FOLDER_SVG
    f.appendChild(el('span', '', name.replace(/-/g, ' ')))
    f.addEventListener('click', function () {
      if (menu) closeMenu()
      else openMenu(f, folders[name].sort(order))
    })
    items.appendChild(f)
  })
  top.forEach(function (b) {
    const a = el('button', 'iris-bm-item')
    a.type = 'button'
    a.title = (b.title || '') + '\n' + b.url
    a.appendChild(chip(b))
    a.appendChild(el('span', '', shortTitle(b)))
    a.addEventListener('click', function (e) { openUrl(b.url, e.metaKey || e.ctrlKey) })
    a.addEventListener('auxclick', function (e) { if (e.button === 1) openUrl(b.url, true) })
    items.appendChild(a)
  })
  if (!top.length && !Object.keys(folders).length) {
    items.appendChild(el('span', 'iris-bm-empty', 'Click ☆ in the address bar to add a page here, or import your Chrome bookmarks in Settings.'))
  }
  bar.appendChild(items)

  const all = el('button', 'iris-bm-item iris-bm-all', 'All bookmarks')
  all.type = 'button'
  all.addEventListener('click', function () {
    require('navbar/tabEditor.js').show(tabs.getSelected(), '!bookmarks ')
  })
  bar.appendChild(all)
}

function load () {
  return places.getAllItems().then(function (all) {
    bookmarks = (all || []).filter(function (i) { return i.isBookmarked }).map(function (i) {
      return { url: i.url, title: i.title, tags: i.tags || [], barIndex: i.barIndex, lastVisit: i.lastVisit }
    })
    render()
    updateStar()
  }).catch(function () {})
}

/* ---- the star in the address field ---- */

function currentUrl () {
  const tab = tabs.get(tabs.getSelected())
  return tab && tab.url && /^https?:|^file:/.test(tab.url) ? tab.url : null
}

function updateStar () {
  if (!star) return
  const url = currentUrl()
  star.hidden = !url
  if (!url) return
  const on = bookmarks.some(function (b) { return b.url === url })
  star.innerHTML = on ? STAR_FILLED_SVG : STAR_SVG
  star.classList.toggle('is-on', on)
  star.title = on ? 'Remove bookmark' : 'Bookmark this page'
}

function bookmarkPage (url, title) {
  if (!url) return Promise.resolve()
  return places.getItem(url).then(function (item) {
    const tags = ((item && item.tags) || []).filter(function (t) { return t !== 'bar' }).concat('bar')
    return places.updateItem(url, { isBookmarked: true, title: title || (item && item.title) || url, tags: tags, barIndex: Date.now() })
  }).then(load)
}

function unbookmarkPage (url) {
  return places.getItem(url).then(function (item) {
    const tags = ((item && item.tags) || []).filter(function (t) { return t !== 'bar' && t.indexOf('barfolder:') !== 0 })
    return places.updateItem(url, { isBookmarked: false, tags: tags })
  }).then(load)
}

function toggleStar (e) {
  e.stopPropagation()
  const url = currentUrl()
  if (!url) return
  const tab = tabs.get(tabs.getSelected())
  if (bookmarks.some(function (b) { return b.url === url })) unbookmarkPage(url)
  else bookmarkPage(url, tab.title)
}

/* ---- import from Chrome (the main process reads Chrome's Bookmarks file) ---- */

function importEntries (entries) {
  let chain = Promise.resolve()
  entries.forEach(function (b) {
    chain = chain.then(function () {
      return places.getItem(b.url).then(function (item) {
        const tags = Array.from(new Set(((item && item.tags) || []).concat(b.tags || [])))
        return places.updateItem(b.url, { isBookmarked: true, title: b.title || b.url, tags: tags, barIndex: b.barIndex, lastVisit: (item && item.lastVisit) || b.added || Date.now() })
      })
    })
  })
  return chain.then(load).then(function () { return entries.length })
}

function initialize () {
  bar = el('div', 'iris-bookmarks-bar')
  bar.id = 'iris-bookmarks-bar'
  document.getElementById('navbar').appendChild(bar)

  star = el('button', 'iris-star')
  star.type = 'button'
  star.hidden = true
  star.addEventListener('click', toggleStar)
  const omnibox = document.getElementById('iris-omnibox')
  if (omnibox) omnibox.appendChild(star)

  applyHeight()
  settings.listen('irisBookmarksBar', applyHeight)

  tasks.on('tab-selected', updateStar)
  tasks.on('tab-updated', function (id, key) { if (key === 'url') updateStar() })
  window.addEventListener('focus', load)
  document.addEventListener('mousedown', function (e) {
    if (menu && !menu.contains(e.target) && !e.target.closest('.iris-bm-folder')) closeMenu()
  })
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu() })

  // Settings → Import from Chrome
  webviews.bindIPC('irisImportChrome', function (tabId) {
    ipc.send('iris-chrome-bookmarks', { tabId: tabId })
  })
  ipc.on('iris-chrome-bookmarks-data', function (e, data) {
    const reply = function (msg) {
      if (data.tabId && tabs.get(data.tabId)) webviews.callAsync(data.tabId, 'send', ['irisImportResult', msg])
    }
    if (!data || data.error) return reply({ error: (data && data.error) || 'could not read Chrome bookmarks' })
    importEntries(data.bookmarks || []).then(function (n) {
      reply({ count: n, source: data.source })
    })
  })

  // the agent: bookmark the page it is on, and look bookmarks up
  ipc.on('iris-agent-bookmark', function (e, data) {
    if (data && data.url) {
      if (data.remove) unbookmarkPage(data.url)
      else bookmarkPage(data.url, data.title)
    }
  })
  ipc.on('iris-agent-bookmarks-query', function (e, data) {
    const q = String((data && data.query) || '').toLowerCase().split(/\s+/).filter(Boolean)
    const hits = bookmarks.filter(function (b) {
      const hay = ((b.title || '') + ' ' + b.url + ' ' + b.tags.join(' ')).toLowerCase()
      return q.every(function (w) { return hay.indexOf(w) !== -1 })
    }).slice(0, 15).map(function (b) { return { title: b.title, url: b.url } })
    ipc.send('iris-agent-bookmarks-reply', { id: data.id, bookmarks: hits, total: bookmarks.length })
  })

  load()
}

module.exports = { initialize, load }
