/*
 * js/iris/agentPanel.js — the Iris AI side panel (browser UI renderer).
 *
 * Responsibilities:
 *   • own the panel DOM (conversation, composer, live status, run controls)
 *   • relay control messages to the main process and render its event stream
 *   • keep the web view from being occluded by the panel (webviews.adjustMargin) so the
 *     agent's click coordinates always map onto visible page content
 *   • show each step: what Iris did, why, and the screenshot it decided from
 *
 * The panel never inspects or mutates page content. Page access lives in main/irisAgent.js.
 */

const webviews = require('webviews.js')
const settings = require('util/settings/settings.js')

const PANEL_WIDTH = 380
const MAX_STEPS_SHOWN = 60

const SUGGESTIONS = [
  'What is the weather in Chicago today?',
  'Search Wikipedia for the Eiffel Tower and tell me how tall it is',
  'Summarize this page in three bullet points'
]

const THINKING_LABELS = { off: 'Fast', low: 'Balanced', medium: 'Careful', full: 'Deep' }

const ICONS = {
  close: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  gear: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.5-2-3.4-2.3.9a7.5 7.5 0 0 0-2.6-1.5L14.1 2.5h-4.2l-.4 2.5a7.5 7.5 0 0 0-2.6 1.5l-2.3-.9-2 3.4 2 1.5a7.6 7.6 0 0 0 0 3l-2 1.5 2 3.4 2.3-.9a7.5 7.5 0 0 0 2.6 1.5l.4 2.5h4.2l.4-2.5a7.5 7.5 0 0 0 2.6-1.5l2.3.9 2-3.4-2-1.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
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
  done: 'Done',
  fail: 'Stop'
}

let panelEl = null
let openButton = null
let taskInput = null
let sendButton = null
let thinkingSelect = null
let streamEl = null
let statusBar = null
let statusText = null
let statusTime = null
let pauseButton = null
let stopButton = null
let modelBadge = null
let panelOpen = false
let lastStatus = 'idle'
let runStartedAt = 0
let clock = null
let currentStepRow = null
let steps = {}
let lastObservation = null
let phaseText = ''
let mainSettings = {} // defaults merged with stored values, as the main process sees them

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
  const settingsBtn = iconButton('', ICONS.gear, 'AI settings')
  settingsBtn.addEventListener('click', function () {
    tabs.enterData('min://app/pages/settings/index.html#iris-ai', { focus: true })
  })
  header.appendChild(settingsBtn)
  const closeBtn = iconButton('', ICONS.close, 'Close panel')
  closeBtn.addEventListener('click', function () { setPanel(false) })
  header.appendChild(closeBtn)
  panelEl.appendChild(header)

  // live status (only while a task runs)
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

  // conversation
  streamEl = el('div', 'iris-stream has-thin-scrollbar')
  streamEl.appendChild(emptyState())
  panelEl.appendChild(streamEl)

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
  sendButton = iconButton('iris-send', ICONS.send, 'Run task')
  sendButton.addEventListener('click', submitTask)
  box.appendChild(sendButton)
  composer.appendChild(box)

  const meta = el('div', 'iris-composer-meta')
  const thinkingLabel = el('label', 'iris-thinking')
  thinkingLabel.appendChild(el('span', '', 'Mode'))
  thinkingSelect = document.createElement('select')
  Object.keys(THINKING_LABELS).forEach(function (k) {
    const o = document.createElement('option')
    o.value = k
    o.textContent = THINKING_LABELS[k]
    thinkingSelect.appendChild(o)
  })
  thinkingSelect.value = currentSettings().thinking
  thinkingSelect.title = 'How much Iris thinks before each action. Fast is quickest; Deep is slowest.'
  thinkingSelect.addEventListener('change', function () {
    settings.set('irisAI', Object.assign({}, settings.get('irisAI') || {}, { thinking: thinkingSelect.value }))
  })
  thinkingLabel.appendChild(thinkingSelect)
  meta.appendChild(thinkingLabel)
  meta.appendChild(el('span', 'iris-hint', 'Click or type in the page to take over'))
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

