/*
 * js/iris/layout.js — Iris command-bar layout glue.
 *
 *  • declares the command-bar height that the web view geometry must leave room for
 *  • inserts the Iris brand mark and a reload control
 *  • ⌘⇧Space toggles the AI panel from anywhere in the chrome
 */

const webviews = require('webviews.js')

// keep in sync with --iris-navbar-height in css/iris.css
window.IRIS_NAVBAR_HEIGHT = 80

function el (tag, className, html) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (html !== undefined) node.innerHTML = html
  return node
}

function moveTabEditorToCommandBar () {
  /*
   * Min keeps the address input inside the tab strip. Iris moves the very same element
   * (same id, same event handlers, same tabEditor module) onto the command bar, so the
   * autocomplete dropdown and every existing keyboard flow keep working.
   */
  const navbar = document.getElementById('navbar')
  const tabEditor = document.getElementById('tab-editor')
  if (navbar && tabEditor && tabEditor.parentElement !== navbar) {
    navbar.insertBefore(tabEditor, document.getElementById('tabs'))
  }
}

function moveAddTabButtonToTabRow () {
  /* the "+" belongs at the end of the tab strip, not on the command bar */
  const tabsRow = document.getElementById('tabs')
  const rightActions = document.querySelector('#navbar .navbar-right-actions')
  if (tabsRow && rightActions && rightActions.parentElement !== tabsRow) {
    tabsRow.appendChild(rightActions)
  }
}

function addBrand () {
  const navbar = document.getElementById('navbar')
  const brand = el('div', 'iris-brand')
  brand.id = 'iris-brand'
  brand.innerHTML = '<span class="iris-brand-mark" aria-hidden="true"></span>'
  brand.title = 'Iris'
  navbar.insertBefore(brand, document.getElementById('toolbar-navigation-buttons'))
}

function addReloadButton () {
  const group = document.getElementById('toolbar-navigation-buttons')
  const reload = el('button', 'navbar-action-button', '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4.5h-4.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>')
  reload.id = 'reload-button'
  reload.title = 'Reload this page'
  reload.setAttribute('aria-label', 'Reload this page')
  reload.addEventListener('click', function () {
    webviews.callAsync(tabs.getSelected(), 'reload')
  })
  group.appendChild(reload)
}

function moveTaskButtonToCommandBar () {
  /* Min floats the task switcher in the corner; Iris gives it a slot on row 1 */
  const navbar = document.getElementById('navbar')
  const button = document.getElementById('switch-task-button')
  if (navbar && button && button.parentElement !== navbar) {
    navbar.appendChild(button)
  }
}

function initialize () {
  addBrand()
  addReloadButton()
  moveTaskButtonToCommandBar()
  moveTabEditorToCommandBar()
  moveAddTabButtonToTabRow()

  document.body.classList.add('iris-shell')

  window.addEventListener('keydown', function (e) {
    if (e.shiftKey && (e.metaKey || e.ctrlKey) && e.code === 'Space') {
      e.preventDefault()
      require('iris/agentPanel.js').togglePanel()
    }
  })
}

module.exports = { initialize }
