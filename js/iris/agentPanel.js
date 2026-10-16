/*
 * js/iris/agentPanel.js — the Iris AI side panel (browser UI renderer).
 *
 * Responsibilities:
 *   • own the panel DOM (chat, composer, live status, run controls, history)
 *   • relay control messages to the main process and render its event stream
 *   • keep the web view from being occluded by the panel (webviews.adjustMargin) so the
 *     agent's click coordinates always map onto visible page content
 *   • tell the main process which tabs exist and carry out its tab commands
 *   • bridge the settings page's "My info" form to the main process (secrets never return)
 *
 * The panel never inspects or mutates page content. Page access lives in main/irisAgent.js.
 */

const webviews = require('webviews.js')
const settings = require('util/settings/settings.js')
const urlParser = require('util/urlParser.js')

const PANEL_WIDTH = 380
const MAX_STEPS_SHOWN = 80
const MAX_ITEMS_SHOWN = 400

const SUGGESTIONS = [
  'What is the weather in Chicago today?',
  'Find 3 good recent papers on web agents, judge each by its abstract and download the PDFs',
  'Find the cheapest one-way flight from Chicago to Denver next Friday',
  'Summarize this page in three bullet points'
]

const THINKING_LABELS = { off: 'Fast', low: 'Balanced', medium: 'Careful', full: 'Deep' }
const THINKING_HELP = 'How long Iris thinks before each action. Fast is quickest; Deep is slowest but most careful.'

const RUN_MODES = [
  { value: 'once', label: 'Once' },
  { value: 'continuous', label: 'Non-stop' },
  { value: 'repeat:15', label: 'Every 15 min' },
  { value: 'repeat:60', label: 'Every hour' },
  { value: 'repeat:360', label: 'Every 6 hours' },
  { value: 'repeat:1440', label: 'Every day' }
]

const ICONS = {
  bolt: '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M13 3L5 13.5h6L10 21l8-10.5h-6L13 3z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  loop: '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.5M20 4v4.5h-4.5M20 12a8 8 0 0 1-13.7 5.6L4 15.5M4 20v-4.5h4.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  gear: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.5-2-3.4-2.3.9a7.5 7.5 0 0 0-2.6-1.5L14.1 2.5h-4.2l-.4 2.5a7.5 7.5 0 0 0-2.6 1.5l-2.3-.9-2 3.4 2 1.5a7.6 7.6 0 0 0 0 3l-2 1.5 2 3.4 2.3-.9a7.5 7.5 0 0 0 2.6 1.5l.4 2.5h4.2l.4-2.5a7.5 7.5 0 0 0 2.6-1.5l2.3.9 2-3.4-2-1.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  history: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v3.7h3.7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 8v4.3l3 1.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M14.5 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  send: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  stop: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="6.5" y="5" width="3.6" height="14" rx="1" fill="currentColor"/><rect x="13.9" y="5" width="3.6" height="14" rx="1" fill="currentColor"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5L8 5.5z" fill="currentColor"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  cross: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  spark: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" fill="currentColor"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z" fill="currentColor" opacity=".6"/></svg>'
}

const ACTION_LABELS = {
  click: 'Click',
  double_click: 'Double-click',
  right_click: 'Right-click',
  move: 'Hover',
  drag: 'Drag',
  scroll: 'Scroll',
  type: 'Type',
  key: 'Press key',
  shortcut: 'Shortcut',
  wait: 'Wait',
  navigate: 'Open',
  back: 'Back',
  zoom: 'Zoom in',
  find: 'Find',
  save_account: 'Saved account',
  recall: 'Recall',
  lookup: 'Look up',
  bookmark: 'Bookmark',
  bookmarks: 'Bookmarks',
  tailor_resume: 'Resume',
  cover_letter: 'Cover letter',
  log_application: 'Logged',
  update_plan: 'Update plan',
  judge: 'Judge',
  dialog: 'Answer dialog',
  upload: 'Upload',
  ask_user: 'Asking you',
  new_tab: 'New tab',
  switch_tab: 'Switch tab',
  close_tab: 'Close tab',
  done: 'Done',
  fail: 'Stop'
}

let panelEl = null
let openButton = null
let taskInput = null
let sendButton = null
let thinkingSelect = null
let modeSelect = null
let planToggle = null
let smartLevelBtn = null
let lookupRows = {}
let projectSelect = null
let projectNewRow = null
let projects = []
let currentProjectId = null
let streamEl = null
let historyEl = null
let statusBar = null
let statusText = null
let statusTime = null
let pauseButton = null
let stopButton = null
let modelBadge = null
let historyButton = null
let panelOpen = false
let lastStatus = 'idle'
let runStartedAt = 0
let clock = null
let steps = {}
let phaseText = ''
let mainSettings = {} // defaults merged with stored values, as the main process sees them
let currentSessionId = null
let repeatAt = 0
let showingHistory = false