function emptyState () {
  const empty = el('div', 'iris-empty')
  empty.appendChild(el('h2', 'iris-empty-title', 'What should Iris do?'))
  empty.appendChild(el('p', 'iris-empty-text', 'Iris reads the page from screenshots and uses the mouse and keyboard, just like you. You can watch every step and take over at any time.'))
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
 * Open / close
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
    thinkingSelect.value = currentSettings().thinking
    setTimeout(function () { taskInput.focus() }, 60)
  }
}

function togglePanel () {
  setPanel(!panelOpen)
}

function submitTask () {
  const task = taskInput.value.trim()
  if (!task) {
    taskInput.focus()
    return
  }
  if (lastStatus === 'running' || lastStatus === 'paused' || lastStatus === 'stopping') return
  const activeTabId = tabs.getSelected()
  if (!activeTabId) return

  // the address bar hides the page behind a placeholder; Iris needs to see the page
  try { require('navbar/tabEditor.js').hide() } catch (e) { /* not open */ }

  clearStream()
  addUserMessage(task)
  taskInput.value = ''
  autosize()
  runStartedAt = Date.now()
  setStatus('running', 'Starting…')
  ipc.send('iris-agent-start', {
    task: task,
    tabId: activeTabId,
    // where the page is drawn, so Iris can see a tab that has no view attached yet
    viewBounds: webviews.getViewBounds()
  })
}

/* ------------------------------------------------------------------ *
 * Rendering the event stream
 * ------------------------------------------------------------------ */

function clearStream () {
  streamEl.innerHTML = ''
  steps = {}
  currentStepRow = null
  lastObservation = null
}

function scrollToEnd () {
  streamEl.scrollTop = streamEl.scrollHeight
}

function addUserMessage (task) {
  const msg = el('div', 'iris-user-msg', task)
  streamEl.appendChild(msg)
  scrollToEnd()
}

function formatElapsed (ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  return m ? m + ':' + String(s % 60).padStart(2, '0') : s + 's'
}

function tick () {
  if (!runStartedAt) return
  statusTime.textContent = formatElapsed(Date.now() - runStartedAt)
}

function setStatus (status, text) {
  lastStatus = status
  panelEl.dataset.status = status
  const running = status === 'running' || status === 'paused' || status === 'stopping'
  statusBar.hidden = !running
  if (text !== undefined) phaseText = text
  statusText.textContent = status === 'paused' ? (text || 'Paused') : (phaseText || 'Working…')
  pauseButton.innerHTML = status === 'paused' ? ICONS.play : ICONS.pause
  pauseButton.title = status === 'paused' ? 'Resume' : 'Pause'
  pauseButton.disabled = status === 'stopping'
  stopButton.disabled = status === 'stopping'
  sendButton.disabled = running
  taskInput.disabled = false
  openButton.classList.toggle('is-working', running)
  if (running && !clock) {
    clock = setInterval(tick, 1000)
    tick()
  } else if (!running && clock) {
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
  const rec = { row, label, detail, thought, thumb, shot, obs: null }
  steps[step] = rec
  currentStepRow = rec
  scrollToEnd()
  return rec
}

function addObservation (payload) {
  lastObservation = payload
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
  const rec = steps[payload.step] || currentStepRow
  if (!rec) return
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
    case 'scroll': return action.direction
    case 'key': return ((action.modifiers || []).join('+') ? action.modifiers.join('+') + '+' : '') + action.key
    case 'wait': return (action.ms || 0) / 1000 + ' s'
    case 'click':
    case 'double_click':
    case 'right_click':
    case 'move':
      return ''
    default: return description || ''
  }
}

