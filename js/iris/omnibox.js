/*
 * js/iris/omnibox.js — Iris' always-visible address/search field.
 *
 * Min's model is "the tab is the address bar": #tab-editor is hidden until you start
 * typing. Iris keeps that machinery (and its search dropdown) but gives it a permanent
 * home on the command bar: a pill showing the page title + hostname that focuses Min's
 * existing tab editor when clicked or typed into.
 */

const tabEditor = require('navbar/tabEditor.js')
const webviews = require('webviews.js')
const urlParser = require('util/urlParser.js')

let omnibox = null
let titleEl = null
let urlEl = null
let iconEl = null

function el (tag, className, html) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (html !== undefined) node.innerHTML = html
  return node
}

function hostnameOf (url) {
  if (!url || url.indexOf('min://') === 0) return ''
  try {
    const parsed = new URL(url)
    return parsed.hostname.replace(/^www\./, '') + (parsed.pathname !== '/' ? parsed.pathname : '')
  } catch (e) {
    return url
  }
}

function update () {
  if (!omnibox || !window.tabs) return
  const tab = window.tabs.get(window.tabs.getSelected())
  if (!tab) return

  const raw = urlParser.getSourceURL(tab.url)
  if (!raw || raw === 'min://newtab') {
    titleEl.textContent = ''
    urlEl.innerHTML = '<b>Start a search</b> or type a website address'
    titleEl.hidden = true
    omnibox.classList.remove('secure')
    return
  }

  const secure = raw.indexOf('https://') === 0
  omnibox.classList.toggle('secure', secure)
  titleEl.hidden = false
  titleEl.textContent = tab.title || ''
  urlEl.innerHTML = ''
  const b = document.createElement('b')
  const host = hostnameOf(raw).replace(/^www\./, '').split('/')[0]
  b.textContent = (secure ? '' : '') + host
  urlEl.appendChild(b)
  urlEl.appendChild(document.createTextNode(hostnameOf(raw).slice(host.length)))
  iconEl.innerHTML = secure ? SECURE_SVG : INFO_SVG
}

const SECURE_SVG = '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M12 3l7 3v5.2c0 4.4-3 8.2-7 9.8-4-1.6-7-5.4-7-9.8V6l7-3z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>'
const INFO_SVG = '<svg viewBox="0 0 24 24" width="15" height="15"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 11v5M12 8.2v.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'

function focusOmnibox () {
  tabEditor.show(tabs.getSelected())
}

function initialize () {
  omnibox = el('button', 'iris-omnibox')
  omnibox.type = 'button'
  omnibox.id = 'iris-omnibox'
  omnibox.setAttribute('aria-label', 'Address and search')

  iconEl = el('span', 'iris-omnibox-icon', INFO_SVG)
  titleEl = el('span', 'iris-omnibox-title')
  const sep = el('span', 'iris-omnibox-sep', '/')
  urlEl = el('span', 'iris-omnibox-url')

  omnibox.appendChild(iconEl)
  omnibox.appendChild(titleEl)
  omnibox.appendChild(sep)
  omnibox.appendChild(urlEl)

  const navbar = document.getElementById('navbar')
  navbar.insertBefore(omnibox, document.getElementById('tabs'))

  omnibox.addEventListener('click', focusOmnibox)

  window.addEventListener('paste', function () {
    setTimeout(update, 0)
  })

  tasks.on('tab-selected', update)
  tasks.on('task-selected', update)
  webviews.bindEvent('did-navigate', update)
  webviews.bindEvent('did-navigate-in-page', update)
  webviews.bindEvent('page-title-updated', update)
  webviews.bindEvent('did-finish-load', update)
  webviews.bindEvent('did-stop-loading', update)

  document.addEventListener('focusin', function (e) {
    if (e.target && e.target.id === 'tab-editor-input') {
      omnibox.blur()
    }
  })

  update()
}

module.exports = { initialize, update }