function el (tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function iconButton (className, icon, title) {
  const b = el('button', 'iris-icon-btn ' + (className || ''))
  b.type = 'button'
  b.innerHTML = icon
  b.title = title
  b.setAttribute('aria-label', title)
  return b
}

function currentSettings () {
  return Object.assign({ thinking: 'low' }, mainSettings, settings.get('irisAI') || {})
}

function isBusy () {
  return lastStatus === 'running' || lastStatus === 'paused' || lastStatus === 'stopping'
}

/* ------------------------------------------------------------------ *
 * Construction
 * ------------------------------------------------------------------ */

function buildPanel () {
  panelEl = el('aside', 'iris-panel')
  panelEl.hidden = true
  panelEl.setAttribute('role', 'complementary')
  panelEl.setAttribute('aria-label', 'Iris assistant')
  panelEl.dataset.status = 'idle'

  // header
  const header = el('header', 'iris-panel-header')
  const title = el('div', 'iris-panel-title')
  title.innerHTML = '<span class="iris-panel-mark" aria-hidden="true"></span><span>Iris</span>'
  header.appendChild(title)
  modelBadge = el('span', 'iris-model-badge', '')
  header.appendChild(modelBadge)
  const newBtn = iconButton('', ICONS.plus, 'New chat')
  newBtn.addEventListener('click', newChat)
  header.appendChild(newBtn)
  historyButton = iconButton('', ICONS.history, 'History')
  historyButton.addEventListener('click', function () { showHistory(!showingHistory) })
  header.appendChild(historyButton)
  const settingsBtn = iconButton('', ICONS.gear, 'Iris settings')
  settingsBtn.addEventListener('click', openSettings)
  header.appendChild(settingsBtn)
  const closeBtn = iconButton('', ICONS.close, 'Close panel')
  closeBtn.addEventListener('click', function () { setPanel(false) })
  header.appendChild(closeBtn)
  panelEl.appendChild(header)

  // project: chats in a project share one plan and one memory
  const projectBar = el('div', 'iris-projectbar')
  projectBar.appendChild(el('span', 'iris-projectbar-label', 'Project'))
  projectSelect = document.createElement('select')
  projectSelect.className = 'iris-project-select'
  projectSelect.title = 'Chats in a project share their plan, notes, decisions and downloads'
  projectSelect.addEventListener('change', function () {
    if (projectSelect.value === '__new') {
      projectNewRow.hidden = false
      projectNewRow.querySelector('input').focus()
      projectSelect.value = currentProjectId || ''
      return
    }
    setProject(projectSelect.value || null)
  })
  projectBar.appendChild(projectSelect)
  panelEl.appendChild(projectBar)
  projectNewRow = el('div', 'iris-project-new')
  projectNewRow.hidden = true
  const nameInput = document.createElement('input')
  nameInput.placeholder = 'Project name, e.g. "Harness research"'
  const createBtn = el('button', 'iris-btn-primary', 'Create')
  createBtn.type = 'button'
  const cancelBtn = el('button', 'iris-btn-quiet', 'Cancel')
  cancelBtn.type = 'button'
  const create = function () {
    const name = nameInput.value.trim()
    if (!name) return
    ipc.send('iris-project-create', { name })
    nameInput.value = ''
    projectNewRow.hidden = true
  }
  createBtn.addEventListener('click', create)
  nameInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') create(); if (e.key === 'Escape') projectNewRow.hidden = true })
  cancelBtn.addEventListener('click', function () { projectNewRow.hidden = true })
  projectNewRow.appendChild(nameInput)
  projectNewRow.appendChild(cancelBtn)
  projectNewRow.appendChild(createBtn)
  panelEl.appendChild(projectNewRow)

  // live status (while a task runs or waits to repeat)
  statusBar = el('div', 'iris-statusbar')
  statusBar.hidden = true
  const dot = el('span', 'iris-status-dot')
  statusText = el('span', 'iris-status-text', '')
  statusTime = el('span', 'iris-status-time', '')
  pauseButton = iconButton('iris-ctl', ICONS.pause, 'Pause')
  pauseButton.addEventListener('click', function () {
    ipc.send(lastStatus === 'paused' ? 'iris-agent-resume' : 'iris-agent-pause')
  })
  stopButton = iconButton('iris-ctl iris-ctl-stop', ICONS.stop, 'Stop')
  stopButton.addEventListener('click', function () { ipc.send('iris-agent-stop') })
  statusBar.appendChild(dot)
  statusBar.appendChild(statusText)
  statusBar.appendChild(statusTime)
  statusBar.appendChild(pauseButton)
  statusBar.appendChild(stopButton)
  panelEl.appendChild(statusBar)

  // chat
  streamEl = el('div', 'iris-stream has-thin-scrollbar')
  streamEl.appendChild(emptyState())
  panelEl.appendChild(streamEl)

  // history list (replaces the chat while open)
  historyEl = el('div', 'iris-history has-thin-scrollbar')
  historyEl.hidden = true
  panelEl.appendChild(historyEl)

  // composer
  const composer = el('div', 'iris-composer')
  const box = el('div', 'iris-composer-box')
  taskInput = document.createElement('textarea')
  taskInput.className = 'iris-task-input'
  taskInput.rows = 1
  taskInput.placeholder = 'Ask Iris to do something on the web…'
  taskInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      submitTask()
    }
  })
  taskInput.addEventListener('input', autosize)
  box.appendChild(taskInput)
  sendButton = iconButton('iris-send', ICONS.send, 'Send')
  sendButton.addEventListener('click', submitTask)
  box.appendChild(sendButton)
  composer.appendChild(box)

  const meta = el('div', 'iris-composer-meta')
  thinkingSelect = selectControl(ICONS.bolt, Object.keys(THINKING_LABELS).map(function (k) { return { value: k, label: THINKING_LABELS[k] } }),
    THINKING_HELP)
  thinkingSelect.select.addEventListener('change', function () {
    settings.set('irisAI', Object.assign({}, settings.get('irisAI') || {}, { thinking: thinkingSelect.select.value }))
  })
  meta.appendChild(thinkingSelect.label)
  modeSelect = selectControl(ICONS.loop, RUN_MODES, 'Once: until the task is done. Non-stop: no step or time limit. Repeat: runs again on a timer until you press Stop.')
  meta.appendChild(modeSelect.label)
  planToggle = el('button', 'iris-plan-toggle')
  planToggle.type = 'button'
  planToggle.innerHTML = '<span class="iris-switch" aria-hidden="true"></span><span>Smart</span>'
  planToggle.title = 'Smart: Iris thinks before it starts. It asks a few quick questions if your request is open, looks things up, makes a plan, and reads every result before keeping it. Best for research, shopping and loose requests.'
  planToggle.addEventListener('click', function () {
    const on = !planToggle.classList.contains('is-on')
    planToggle.classList.toggle('is-on', on)
    planToggle.setAttribute('aria-pressed', String(on))
    smartLevelBtn.hidden = !on
    smartGroup.classList.toggle('is-on', on)
    settings.set('irisAI', Object.assign({}, settings.get('irisAI') || {}, { planFirst: on }))
  })
  // the switch and its level are one control, so the row never runs past the panel
  const smartGroup = el('div', 'iris-smart-group')
  smartGroup.appendChild(planToggle)
  meta.appendChild(smartGroup)
  // how much Smart does before it starts: Quick (a look-up or two) or Deep (researches the task)
  smartLevelBtn = el('button', 'iris-smart-level', 'Quick')
  smartLevelBtn.type = 'button'
  smartLevelBtn.hidden = true
  smartLevelBtn.title = 'Quick: plans in seconds, with a look-up or two.\nDeep: researches the task first (more look-ups, how others did it) and checks its progress more often.'
  smartLevelBtn.addEventListener('click', function () {
    const deep = smartLevel() !== 'deep'
    settings.set('irisAI', Object.assign({}, settings.get('irisAI') || {}, { smartLevel: deep ? 'deep' : 'quick' }))
    renderSmartLevel()
  })
  smartGroup.appendChild(smartLevelBtn)
  composer.appendChild(meta)
  panelEl.appendChild(composer)

  document.body.appendChild(panelEl)

  openButton = document.createElement('button')
  openButton.id = 'iris-ask-button'
  openButton.className = 'iris-ask-button'
  openButton.title = 'Ask Iris  (⌘⇧Space)'
  openButton.innerHTML = ICONS.spark + '<span>Ask Iris</span>'
  openButton.addEventListener('click', togglePanel)
  document.getElementById('navbar').appendChild(openButton)
}

/* A coding agent is using Iris through the MCP bridge: say so on the Ask Iris button. */
let bridgeTimer = null
function bridgeActivity () {
  if (!openButton) return
  openButton.classList.add('is-bridged')
  openButton.title = 'A coding agent is using Iris right now'
  clearTimeout(bridgeTimer)
  bridgeTimer = setTimeout(function () {
    openButton.classList.remove('is-bridged')
    openButton.title = 'Ask Iris  (⌘⇧Space)'
  }, 60000)
}

function smartLevel () {
  return currentSettings().smartLevel === 'deep' ? 'deep' : 'quick'
}

function renderSmartLevel () {
  if (!smartLevelBtn) return
  const deep = smartLevel() === 'deep'
  smartLevelBtn.textContent = deep ? 'Deep' : 'Quick'
  smartLevelBtn.classList.toggle('is-deep', deep)
  smartLevelBtn.hidden = !planToggle.classList.contains('is-on')
  smartLevelBtn.parentNode.classList.toggle('is-on', planToggle.classList.contains('is-on'))
}

