/*
 * js/iris/profileMenu.js
 *
 * The account button in the toolbar, like Chrome's profile button: your initials, and a card with
 * your name and email (from Settings → My info), and the way to your info, saved sign-ins, settings
 * and About. Everything stays on this Mac: there is no cloud account.
 */

const webviews = require('webviews.js')

let button = null
let menu = null
let profile = { name: '', email: '' }

function el (tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function initials (name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return ''
  return (parts[0].charAt(0) + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : '')).toUpperCase()
}

const PERSON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="8.5" r="3.8" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M4.5 20c1.3-3.7 4.2-5.6 7.5-5.6s6.2 1.9 7.5 5.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>'

function avatar (className) {
  const a = el('span', 'iris-avatar ' + (className || ''))
  const text = initials(profile.name)
  if (text) a.textContent = text
  else a.innerHTML = PERSON
  return a
}

function renderButton () {
  if (!button) return
  button.textContent = ''
  button.appendChild(avatar())
  button.title = profile.name ? profile.name + (profile.email ? '\n' + profile.email : '') : 'Your profile'
}

/* a settings page, in the settings tab if one is open, else in a new tab */
function openSettings (section) {
  const url = 'min://app/pages/settings/index.html#' + section
  const browserUI = require('browserUI.js')
  const existing = tabs.get().find(function (t) { return t.url && t.url.indexOf('min://app/pages/settings/') === 0 })
  if (existing) {
    browserUI.switchToTab(existing.id)
    webviews.update(existing.id, url)
  } else {
    browserUI.addTab(tabs.add({ url: url }), { enterEditMode: false })
  }
}

function closeMenu () {
  if (!menu) return
  menu.remove()
  menu = null
  button.classList.remove('is-open')
  webviews.hidePlaceholder('profileMenu')
}

function menuItem (label, sub, section) {
  const item = el('button', 'iris-profile-item')
  item.type = 'button'
  item.appendChild(el('span', 'iris-profile-item-label', label))
  if (sub) item.appendChild(el('span', 'iris-profile-item-sub', sub))
  item.addEventListener('click', function () {
    closeMenu()
    openSettings(section)
  })
  return item
}

function openMenu () {
  closeMenu()
  // the page is a separate layer that would cover the card: a sharp picture of it stands in meanwhile
  webviews.requestSharpPlaceholder('profileMenu')
  menu = el('div', 'iris-profile-menu')
  menu.setAttribute('role', 'menu')
  const head = el('div', 'iris-profile-head')
  head.appendChild(avatar('is-large'))
  const who = el('div', 'iris-profile-who')
  who.appendChild(el('div', 'iris-profile-name', profile.name || 'Your profile'))
  who.appendChild(el('div', 'iris-profile-email', profile.email || 'Add your name and email in My info'))
  head.appendChild(who)
  menu.appendChild(head)
  menu.appendChild(el('div', 'iris-profile-note', 'Your details stay on this Mac. Iris uses them to fill forms and sign in for you.'))
  menu.appendChild(menuItem('My info', 'Name, email, phone, address', 'iris-profile-container'))
  menu.appendChild(menuItem('Saved sign-ins', 'Accounts Iris made or uses', 'iris-accounts-container'))
  menu.appendChild(menuItem('Career profile', 'For job applications', 'iris-career-container'))
  menu.appendChild(el('div', 'iris-profile-sep'))
  menu.appendChild(menuItem('Settings', '', 'general-settings-container'))
  menu.appendChild(menuItem('About Iris', '', 'iris-about-container'))
  menu.addEventListener('click', function (e) { e.stopPropagation() })
  document.body.appendChild(menu)
  const r = button.getBoundingClientRect()
  menu.style.top = Math.round(r.bottom + 6) + 'px'
  menu.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + 'px'
  button.classList.add('is-open')
}

function initialize () {
  const navbar = document.getElementById('navbar')
  if (!navbar) return
  button = el('button', 'iris-profile-button')
  button.type = 'button'
  button.setAttribute('aria-haspopup', 'menu')
  button.addEventListener('click', function (e) {
    e.stopPropagation()
    if (menu) {
      closeMenu()
    } else {
      ipc.send('iris-profile-summary')
      openMenu()
    }
  })
  navbar.appendChild(button)
  renderButton()

  ipc.on('iris-profile-summary-reply', function (e, data) {
    profile = { name: String((data && data.name) || '').trim(), email: String((data && data.email) || '').trim() }
    renderButton()
    if (menu) {
      // the card is open: refresh its name and email in place
      menu.querySelector('.iris-profile-name').textContent = profile.name || 'Your profile'
      menu.querySelector('.iris-profile-email').textContent = profile.email || 'Add your name and email in My info'
      menu.querySelector('.iris-profile-head').replaceChild(avatar('is-large'), menu.querySelector('.iris-profile-head .iris-avatar'))
    }
  })
  ipc.send('iris-profile-summary')
  // My info may change in Settings: look again when the window comes back to the front
  window.addEventListener('focus', function () { ipc.send('iris-profile-summary') })

  document.addEventListener('click', closeMenu)
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu() })
  window.addEventListener('resize', closeMenu)
}

module.exports = { initialize, openSettings }