function addAction (payload) {
  const kind = payload.action.type
  if (payload.automatic) {
    setStatus(lastStatus === 'paused' ? 'paused' : 'running', 'Waiting for the page to load…')
    return
  }
  const rec = steps[payload.step] || stepRow(payload.step)
  rec.label.textContent = ACTION_LABELS[kind] || kind
  rec.detail.textContent = actionDetail(payload.action, payload.description)
  rec.row.dataset.kind = kind

  if (payload.anchor && rec.obs) {
    const dot = el('span', 'iris-shot-dot')
    dot.style.left = (payload.anchor.x / rec.obs.viewWidth) * 100 + '%'
    dot.style.top = (payload.anchor.y / rec.obs.viewHeight) * 100 + '%'
    rec.shot.appendChild(dot)
  }
  setStatus(lastStatus === 'paused' ? 'paused' : 'running', (ACTION_LABELS[kind] || kind) + (rec.detail.textContent ? ' ' + rec.detail.textContent : '') + '…')
}

function addResult (payload) {
  const rec = steps[payload.step]
  if (!rec) return
  rec.row.classList.remove('is-active')
  if (!payload.ok) {
    rec.row.classList.add('is-error')
    rec.body = rec.body || rec.row.querySelector('.iris-step-body')
    rec.body.appendChild(el('div', 'iris-step-error', payload.error || 'That did not work'))
  }
}

function addNote (text, kind) {
  const note = el('div', 'iris-note' + (kind ? ' iris-note-' + kind : ''), text)
  streamEl.appendChild(note)
  trimStream()
  scrollToEnd()
}

function addResultCard (payload) {
  Object.keys(steps).forEach(function (k) { steps[k].row.classList.remove('is-active') })
  const status = payload.status
  const card = el('div', 'iris-result iris-result-' + status)
  const head = el('div', 'iris-result-head')
  const icon = el('span', 'iris-result-icon')
  icon.innerHTML = status === 'done' ? ICONS.check : ICONS.cross
  head.appendChild(icon)
  head.appendChild(el('span', 'iris-result-title', status === 'done' ? 'Done' : (status === 'stopped' ? 'Stopped' : 'Could not finish')))
  const took = runStartedAt ? formatElapsed(Date.now() - runStartedAt) : ''
  head.appendChild(el('span', 'iris-result-meta', (payload.steps || 0) + ' steps' + (took ? ' · ' + took : '')))
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
  switch (payload.type) {
    case 'run:start':
      setStatus('running', 'Starting…')
      break
    case 'observation':
      addObservation(payload)
      setStatus(lastStatus === 'paused' ? 'paused' : 'running', 'Looking at the page…')
      break
    case 'model:start':
      setStatus(lastStatus === 'paused' ? 'paused' : 'running', 'Thinking…')
      break
    case 'model:progress':
      if (payload.phase === 'waiting') setStatus(lastStatus === 'paused' ? 'paused' : 'running', 'Reading the page…')
      else if (payload.phase === 'thinking') setStatus(lastStatus === 'paused' ? 'paused' : 'running', 'Thinking · ' + Math.round(payload.elapsedMs / 1000) + 's')
      else setStatus(lastStatus === 'paused' ? 'paused' : 'running', 'Deciding…')
      break
    case 'thought':
      addThought(payload)
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
      setStatus('paused', payload.reason)
      addNote(payload.reason, 'warn')
      break
    case 'takeover':
      setStatus('paused', 'Paused — you took over. Press ▶ to continue.')
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
      break
    case 'error':
      if (payload.where === 'screenshot') setStatus('running', 'Waiting for the page to appear…')
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
  if (thinkingSelect && document.activeElement !== thinkingSelect) thinkingSelect.value = cfg.thinking || 'low'
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
    }
  })

  // the page got hidden behind the address bar / a menu while Iris needs to see it
  ipc.on('iris-agent-need-view', function (e, data) {
    if (data && String(tabs.getSelected()) === String(data.tabId)) {
      try { require('navbar/tabEditor.js').hide() } catch (err) { /* not open */ }
    }
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

  window.addEventListener('keydown', function (e) {
    // Esc closes the idle panel when it has focus
    if (e.key === 'Escape' && panelOpen && lastStatus !== 'running' && document.activeElement && document.activeElement.closest && document.activeElement.closest('.iris-panel')) {
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
