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

const SUGGESTIONS = [
  'What is the weather in Chicago today?',
  'Search Wikipedia for the Eiffel Tower and tell me how tall it is',
  'Summarize this page in three bullet points'
]

const THINKING_LABELS = { off: 'Fast', low: 'Balanced', medium: 'Careful', full: 'Deep' }

const RUN_MODES = [
  { value: 'once', label: 'Once' },
  { value: 'continuous', label: 'Non-stop' },
  { value: 'repeat:15', label: 'Every 15 min' },
  { value: 'repeat:60', label: 'Every hour' },
  { value: 'repeat:360', label: 'Every 6 hours' },
  { value: 'repeat:1440', label: 'Every day' }
]

const ICONS = {
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
  thinkingSelect = selectControl('Thinking', Object.keys(THINKING_LABELS).map(function (k) { return { value: k, label: THINKING_LABELS[k] } }),
    'How much Iris thinks before each action. Fast is quickest; Deep is slowest.')
  thinkingSelect.select.addEventListener('change', function () {
    settings.set('irisAI', Object.assign({}, settings.get('irisAI') || {}, { thinking: thinkingSelect.select.value }))
  })
  meta.appendChild(thinkingSelect.label)
  modeSelect = selectControl('Run', RUN_MODES, 'Once: until the task is done. Non-stop: no step or time limit. Repeat: runs again on a timer until you press Stop.')
  meta.appendChild(modeSelect.label)
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

function selectControl (labelText, options, title) {
  const label = el('label', 'iris-select')
  label.appendChild(el('span', '', labelText))
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
  if (!list || !list.length) {
    historyEl.appendChild(el('p', 'iris-history-empty', 'No chats yet. Everything you ask Iris is saved here.'))
    return
  }
  list.forEach(function (s) {
    const row = el('div', 'iris-history-row' + (s.id === currentSessionId ? ' is-current' : ''))
    const main = el('button', 'iris-history-open')
    main.type = 'button'
    main.appendChild(el('span', 'iris-history-name', s.title || 'Untitled'))
    const status = s.status === 'done' ? 'Done' : s.status === 'running' ? 'Running' : s.status === 'stopped' ? 'Stopped' : s.status === 'failed' ? 'Failed' : ''
    main.appendChild(el('span', 'iris-history-meta', formatWhen(s.updated) + (status ? ' · ' + status : '') + (s.runs > 1 ? ' · ' + s.runs + ' runs' : '')))
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

function tick () {
  if (repeatAt && !isBusy()) {
    statusTime.textContent = 'in ' + formatElapsed(repeatAt - Date.now())
  } else if (runStartedAt) {
    statusTime.textContent = formatElapsed(Date.now() - runStartedAt)
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
    case 'dialog': return action.accept ? 'OK' : 'Cancel'
    case 'upload': return action.file
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
      setStatus('running', 'Starting…')
      break
    case 'observation':
      addObservation(payload)
      setStatus(keep, 'Looking at the page…')
      break
    case 'model:start':
      setStatus(keep, 'Thinking…')
      break
    case 'model:progress':
      if (payload.phase === 'waiting') setStatus(keep, 'Reading the page…')
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
    case 'download':
      if (payload.state === 'started') setStatus(keep, 'Downloading ' + (payload.name || 'a file') + '…')
      else if (payload.state === 'completed') addNote('Downloaded ' + payload.name + ' to your Downloads folder', 'memo')
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
      setStatus('paused', 'Iris is asking you — type an answer, or press ▶')
      taskInput.placeholder = 'Answer Iris…'
      taskInput.focus()
      break
    case 'pause':
      setStatus('paused', 'Paused')
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
      addNote('Next run in ' + formatElapsed(payload.minutes * 60000) + '. Press Stop to cancel.', 'memo')
      break
    case 'repeat:cancelled':
      repeatAt = 0
      setStatus(lastStatus)
      break
    case 'error':
      if (payload.where === 'screenshot') setStatus(keep, 'Waiting for the page to appear…')
      else if (payload.where === 'server') setStatus(keep, 'Model server unavailable · retrying in ' + Math.round((payload.waitMs || 0) / 1000) + 's')
      else if (payload.where === 'context') addNote(payload.error, 'memo')
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