function openSettings () {
  const url = 'min://app/pages/settings/index.html#iris-ai'
  const existing = tabs.get().find(function (t) { return t.url && t.url.indexOf('min://app/pages/settings/') === 0 })
  const browserUI = require('browserUI.js')
  if (existing) {
    browserUI.switchToTab(existing.id)
  } else {
    browserUI.addTab(tabs.add({ url: url }), { enterEditMode: false })
  }
}

function renderProjects () {
  projectSelect.innerHTML = ''
  const none = document.createElement('option')
  none.value = ''
  none.textContent = 'None'
  projectSelect.appendChild(none)
  projects.forEach(function (p) {
    const o = document.createElement('option')
    o.value = p.id
    o.textContent = p.name
    projectSelect.appendChild(o)
  })
  const add = document.createElement('option')
  add.value = '__new'
  add.textContent = '+ New project…'
  projectSelect.appendChild(add)
  if (currentProjectId && !projects.some(function (p) { return p.id === currentProjectId })) currentProjectId = null
  projectSelect.value = currentProjectId || ''
}

function setProject (id) {
  if (isBusy()) {
    projectSelect.value = currentProjectId || ''
    return
  }
  currentProjectId = id
  settings.set('irisAI', Object.assign({}, settings.get('irisAI') || {}, { currentProject: id }))
  newChat()
}

function projectName (id) {
  const p = projects.find(function (x) { return x.id === id })
  return p ? p.name : ''
}

function selectControl (icon, options, title) {
  const label = el('label', 'iris-select')
  const glyph = el('span', 'iris-select-icon')
  glyph.innerHTML = icon
  label.appendChild(glyph)
  const select = document.createElement('select')
  options.forEach(function (o) {
    const opt = document.createElement('option')
    opt.value = o.value
    opt.textContent = o.label
    select.appendChild(opt)
  })
  select.title = title
  label.appendChild(select)
  return { label, select }
}

function emptyState () {
  const empty = el('div', 'iris-empty')
  empty.appendChild(el('h2', 'iris-empty-title', 'What should Iris do?'))
  empty.appendChild(el('p', 'iris-empty-text', 'Iris reads the page from screenshots and uses the mouse and keyboard, like you. Watch every step, and click or type in the page to take over.'))
  const list = el('div', 'iris-suggestions')
  SUGGESTIONS.forEach(function (s) {
    const b = el('button', 'iris-suggestion', s)
    b.type = 'button'
    b.addEventListener('click', function () {
      taskInput.value = s
      autosize()
      taskInput.focus()
    })
    list.appendChild(b)
  })
  empty.appendChild(list)
  return empty
}

function autosize () {
  taskInput.style.height = 'auto'
  taskInput.style.height = Math.min(140, taskInput.scrollHeight) + 'px'
}

/* ------------------------------------------------------------------ *
 * Open / close, chats
 * ------------------------------------------------------------------ */

function setPanel (open) {
  if (open === panelOpen) return
  panelOpen = open
  panelEl.hidden = !open
  document.body.classList.toggle('iris-panel-open', open)
  // shrink the web contents so the page is never hidden behind the panel: the agent's
  // screenshot and its click target then describe exactly what the human can see
  webviews.adjustMargin([0, open ? PANEL_WIDTH : -PANEL_WIDTH, 0, 0])
  if (open) {
    thinkingSelect.select.value = currentSettings().thinking
    setTimeout(function () { taskInput.focus() }, 60)
  }
}

function togglePanel () {
  setPanel(!panelOpen)
}

function newChat () {
  if (isBusy()) return
  ipc.send('iris-agent-new-chat')
  currentSessionId = null
  repeatAt = 0
  tally = { kept: 0, files: 0 }
  showHistory(false)
  streamEl.innerHTML = ''
  streamEl.appendChild(emptyState())
  steps = {}
  setStatus('idle')
  taskInput.focus()
}

function submitTask (taskText, options) {
  const task = (typeof taskText === 'string' ? taskText : taskInput.value).trim()
  if (!task) {
    taskInput.focus()
    return
  }
  if (lastStatus === 'paused' && typeof taskText !== 'string') {
    // while Iris waits (a question, a takeover, an approval) a message is an answer, not a new task
    addUserMessage(task)
    taskInput.value = ''
    autosize()
    ipc.send('iris-agent-answer', task)
    return
  }
  if (isBusy()) return
  const activeTabId = (options && options.tabId) || tabs.getSelected()
  if (!activeTabId) return

  // the address bar hides the page behind a placeholder; Iris needs to see the page
  try { require('navbar/tabEditor.js').hide() } catch (e) { /* not open */ }

  showHistory(false)
  removeEmpty()
  steps = {}
  addUserMessage(task)
  if (typeof taskText !== 'string') {
    taskInput.value = ''
    autosize()
  }
  const modeValue = (options && options.mode) || modeSelect.select.value
  const mode = modeValue.split(':')[0]
  const everyMinutes = Number(modeValue.split(':')[1]) || 0
  runStartedAt = Date.now()
  repeatAt = 0
  setStatus('running', 'Starting…')
  pushTabs()
  ipc.send('iris-agent-start', {
    task: task,
    tabId: activeTabId,
    sessionId: options && options.newSession ? null : currentSessionId,
    mode: mode,
    everyMinutes: everyMinutes,
    plan: options && options.plan !== undefined ? options.plan : (planToggle.classList.contains('is-on') ? smartLevel() : false),
    projectId: currentProjectId,
    // where the page is drawn, so Iris can see a tab that has no view attached yet
    viewBounds: webviews.getViewBounds()
  })
}

/* ------------------------------------------------------------------ *
 * History
 * ------------------------------------------------------------------ */

function showHistory (show) {
  showingHistory = show
  historyEl.hidden = !show
  streamEl.hidden = show
  historyButton.classList.toggle('is-on', show)
  if (show) {
    historyEl.innerHTML = ''
    historyEl.appendChild(el('div', 'iris-history-loading', 'Loading…'))
    ipc.send('iris-agent-sessions')
  }
}

