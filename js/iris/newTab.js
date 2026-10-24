/*
 * js/iris/newTab.js
 *
 * The page behind an empty tab: the Iris mark, a greeting, a search box (the typing goes to the
 * address bar), the sites visited most lately, and Ask Iris. Shown whenever the tab is empty
 * (body.is-ntp); the address bar's list stays closed until something is typed (navbar/tabEditor.js).
 */

const places = require('places/places.js')
const searchbar = require('searchbar/searchbar.js')
const searchEngine = require('util/searchEngine.js')
const tabEditor = require('navbar/tabEditor.js')
const { logoMarkup } = require('iris/logo.js')

const MAX_SITES = 8

let root = null
let greetingEl = null
let searchLabel = null
let sitesEl = null
let logoWrap = null
let firstName = ''
let welcomeTimer = null

function el (tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function greeting () {
  const h = new Date().getHours()
  const part = h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
  return part + (firstName ? ', ' + firstName : '')
}

function openUrl (url) {
  searchbar.events.emit('url-selected', { url: url, background: false })
}

/* a site's own name for its tile: the page title when it is short, else the address without www. */
function siteLabel (item, host) {
  const title = String(item.title || '').split(/ [-–—|·] /)[0].trim()
  return title && title.length <= 18 && !/^https?:/.test(title) ? title : host
}

function siteTile (item) {
  let u = null
  try { u = new URL(item.url) } catch (e) { return null }
  const host = u.hostname.replace(/^www\./, '')
  const tile = el('button', 'iris-ntp-site')
  tile.type = 'button'
  tile.title = item.title ? item.title + '\n' + host : host
  const icon = el('span', 'iris-ntp-site-icon')
  const letter = el('span', 'iris-ntp-site-letter', host.charAt(0).toUpperCase())
  icon.appendChild(letter)
  const img = document.createElement('img')
  img.alt = ''
  img.draggable = false
  img.addEventListener('load', function () { if (img.naturalWidth > 1) icon.classList.add('has-image') })
  img.addEventListener('error', function () { img.remove() })
  img.src = u.origin + '/favicon.ico'
  icon.appendChild(img)
  tile.appendChild(icon)
  tile.appendChild(el('span', 'iris-ntp-site-name', siteLabel(item, host)))
  tile.addEventListener('click', function () { openUrl(item.url) })
  return tile
}

async function renderSites () {
  let results = []
  try { results = await places.getPlaceSuggestions('') } catch (e) { results = [] }
  const seen = new Set()
  const picks = []
  ;(results || []).forEach(function (item) {
    let u = null
    try { u = new URL(item.url) } catch (e) { return }
    if (!/^https?:$/.test(u.protocol)) return
    const host = u.hostname.replace(/^www\./, '')
    if (seen.has(host)) return
    seen.add(host)
    picks.push(item)
  })
  sitesEl.textContent = ''
  picks.slice(0, MAX_SITES).forEach(function (item) {
    const tile = siteTile(item)
    if (tile) sitesEl.appendChild(tile)
  })
  sitesEl.hidden = !sitesEl.children.length
}

function refresh () {
  greetingEl.textContent = greeting()
  const engine = searchEngine.getCurrent()
  searchLabel.textContent = 'Search ' + (engine && engine.name && engine.name !== 'custom' ? engine.name : 'the web') + ' or type a URL'
  renderSites()
  // the mark assembles each time the page appears, then breathes
  clearTimeout(welcomeTimer)
  logoWrap.innerHTML = logoMarkup('is-welcome')
  welcomeTimer = setTimeout(function () {
    const mark = logoWrap.firstChild
    if (mark) mark.className = 'iris-logo is-idle'
  }, 2600)
  ipc.send('iris-profile-summary')
}

function build () {
  const host = document.getElementById('ntp-content')
  if (!host) return
  root = el('div', 'iris-ntp')
  logoWrap = el('div', 'iris-ntp-logo')
  root.appendChild(logoWrap)
  greetingEl = el('h1', 'iris-ntp-greeting', greeting())
  root.appendChild(greetingEl)

  // looks like a search field; the typing itself goes to the address bar, which knows history and suggestions
  const search = el('button', 'iris-ntp-search')
  search.type = 'button'
  search.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M15.5 15.5l5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
  searchLabel = el('span', 'iris-ntp-search-label', 'Search or type a URL')
  search.appendChild(searchLabel)
  search.addEventListener('click', function (e) {
    e.stopPropagation()
    tabEditor.show(tabs.getSelected())
  })
  root.appendChild(search)

  sitesEl = el('div', 'iris-ntp-sites')
  root.appendChild(sitesEl)

  const ask = el('button', 'iris-ntp-ask')
  ask.type = 'button'
  ask.innerHTML = logoMarkup() + '<span>Ask Iris to do it for you</span>'
  ask.addEventListener('click', function (e) {
    e.stopPropagation()
    require('iris/agentPanel.js').openPanel()
  })
  root.appendChild(ask)

  host.appendChild(root)
}

function initialize () {
  build()
  if (!root) return

  ipc.on('iris-profile-summary-reply', function (e, data) {
    firstName = String((data && data.name) || '').trim().split(/\s+/)[0] || ''
    greetingEl.textContent = greeting()
  })

  // shown again each time the selected tab becomes an empty one
  let wasNtp = false
  new MutationObserver(function () {
    const isNtp = document.body.classList.contains('is-ntp')
    if (isNtp && !wasNtp) refresh()
    wasNtp = isNtp
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] })
  if (document.body.classList.contains('is-ntp')) {
    wasNtp = true
    refresh()
  }

  // typing on the page goes straight into the address bar
  document.addEventListener('keydown', function (e) {
    if (!document.body.classList.contains('is-ntp') || tabEditor.isShown) return
    if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return
    const active = document.activeElement
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return
    e.preventDefault()
    tabEditor.show(tabs.getSelected(), e.key)
  })
}

module.exports = { initialize }