function formatWhen (ms) {
  const d = new Date(ms)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function renderHistory (list) {
  historyEl.innerHTML = ''
  const head = el('div', 'iris-history-head')
  const back = iconButton('', ICONS.back, 'Back to chat')
  back.addEventListener('click', function () { showHistory(false) })
  head.appendChild(back)
  head.appendChild(el('span', 'iris-history-title', 'History'))
  historyEl.appendChild(head)
  if (currentProjectId) {
    head.querySelector('.iris-history-title').textContent = 'History · ' + projectName(currentProjectId)
    list = (list || []).filter(function (s) { return s.projectId === currentProjectId })
  }
  if (!list || !list.length) {
    historyEl.appendChild(el('p', 'iris-history-empty', currentProjectId ? 'No chats in this project yet.' : 'No chats yet. Everything you ask Iris is saved here.'))
    return
  }
  list.forEach(function (s) {
    const row = el('div', 'iris-history-row' + (s.id === currentSessionId ? ' is-current' : ''))
    const main = el('button', 'iris-history-open')
    main.type = 'button'
    main.appendChild(el('span', 'iris-history-name', s.title || 'Untitled'))
    const status = s.status === 'done' ? 'Done' : s.status === 'running' ? 'Running' : s.status === 'stopped' ? 'Stopped' : s.status === 'failed' ? 'Failed' : ''
    main.appendChild(el('span', 'iris-history-meta', formatWhen(s.updated) + (status ? ' · ' + status : '') + (s.runs > 1 ? ' · ' + s.runs + ' runs' : '') +
      (!currentProjectId && s.projectId && projectName(s.projectId) ? ' · ' + projectName(s.projectId) : '')))
    main.addEventListener('click', function () {
      if (isBusy()) return
      ipc.send('iris-agent-session-open', s.id)
    })
    row.appendChild(main)
    const del = iconButton('iris-history-del', ICONS.trash, 'Delete')
    del.addEventListener('click', function (e) {
      e.stopPropagation()
      ipc.send('iris-agent-session-delete', s.id)
      if (s.id === currentSessionId) newChat()
    })
    row.appendChild(del)
    historyEl.appendChild(row)
  })
}

/* Replay a saved chat into the panel; the next message continues it. */
function renderSession (data) {
  if (!data) return
  currentSessionId = data.id
  showHistory(false)
  streamEl.innerHTML = ''
  steps = {}
  ;(data.items || []).forEach(function (it) {
    if (it.kind === 'user') {
      steps = {}
      addUserMessage(it.text)
    } else if (it.kind === 'step') {
      const rec = stepRow(it.step)
      rec.row.classList.remove('is-active')
      const first = it.actions && it.actions[0]
      if (first) {
        rec.label.textContent = ACTION_LABELS[first.type] || first.type
        rec.detail.textContent = savedActionDetail(first)
        it.actions.slice(1).forEach(function (a) { addSubAction(rec, ACTION_LABELS[a.type] || a.type, savedActionDetail(a)) })
      } else {
        rec.label.textContent = 'Looked at the page'
      }
      if (it.thought) {
        rec.thought.hidden = false
        rec.thought.textContent = it.thought
      }
      if (it.error) {
        rec.row.classList.add('is-error')
        rec.body.appendChild(el('div', 'iris-step-error', it.error))
      }
    } else if (it.kind === 'note') {
      addNote('Noted: ' + it.text, 'memo')
    } else if (it.kind === 'plan') {
      addPlanCard(it.text)
    } else if (it.kind === 'verdict') {
      addVerdict(it)
    } else if (it.kind === 'result') {
      addResultCard({ status: it.status, answer: it.answer, reason: it.reason, steps: it.steps }, it.ms)
    }
  })
  setStatus('idle')
  scrollToEnd()
  taskInput.placeholder = 'Continue this chat…'
  taskInput.focus()
}

function savedActionDetail (a) {
  if (a.type === 'type') return '“' + (a.text || '') + '”'
  if (a.type === 'navigate' || a.type === 'new_tab') return a.url || ''
  return ''
}

/* ------------------------------------------------------------------ *
 * Rendering the event stream
 * ------------------------------------------------------------------ */

function removeEmpty () {
  const empty = streamEl.querySelector('.iris-empty')
  if (empty) empty.remove()
}

function scrollToEnd () {
  streamEl.scrollTop = streamEl.scrollHeight
}

function addUserMessage (task) {
  removeEmpty()
  const msg = el('div', 'iris-user-msg', task)
  streamEl.appendChild(msg)
  scrollToEnd()
}

function formatElapsed (ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h) return h + ':' + String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0')
  return m ? m + ':' + String(s % 60).padStart(2, '0') : s + 's'
}

/* what a long run has produced so far, next to its clock */
let tally = { kept: 0, files: 0 }

function tick () {
  if (repeatAt && !isBusy()) {
    statusTime.textContent = 'in ' + formatElapsed(repeatAt - Date.now())
  } else if (runStartedAt) {
    const parts = []
    if (tally.applied) parts.push(tally.applied + ' applied')
    if (tally.kept) parts.push(tally.kept + ' kept')
    if (tally.files) parts.push(tally.files + (tally.files === 1 ? ' file' : ' files'))
    statusTime.textContent = (parts.length ? parts.join(' · ') + ' · ' : '') + formatElapsed(Date.now() - runStartedAt)
  }
}

function setStatus (status, text) {
  lastStatus = status
  panelEl.dataset.status = repeatAt && !isBusy() ? 'waiting' : status
  const running = isBusy()
  statusBar.hidden = !running && !repeatAt
  if (text !== undefined) phaseText = text
  if (!running && repeatAt) {
    statusText.textContent = 'Next run at ' + new Date(repeatAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  } else {
    statusText.textContent = status === 'paused' ? (text || 'Paused') : (phaseText || 'Working…')
  }
  pauseButton.hidden = !running
  pauseButton.innerHTML = status === 'paused' ? ICONS.play : ICONS.pause
  pauseButton.title = status === 'paused' ? 'Resume' : 'Pause'
  pauseButton.disabled = status === 'stopping'
  stopButton.disabled = status === 'stopping'
  sendButton.disabled = running && status !== 'paused'
  openButton.classList.toggle('is-working', running)
  if ((running || repeatAt) && !clock) {
    clock = setInterval(tick, 1000)
    tick()
  } else if (!running && !repeatAt && clock) {
    clearInterval(clock)
    clock = null
  }
}

function stepRow (step) {
  if (steps[step]) return steps[step]
  const row = el('article', 'iris-step')
  const num = el('span', 'iris-step-num', String(step))
  const body = el('div', 'iris-step-body')
  const head = el('div', 'iris-step-head')
  const label = el('span', 'iris-step-label', 'Looking at the page')
  const detail = el('span', 'iris-step-detail', '')
  head.appendChild(label)
  head.appendChild(detail)
  body.appendChild(head)
  const thought = el('p', 'iris-step-thought', '')
  thought.hidden = true
  body.appendChild(thought)
  row.appendChild(num)
  row.appendChild(body)
  const thumb = el('button', 'iris-step-thumb')
  thumb.type = 'button'
  thumb.hidden = true
  thumb.title = 'Show what Iris saw'
  thumb.addEventListener('click', function () { row.classList.toggle('is-expanded') })
  row.appendChild(thumb)
  const shot = el('div', 'iris-step-shot')
  body.appendChild(shot)
  streamEl.appendChild(row)
  trimStream()
  const rec = { row, body, label, detail, thought, thumb, shot, obs: null }
  steps[step] = rec
  scrollToEnd()
  return rec
}

function addObservation (payload) {
  const rec = stepRow(payload.step)
  rec.obs = payload
  rec.row.classList.add('is-active')
  rec.thumb.hidden = false
  rec.thumb.style.backgroundImage = 'url("' + payload.dataUrl + '")'
  rec.shot.innerHTML = ''
  const img = document.createElement('img')
  img.src = payload.dataUrl
  img.alt = 'What Iris saw at step ' + payload.step
  rec.shot.appendChild(img)
}

function addThought (payload) {
  const rec = steps[payload.step]
  if (!rec) return
  const kind = payload.action && payload.action.type
  if (kind === 'done' || kind === 'fail') {
    rec.label.textContent = kind === 'done' ? 'Answer' : 'Gave up'
    rec.detail.textContent = ''
  }
  if (payload.thought) {
    rec.thought.hidden = false
    rec.thought.textContent = payload.thought
  }
  if (payload.modelMs) rec.row.title = 'Decided in ' + (payload.modelMs / 1000).toFixed(1) + ' s'
}

function actionDetail (action, description) {
  switch (action.type) {
    case 'type': return '“' + action.text + '”' + (action.enter ? ' ↵' : '')
    case 'navigate': return action.url
    case 'find': return '“' + action.text + '”'
    case 'recall': return '“' + action.query + '”'
    case 'lookup': return '“' + action.query + '”'
    case 'bookmark': return action.remove ? 'remove' : (action.url || '')
    case 'dialog': return action.accept ? 'OK' : 'Cancel'
    case 'upload': return action.file
    case 'tailor_resume':
    case 'cover_letter': return action.title + (action.company ? ' · ' + action.company : '')
    case 'log_application': return ({ applied: 'applied', skipped: 'skipped', needs_you: 'needs you', failed: 'failed' })[action.status] + (action.title ? ' · ' + action.title : '')
    case 'ask_user': return ''
    case 'new_tab': return action.url || ''
    case 'switch_tab':
    case 'close_tab': return action.tab ? '#' + action.tab : ''
    case 'scroll': return action.direction
    case 'key': return ((action.modifiers || []).join('+') ? action.modifiers.join('+') + '+' : '') + action.key
    case 'wait': return (action.ms || 0) / 1000 + ' s'
    case 'click':
    case 'double_click':
    case 'right_click':
    case 'move':
    case 'zoom':
      return ''
    default: return description || ''
  }
}

function looksLikeUrl (text) {
  return /^[a-z]+:\/\/|^[^\s]+\.[a-z]{2,}(\/|:|$)|^localhost/i.test(String(text || '').trim())
}

function addSubAction (rec, label, detail) {
  const sub = el('div', 'iris-step-sub')
  sub.appendChild(el('span', 'iris-step-label', label))
  if (detail) sub.appendChild(el('span', 'iris-step-detail', detail))
  rec.body.insertBefore(sub, rec.thought)
}

function addAction (payload) {
  const kind = payload.action.type
  if (payload.automatic) {
    setStatus(lastStatus === 'paused' ? 'paused' : 'running', 'Waiting for the page to load…')
    return
  }
  const rec = steps[payload.step] || stepRow(payload.step)
  const label = kind === 'navigate' && !looksLikeUrl(payload.action.url) ? 'Search' : (ACTION_LABELS[kind] || kind)
  const detail = actionDetail(payload.action, payload.description)
  if (payload.index > 0) {
    addSubAction(rec, label, detail)
  } else {
    rec.label.textContent = label
    rec.detail.textContent = detail
    rec.row.dataset.kind = kind
  }

  if (payload.anchor && rec.obs) {
    const dot = el('span', 'iris-shot-dot')
    dot.style.left = (payload.anchor.x / rec.obs.viewWidth) * 100 + '%'
    dot.style.top = (payload.anchor.y / rec.obs.viewHeight) * 100 + '%'
    if (!rec.obs.crop) rec.shot.appendChild(dot)
  }
  setStatus(lastStatus === 'paused' ? 'paused' : 'running', label + (detail ? ' ' + detail : '') + '…')
}

function addResult (payload) {
  const rec = steps[payload.step]
  if (!rec) return
  if (!payload.ok) {
    rec.row.classList.add('is-error')
    rec.body.appendChild(el('div', 'iris-step-error', payload.error || 'That did not work'))
  }
}

/* A quick look-up outside the browser: one line, updated when the results arrive. */
const LOOKUP_KINDS = { web: 'Web', papers: 'Papers', arxiv: 'arXiv', wiki: 'Wikipedia', page: 'Page' }

function addLookup (p) {
  removeEmpty()
  const key = p.step + '|' + p.kind + '|' + p.query
  const row = el('div', 'iris-lookup')
  row.appendChild(el('span', 'iris-lookup-kind', LOOKUP_KINDS[p.kind] || 'Web'))
  row.appendChild(el('span', 'iris-lookup-query', p.query))
  const meta = el('span', 'iris-lookup-meta', 'looking up…')
  row.appendChild(meta)
  lookupRows[key] = meta
  if (p.step > 0 && steps[p.step]) steps[p.step].body.appendChild(row)
  else streamEl.appendChild(row)
  scrollToEnd()
}

function lookupDone (p) {
  const meta = lookupRows[p.step + '|' + p.kind + '|' + p.query]
  if (!meta) return
  meta.textContent = p.ok ? p.count + (p.count === 1 ? ' result' : ' results') : 'unavailable'
  meta.parentNode.classList.toggle('is-failed', !p.ok)
}

/* Planning questions: a small quiz. Answers go back as one message; "Just go" skips. */
function addQuestions (questions) {
  removeEmpty()
  const card = el('div', 'iris-quiz')
  card.appendChild(el('div', 'iris-plan-title', 'A few quick questions'))
  const picks = questions.map(function () { return { value: '' } })
  questions.forEach(function (q, qi) {
    const block = el('div', 'iris-quiz-q')
    block.appendChild(el('div', 'iris-quiz-label', q.q))
    const opts = el('div', 'iris-quiz-options')
    q.options.forEach(function (o) {
      const b = el('button', 'iris-quiz-opt', o)
      b.type = 'button'
      b.addEventListener('click', function () {
        opts.querySelectorAll('.iris-quiz-opt').forEach(function (x) { x.classList.remove('is-on') })
        b.classList.add('is-on')
        other.value = ''
        picks[qi].value = o
      })
      opts.appendChild(b)
    })
    const other = document.createElement('input')
    other.className = 'iris-quiz-other'
    other.placeholder = 'Something else…'
    other.addEventListener('input', function () {
      opts.querySelectorAll('.iris-quiz-opt').forEach(function (x) { x.classList.remove('is-on') })
      picks[qi].value = other.value.trim()
    })
    block.appendChild(opts)
    block.appendChild(other)
    card.appendChild(block)
  })
  const actions = el('div', 'iris-quiz-actions')
  const go = el('button', 'iris-btn-primary', 'Continue')
  go.type = 'button'
  const skip = el('button', 'iris-btn-quiet', 'Just go')
  skip.type = 'button'
  const close = function () { card.classList.add('is-done'); card.querySelectorAll('button, input').forEach(function (x) { x.disabled = true }) }
  go.addEventListener('click', function () {
    const text = questions.map(function (q, i) { return picks[i].value ? q.q + ' → ' + picks[i].value : '' }).filter(Boolean).join('\n')
    close()
    ipc.send('iris-agent-answer', text)
  })
  skip.addEventListener('click', function () {
    close()
    ipc.send('iris-agent-resume')
  })
  actions.appendChild(skip)
  actions.appendChild(go)
  card.appendChild(actions)
  streamEl.appendChild(card)
  scrollToEnd()
}

function addPlanCard (text, updated, level) {
  removeEmpty()
  const card = el('div', 'iris-plan')
  card.appendChild(el('div', 'iris-plan-title', updated ? 'Plan updated' : (level === 'deep' ? 'Plan · Deep' : 'Plan')))
  card.appendChild(el('pre', 'iris-plan-text', text))
  streamEl.appendChild(card)
  scrollToEnd()
}

function addVerdict (v) {
  addNote((v.keep ? '✓ Kept: ' : '✗ Skipped: ') + v.item + (v.why ? ' — ' + v.why : ''), v.keep ? 'keep' : 'skip')
}

/* A resume made for one job: what it fits, and a way to look at it. */
function addResumeCard (p) {
  removeEmpty()
  const card = el('div', 'iris-resume' + (p.ok ? (p.below ? ' is-below' : '') : ' is-failed'))
  const head = el('div', 'iris-resume-head')
  head.appendChild(el('span', 'iris-resume-title', 'Resume · ' + (p.title || 'job') + (p.company ? ' · ' + p.company : '')))
  if (p.ok && p.fit !== null && p.fit !== undefined) head.appendChild(el('span', 'iris-resume-fit', 'fit ' + p.fit))
  card.appendChild(head)
  if (!p.ok) {
    card.appendChild(el('div', 'iris-resume-meta', p.error || 'Could not make it'))
  } else {
    const bits = []
    if (p.focus) bits.push(p.focus)
    if (p.below) bits.push('below your cutoff, not applying')
    if (p.missing && p.missing.length) bits.push('not in your profile: ' + p.missing.slice(0, 3).join(', '))
    if (p.undone) bits.push(p.undone + (p.undone === 1 ? ' rewrite' : ' rewrites') + ' undone (added facts)')
    if (bits.length) card.appendChild(el('div', 'iris-resume-meta', bits.join(' · ')))
    const tools = el('div', 'iris-resume-tools')
    const open = el('button', 'iris-btn-quiet', 'Open PDF')
    open.type = 'button'
    open.addEventListener('click', function () { ipc.send('iris-resume-open', { file: p.file }) })
    const show = el('button', 'iris-btn-quiet', 'Show in Finder')
    show.type = 'button'
    show.addEventListener('click', function () { ipc.send('iris-resume-open', { file: p.file, reveal: true }) })
    tools.appendChild(open)
    tools.appendChild(show)
    card.appendChild(tools)
  }
  streamEl.appendChild(card)
  trimStream()
  scrollToEnd()
}

const APPLICATION_TEXT = { applied: '✓ Applied', skipped: '✗ Skipped', needs_you: '! Needs you', failed: '✗ Could not apply' }

function addNote (text, kind) {
  removeEmpty()
  const note = el('div', 'iris-note' + (kind ? ' iris-note-' + kind : ''), text)
  streamEl.appendChild(note)
  trimStream()
  scrollToEnd()
}

function addResultCard (payload, elapsedMs) {
  Object.keys(steps).forEach(function (k) { steps[k].row.classList.remove('is-active') })
  const status = payload.status
  const card = el('div', 'iris-result iris-result-' + status)
  const head = el('div', 'iris-result-head')
  const icon = el('span', 'iris-result-icon')
  icon.innerHTML = status === 'done' ? ICONS.check : ICONS.cross
  head.appendChild(icon)
  head.appendChild(el('span', 'iris-result-title', status === 'done' ? 'Done' : (status === 'stopped' ? 'Stopped' : 'Could not finish')))
  const ms = elapsedMs || (runStartedAt ? Date.now() - runStartedAt : 0)
  head.appendChild(el('span', 'iris-result-meta', (payload.steps || 0) + ' steps' + (ms ? ' · ' + formatElapsed(ms) : '')))
  card.appendChild(head)
  const text = status === 'done' ? (payload.answer || 'Task complete.') : (payload.reason || payload.answer || '')
  if (text) card.appendChild(el('p', 'iris-result-text', text))
  streamEl.appendChild(card)
  scrollToEnd()
}

function trimStream () {
  while (streamEl.querySelectorAll('.iris-step').length > MAX_STEPS_SHOWN) {
    const first = streamEl.querySelector('.iris-step')
    if (!first) break
    first.remove()
  }
  // a run of many hours also piles up notes, decisions and look-ups: keep the newest ones
  const items = streamEl.children
  if (items.length > MAX_ITEMS_SHOWN) {
    const drop = items.length - MAX_ITEMS_SHOWN
    for (let i = 0; i < drop; i++) streamEl.removeChild(streamEl.firstElementChild)
    if (!streamEl.querySelector('.iris-trimmed')) {
      streamEl.insertBefore(el('div', 'iris-note iris-trimmed', 'Older steps are hidden to keep the panel fast. Everything is saved in History.'), streamEl.firstChild)
    }
  }
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

function handleEvent (payload) {
  if (payload.sessionId && currentSessionId && payload.sessionId !== currentSessionId && payload.type !== 'session') return
  const keep = lastStatus === 'paused' ? 'paused' : 'running'
  switch (payload.type) {
    case 'session':
      currentSessionId = payload.session && payload.session.id
      break
    case 'run:start':
      if (!payload.followUp) tally = { kept: 0, files: 0 }
      setStatus('running', 'Starting…')
      break
    case 'observation':
      addObservation(payload)
      setStatus(keep, 'Looking at the page…')
      break
    case 'model:start':
      setStatus(keep, payload.checking ? 'Checking the answer…' : 'Thinking…')
      break
    case 'answer:checked':
      addNote('Left out what Iris could not confirm on the page: ' + (payload.removed || []).join('; '), 'memo')
      break
    case 'model:progress':
      if (payload.planning) setStatus(keep, 'Planning · ' + Math.round((payload.elapsedMs || 0) / 1000) + 's')
      else if (payload.phase === 'queued') setStatus(keep, 'Waiting for another Iris window to finish with the model…')
      else if (payload.phase === 'waiting') setStatus(keep, 'Reading the page…')
      else if (payload.phase === 'thinking') setStatus(keep, 'Thinking · ' + Math.round(payload.elapsedMs / 1000) + 's')
      else setStatus(keep, 'Deciding…')
      break
    case 'thought':
      addThought(payload)
      break
    case 'remember':
      if (!payload.automatic) addNote('Noted: ' + payload.note, 'memo')
      break
    case 'learn':
      addNote('Learned for next time: ' + payload.tip, 'memo')
      break
    case 'plan:start':
      lookupRows = {}
      setStatus(keep, payload.level === 'deep' ? 'Researching the task…' : 'Planning…')
      break
    case 'lookup':
      addLookup(payload)
      setStatus(keep, 'Looking up ' + (LOOKUP_KINDS[payload.kind] || 'the web').toLowerCase() + '…')
      break
    case 'lookup:result':
      lookupDone(payload)
      if (payload.step === 0) setStatus(keep, 'Planning…')
      break
    case 'plan':
      addPlanCard(payload.text, payload.updated, payload.level)
      break
    case 'questions':
      addQuestions(payload.questions)
      setStatus('paused', 'Iris has a few questions before planning')
      break
    case 'resume:start':
      setStatus(keep, (payload.letter ? 'Writing a cover letter for ' : 'Tailoring the resume for ') + (payload.title || 'this job') + '…')
      break
    case 'letter':
      addNote('Wrote a cover letter for ' + (payload.title || 'the job') + ' (' + payload.words + ' words' + (payload.removed ? ', ' + payload.removed + ' unsupported sentence(s) taken out' : '') + ')', 'memo')
      break
    case 'resume':
      addResumeCard(payload)
      break
    case 'application': {
      const a = payload.item || {}
      addNote((APPLICATION_TEXT[a.status] || a.status) + ': ' + (a.title || 'job') + (a.company ? ' — ' + a.company : '') + (a.note && a.status !== 'applied' ? ' (' + a.note + ')' : ''),
        a.status === 'applied' ? 'keep' : (a.status === 'needs_you' || a.status === 'failed' ? 'warn' : 'skip'))
      if (a.status === 'applied') tally.applied = (tally.applied || 0) + 1
      break
    }
    case 'verdict':
      addVerdict(payload)
      if (payload.keep) tally.kept++
      break
    case 'download':
      if (payload.state === 'started') setStatus(keep, 'Downloading ' + (payload.name || 'a file') + '…')
      else if (payload.state === 'completed') { tally.files++; addNote('Downloaded ' + payload.name + ' to your Downloads folder', 'memo') }
      else if (payload.state === 'skipped') addNote('Skipped ' + payload.name + ' — already downloaded as ' + payload.existing, 'memo')
      else addNote('Download failed: ' + payload.name + ' (' + payload.state + ')', 'warn')
      break
    case 'action':
      addAction(payload)
      break
    case 'action:result':
      addResult(payload)
      break
    case 'rejected':
      addNote('The model gave an unusable answer; asking again.', 'warn')
      break
    case 'blocked':
      if (payload.kind !== 'loop') {
        setStatus('paused', payload.reason)
        addNote(payload.reason, 'warn')
      }
      break
    case 'takeover':
      setStatus('paused', 'Paused — you took over. Press ▶ to continue.')
      break
    case 'ask':
      addNote(payload.question, 'ask')
      setStatus('paused', payload.timeoutMs
        ? 'Iris is asking you — answer, or it carries on without it in ' + Math.round(payload.timeoutMs / 60000) + ' min'
        : 'Iris is asking you — type an answer, or press ▶')
      taskInput.placeholder = 'Answer Iris…'
      taskInput.focus()
      break
    case 'pause':
      setStatus('paused', 'Paused')
      break
    case 'ask:timeout':
      addNote('No answer, so Iris carried on without it.', 'memo')
      break
    case 'resume':
      setStatus('running', 'Continuing…')
      break
    case 'stop':
      setStatus('stopping', 'Stopping…')
      break
    case 'run:end':
      setStatus(payload.status)
      addResultCard(payload)
      runStartedAt = 0
      taskInput.placeholder = 'Reply to continue, or start a new chat with +'
      break
    case 'repeat:scheduled':
      repeatAt = payload.at
      setStatus(lastStatus)
      addNote(payload.resume
        ? 'Non-stop: carrying on in ' + formatElapsed(payload.at - Date.now()) + '. Press Stop to end it.'
        : 'Next run in ' + formatElapsed(payload.minutes * 60000) + '. Press Stop to cancel.', 'memo')
      break
    case 'repeat:cancelled':
      repeatAt = 0
      setStatus(lastStatus)
      break
    case 'error':
      if (payload.where === 'screenshot') setStatus(keep, 'Waiting for the page to appear…')
      else if (payload.where === 'server') setStatus(keep, 'Model server unavailable · retrying in ' + Math.round((payload.waitMs || 0) / 1000) + 's')
      else if (payload.where === 'context') addNote(payload.error, 'memo')
      else if (payload.where === 'plan') addNote('Could not make a plan (' + payload.error + '); going ahead without one.', 'warn')
      else if (payload.where === 'model') addNote('Model error: ' + payload.error + ' — retrying.', 'warn')
      break
    default:
      break
  }
}

function refreshModelBadge () {
  const cfg = currentSettings()
  const name = cfg.model || 'No model set'
  modelBadge.textContent = name.replace(/-GGUF.*$/i, '')
  modelBadge.title = (cfg.model || '') + (cfg.baseUrl ? '\n' + cfg.baseUrl : '')
  if (thinkingSelect && document.activeElement !== thinkingSelect.select) thinkingSelect.select.value = cfg.thinking || 'low'
  if (planToggle) {
    planToggle.classList.toggle('is-on', !!cfg.planFirst)
    planToggle.setAttribute('aria-pressed', String(!!cfg.planFirst))
    renderSmartLevel()
  }
}

/* Tell the main process which tabs exist, so Iris can follow new tabs and switch between them. */
let tabsTimer = null
function pushTabs () {
  clearTimeout(tabsTimer)
  tabsTimer = null
  try {
    ipc.send('iris-tabs-state', {
      selected: tabs.getSelected(),
      tabs: tabs.get().map(function (t) { return { id: t.id, title: t.title || '', url: t.url || '' } })
    })
  } catch (e) { /* tabs not ready yet */ }
}
function pushTabsSoon () {
  if (!tabsTimer) tabsTimer = setTimeout(pushTabs, 120)
}

function runTabAction (cmd) {
  const browserUI = require('browserUI.js')
  if (!cmd) return
  if (cmd.op === 'switch' && tabs.get(cmd.id)) {
    browserUI.switchToTab(cmd.id)
  } else if (cmd.op === 'new') {
    const id = tabs.add(cmd.url ? { url: cmd.url } : {})
    browserUI.addTab(id, { enterEditMode: false })
  } else if (cmd.op === 'close' && tabs.get(cmd.id)) {
    browserUI.closeTab(cmd.id)
  }
  pushTabs()
}

/* Settings → History: newest visits first, searchable, one at a time removable. */
function historyAction (tabId, a) {
  const places = require('places/places.js')
  const reply = function (result) { webviews.callAsync(tabId, 'send', ['irisSettingsActionResult', { action: 'historyList', result }]) }
  const list = function () {
    return places.getAllItems().then(function (all) {
      const q = String((a.args && a.args.query) || '').toLowerCase().split(/\s+/).filter(Boolean)
      const visited = (all || []).filter(function (i) { return i.lastVisit && i.visitCount > 0 && !/^min:/.test(i.url) })
      const hits = visited.filter(function (i) {
        const hay = ((i.title || '') + ' ' + i.url).toLowerCase()
        return q.every(function (w) { return hay.indexOf(w) !== -1 })
      }).sort(function (x, y) { return y.lastVisit - x.lastVisit })
      reply({ items: hits.slice(0, 200).map(function (i) { return { url: i.url, title: i.title, lastVisit: i.lastVisit } }), total: hits.length })
    })
  }
  if (a.action === 'historyDelete' && a.args && a.args.url) {
    places.deleteHistory(a.args.url)
    return setTimeout(list, 150)
  }
  return list()
}

/* The settings page (a min:// tab) edits "My info" through here; secrets never travel back. */
function bindProfileBridge () {
  webviews.bindIPC('irisProfileGet', function (tabId) {
    if (!urlParser.isInternalURL(tabs.get(tabId).url)) return
    ipc.send('iris-profile-get', { tabId })
  })
  webviews.bindIPC('irisProfileSet', function (tabId, args) {
    if (!urlParser.isInternalURL(tabs.get(tabId).url)) return
    ipc.send('iris-profile-set', { tabId, fields: args[0] && args[0].fields })
  })
  const forward = {
    irisAccountsGet: 'iris-accounts-get',
    irisAccountReveal: 'iris-account-reveal',
    irisAccountDelete: 'iris-account-delete'
  }
  Object.keys(forward).forEach(function (name) {
    webviews.bindIPC(name, function (tabId, args) {
      if (!urlParser.isInternalURL(tabs.get(tabId).url)) return
      ipc.send(forward[name], Object.assign({ tabId }, args[0] || {}))
    })
  })
  webviews.bindIPC('irisSettingsAction', function (tabId, args) {
    if (!urlParser.isInternalURL(tabs.get(tabId).url)) return
    const a = args[0] || {}
    // history lives in the browser UI's places database; the rest is done by the main process
    if (a.action === 'historyList' || a.action === 'historyDelete') return historyAction(tabId, a)
    if (a.action === 'clearData' && a.args && a.args.history) require('places/places.js').deleteAllHistory()
    ipc.send('iris-settings-action', { tabId, action: a.action, args: a.args })
  })
  ipc.on('iris-settings-action-reply', function (e, data) {
    if (data && data.tabId && tabs.get(data.tabId)) webviews.callAsync(data.tabId, 'send', ['irisSettingsActionResult', data])
  })
  ipc.on('iris-accounts-data', function (e, data) {
    if (!data || !data.tabId || !tabs.get(data.tabId)) return
    webviews.callAsync(data.tabId, 'send', ['irisAccountsData', { accounts: data.accounts, revealed: data.revealed }])
  })
  ipc.on('iris-profile-data', function (e, data) {
    if (!data || !data.tabId || !tabs.get(data.tabId)) return
    webviews.callAsync(data.tabId, 'send', ['irisProfileData', { fields: data.fields, saved: data.saved, error: data.error }])
  })
}

function initialize () {
  buildPanel()

  ipc.on('iris-agent-event', function (e, payload) {
    handleEvent(payload)
  })

  ipc.on('iris-bridge-activity', bridgeActivity)

  // Min's "Save password?" bar sits outside the page, where Iris cannot see it, and takes room from the
  // page. Iris typed the password from My info anyway, so while Iris works the bar is dismissed.
  const pwBar = document.getElementById('password-capture-bar')
  if (pwBar && window.MutationObserver) {
    new MutationObserver(function () {
      if (!pwBar.hidden && isBusy()) {
        const ignore = document.getElementById('password-capture-ignore')
        if (ignore) setTimeout(function () { if (!pwBar.hidden && isBusy()) ignore.click() }, 300)
      }
    }).observe(pwBar, { attributes: true, attributeFilter: ['hidden'] })
  }

  ipc.on('iris-agent-control-reply', function (e, reply) {
    if (reply && reply.status && reply.status !== lastStatus && (reply.status === 'paused' || reply.status === 'running')) setStatus(reply.status)
  })

  ipc.on('iris-agent-start-reply', function (e, reply) {
    if (!reply.ok) {
      setStatus('failed')
      addResultCard({ status: 'failed', reason: reply.error, steps: 0 })
    } else if (reply.sessionId) {
      currentSessionId = reply.sessionId
    }
  })

  ipc.on('iris-agent-sessions-reply', function (e, list) {
    if (showingHistory) renderHistory(list)
  })

  ipc.on('iris-agent-session-data', function (e, data) {
    renderSession(data)
  })

  // the page got hidden behind the address bar / a menu while Iris needs to see it
  ipc.on('iris-agent-need-view', function (e, data) {
    if (data && String(tabs.getSelected()) === String(data.tabId)) {
      try { require('navbar/tabEditor.js').hide() } catch (err) { /* not open */ }
      // the address bar or Iris's bookmarks menu can be left "open" with nothing on screen (the window
      // lost focus, or the page changed underneath): they no longer need the page hidden
      const w = require('webviews.js')
      ;['editMode', 'bookmarksMenu'].forEach(function (reason) {
        if (w.placeholderRequests.includes(reason)) w.hidePlaceholder(reason)
      })
      // nothing asks for it to be hidden, yet it is not on screen: put it back
      if (!w.placeholderRequests.length && w.hasViewForTab(w.selectedId)) ipc.send('setView', { id: w.selectedId, bounds: w.getViewBounds(), focus: false })
      if (w.placeholderRequests.length) ipc.send('iris-agent-view-state', { placeholders: w.placeholderRequests.slice() })
    }
  })

  ipc.on('iris-agent-tab-action', function (e, cmd) {
    runTabAction(cmd)
  })

  // a scheduled task is due: run it in a fresh tab, as a new chat
  ipc.on('iris-agent-scheduled-run', function (e, data) {
    if (isBusy() || !data || !data.task) return
    const id = tabs.add({})
    require('browserUI.js').addTab(id, { enterEditMode: false })
    setPanel(true)
    currentSessionId = null
    streamEl.innerHTML = ''
    setTimeout(function () {
      submitTask(data.task, { tabId: id, mode: data.mode || 'once', newSession: true })
    }, 400)
  })

  ipc.on('iris-agent-settings', function (e, cfg) {
    if (cfg) mainSettings = cfg
    refreshModelBadge()
  })
  ipc.on('iris-agent-status-reply', function (e, status) {
    if (status && status.settings) mainSettings = status.settings
    refreshModelBadge()
  })

  ipc.send('iris-agent-status')
  settings.listen('irisAI', refreshModelBadge)

  tasks.on('tab-selected', pushTabsSoon)
  tasks.on('tab-added', pushTabsSoon)
  tasks.on('tab-destroyed', pushTabsSoon)
  tasks.on('task-selected', pushTabsSoon)
  tasks.on('tab-updated', function (id, key) {
    if (key === 'title' || key === 'url') pushTabsSoon()
  })
  setTimeout(pushTabs, 500)

  bindProfileBridge()

  ipc.on('iris-projects-reply', function (e, data) {
    projects = (data && data.projects) || []
    if (data && data.created) {
      currentProjectId = data.created
      settings.set('irisAI', Object.assign({}, settings.get('irisAI') || {}, { currentProject: data.created }))
      newChat()
    }
    renderProjects()
  })
  currentProjectId = (settings.get('irisAI') || {}).currentProject || null
  ipc.send('iris-projects')

  window.addEventListener('keydown', function (e) {
    // Esc closes the idle panel when it has focus
    if (e.key === 'Escape' && panelOpen && !isBusy() && document.activeElement && document.activeElement.closest && document.activeElement.closest('.iris-panel')) {
      setPanel(false)
    }
  })

  refreshModelBadge()

  /*
   * Development affordance: IRIS_AUTODEMO=1 opens the panel and runs a scripted task so the
   * full capture → decide → inject → marker path can be exercised (with IRIS_FAKE_MODEL=1)
   * without a model server. Never active in normal use.
   */
  if (typeof process !== 'undefined' && process.env && process.env.IRIS_AUTODEMO) {
    setTimeout(function () {
      setPanel(true)
      taskInput.value = 'Demo: click the middle of the page, scroll down, then stop'
      submitTask()
    }, 4500)
  }
}

module.exports = { initialize, togglePanel, openPanel: function () { setPanel(true) }, closePanel: function () { setPanel(false) } }
