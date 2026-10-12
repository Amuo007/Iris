/*
 * js/iris/agentPanel.js — the Iris AI side panel (browser UI renderer).
 *
 * Responsibilities:
 *   • own the panel DOM (task field, run/pause/stop, step timeline, settings shortcuts)
 *   • relay control messages to the main process and render its event stream
 *   • keep the web view from being occluded by the panel (webviews.adjustMargin) so the
 *     agent's click coordinates always map onto visible page content
 *   • draw the agent's own screenshot back to the user with a marker dot on it
 *
 * The panel never inspects or mutates page content. Page access lives in main/irisAgent.js.
 */

const webviews = require('webviews.js')
const settings = require('util/settings/settings.js')

const PANEL_WIDTH = 384
const MAX_STEPS_SHOWN = 24

let panelEl = null
let openButton = null
let taskInput = null
let runButton = null
let pauseButton = null
let stopButton = null
let timelineEl = null
let statusEl = null
let modelBadge = null
let panelOpen = false
let lastStatus = 'idle'
let lastObservation = null
let lastSettings = null

function el (tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/* ------------------------------------------------------------------ *
 * Construction
 * ------------------------------------------------------------------ */

function buildPanel () {
  panelEl = el('aside', 'iris-panel')
  panelEl.hidden = true
  panelEl.setAttribute('role', 'complementary')
  panelEl.setAttribute('aria-label', 'Iris AI assistant')

  const header = el('header', 'iris-panel-header')
  const brand = el('div', 'iris-panel-brand')
  brand.innerHTML = '<span class="iris-glyph" aria-hidden="true"></span><span class="iris-panel-title">Ask Iris</span>'
  header.appendChild(brand)

  modelBadge = el('div', 'iris-model-badge', 'model')
  header.appendChild(modelBadge)

  const closeBtn = el('button', 'iris-panel-close')
  closeBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
  closeBtn.title = 'Hide panel'
  closeBtn.addEventListener('click', function () { setPanel(false) })
  header.appendChild(closeBtn)
  panelEl.appendChild(header)

  const composer = el('div', 'iris-composer')
  taskInput = document.createElement('textarea')
  taskInput.className = 'iris-task-input'
  taskInput.rows = 2
  taskInput.placeholder = 'Tell Iris what to do on this page…'
  taskInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submitTask()
    }
  })
  composer.appendChild(taskInput)

  runButton = el('button', 'iris-btn iris-btn-primary', 'Run')
  runButton.addEventListener('click', submitTask)
  composer.appendChild(runButton)
  panelEl.appendChild(composer)

  const controls = el('div', 'iris-controls')
  pauseButton = el('button', 'iris-btn iris-btn-ghost', 'Pause')
  pauseButton.disabled = true
  pauseButton.addEventListener('click', function () {
    if (lastStatus === 'paused') {
      ipc.send('iris-agent-resume')
    } else {
      ipc.send('iris-agent-pause')
    }
  })
  stopButton = el('button', 'iris-btn iris-btn-danger', 'Stop')
  stopButton.disabled = true
  stopButton.addEventListener('click', function () {
    ipc.send('iris-agent-stop')
  })
  controls.appendChild(pauseButton)
  controls.appendChild(stopButton)
  panelEl.appendChild(controls)

  timelineEl = el('div', 'iris-timeline has-thin-scrollbar')
  timelineEl.appendChild(emptyTimeline())
  panelEl.appendChild(timelineEl)

  statusEl = el('div', 'iris-status')
  statusEl.appendChild(el('span', 'iris-status-dot'))
  statusEl.appendChild(el('span', 'iris-status-text', 'Idle'))
  panelEl.appendChild(statusEl)

  const footer = el('div', 'iris-panel-footer')
  const settingsLink = el('button', 'iris-link', 'AI settings')
  settingsLink.addEventListener('click', function () {
    tabs.enterData('min://app/pages/settings/index.html#iris-ai', { focus: true })
  })
  footer.appendChild(settingsLink)
  const takeoverNote = el('span', 'iris-takeover-note', 'Click or type in the page to take over')
  footer.appendChild(takeoverNote)
  panelEl.appendChild(footer)

  document.body.appendChild(panelEl)

  openButton = document.createElement('button')
  openButton.id = 'iris-ask-button'
  openButton.className = 'iris-ask-button'
  openButton.title = 'Ask Iris  (⌘⇧Space)'
  openButton.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3z" fill="currentColor"/><path d="M18.5 15.5l.9 2.2 2.2.9-2.2.9-.9 2.2-.9-2.2-2.2-.9 2.2-.9.9-2.2z" fill="currentColor" opacity=".75"/></svg><span>Ask Iris</span>'
  openButton.addEventListener('click', togglePanel)
  document.getElementById('navbar').appendChild(openButton)
}

function emptyTimeline () {
  const empty = el('div', 'iris-empty')
  empty.innerHTML = '<div class="iris-empty-mark"></div><p>Iris watches the page like you do — screenshots only — and drives the mouse and keyboard. Nothing is filled in behind your back.</p>'
  return empty
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
  const activeTabId = tabs.getSelected()
  if (!activeTabId) return
  clearTimeline()
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

function clearTimeline () {
  timelineEl.innerHTML = ''
}

function setStatus (status, text) {
  lastStatus = status
  panelEl.dataset.status = status
  const label = {
    idle: 'Idle',
    running: 'Working…',
    paused: 'Paused',
    stopping: 'Stopping…',
    done: 'Done',
    failed: 'Stopped',
    stopped: 'Stopped'
  }[status] || status
  statusEl.querySelector('.iris-status-text').textContent = text || label
  pauseButton.disabled = status !== 'running' && status !== 'paused'
  pauseButton.textContent = status === 'paused' ? 'Resume' : 'Pause'
  stopButton.disabled = status !== 'running' && status !== 'paused'
  runButton.disabled = status === 'running'
  runButton.textContent = status === 'running' ? 'Running…' : 'Run'
}

function stepCard (payload) {
  const card = el('article', 'iris-step')
  const head = el('div', 'iris-step-head')
  head.appendChild(el('span', 'iris-step-num', String(payload.step)))
  head.appendChild(el('span', 'iris-step-desc', payload.description || (payload.action && payload.action.type) || 'Looking at the page'))
  card.appendChild(head)
  return card
}

function addObservation (payload) {
  lastObservation = payload
  removeEmpty()
  const card = stepCard(payload)
  card.classList.add('iris-step-obs')

  const frame = el('div', 'iris-shot')
  const img = document.createElement('img')
  img.src = payload.dataUrl
  img.alt = 'Screenshot of the page at step ' + payload.step
  img.dataset.w = payload.width
  img.dataset.h = payload.height
  frame.appendChild(img)
  if (payload.loading) {
    frame.appendChild(el('span', 'iris-shot-loading', 'loading'))
  }
  card.appendChild(frame)

  card.addEventListener('click', function () { card.classList.toggle('expanded') })
  timelineEl.appendChild(card)
  trimTimeline()
  timelineEl.scrollTop = timelineEl.scrollHeight
}

function addThought (payload) {
  const last = timelineEl.lastElementChild
  if (last && last.classList.contains('iris-step')) {
    const thought = el('p', 'iris-thought', payload.thought || '')
    last.appendChild(thought)
  }
}

function addAction (payload) {
  removeEmpty()
  const card = stepCard(payload)
  if (payload.automatic) card.classList.add('iris-step-auto')
  card.classList.add('iris-step-action')

  const kind = payload.action.type
  const chip = el('div', 'iris-chip iris-chip-' + kind, kind.replace(/_/g, ' '))
  card.appendChild(chip)

  if (payload.anchor && lastObservation) {
    card.appendChild(el('span', 'iris-coords', '→ ' + payload.anchor.x + ', ' + payload.anchor.y + ' css px'))

    // draw the landing point on the screenshot the model was shown a moment ago
    const shot = timelineEl.querySelector('.iris-step .iris-shot')
    if (shot) {
      const dot = el('span', 'iris-shot-dot')
      dot.style.left = (payload.anchor.x / lastObservation.viewWidth) * 100 + '%'
      dot.style.top = (payload.anchor.y / lastObservation.viewHeight) * 100 + '%'
      shot.appendChild(dot)
    }
  }

  if (payload.action.text) {
    card.appendChild(el('div', 'iris-detail', '“' + payload.action.text + '”'))
  }
  timelineEl.appendChild(card)
  trimTimeline()
  timelineEl.scrollTop = timelineEl.scrollHeight
}

function addResult (payload) {
  const last = timelineEl.lastElementChild
  if (!last) return
  if (payload.ok) {
    last.classList.add('iris-step-ok')
  } else {
    last.classList.add('iris-step-bad')
    last.appendChild(el('div', 'iris-error', payload.error || 'failed'))
  }
}

function addRejected (payload) {
  removeEmpty()
  const card = el('article', 'iris-step iris-step-rejected')
  card.appendChild(el('div', 'iris-step-head'))
  card.appendChild(el('div', 'iris-error', 'Rejected: ' + payload.error))
  timelineEl.appendChild(card)
  trimTimeline()
}

function removeEmpty () {
  const empty = timelineEl.querySelector('.iris-empty')
  if (empty) empty.remove()
}

function trimTimeline () {
  while (timelineEl.children.length > MAX_STEPS_SHOWN * 2) {
    timelineEl.removeChild(timelineEl.firstElementChild)
  }
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

function handleEvent (payload) {
  switch (payload.type) {
    case 'observation':
      addObservation(payload)
      setStatus('running')
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
      addRejected(payload)
      break
    case 'blocked':
      setStatus('paused', payload.reason)
      break
    case 'takeover':
      setStatus('paused', 'Paused — the page is yours again')
      break
    case 'pause':
      setStatus('paused')
      break
    case 'resume':
      setStatus('running')
      break
    case 'stop':
      setStatus('stopping')
      break
    case 'run:end':
      setStatus(payload.status, payload.answer || payload.reason)
      break
    case 'error':
      setStatus('running', 'Retrying: ' + payload.error)
      break
    default:
      break
  }
}

function refreshModelBadge () {
  const cfg = Object.assign({}, lastSettings || {}, settings.get('irisAI') || {})
  const name = cfg.model || 'no model set'
  modelBadge.textContent = name.length > 26 ? name.slice(0, 24) + '…' : name
  modelBadge.title = cfg.baseUrl || ''
}

function initialize () {
  buildPanel()

  ipc.on('iris-agent-event', function (e, payload) {
    handleEvent(payload)
  })

  ipc.on('iris-agent-control-reply', function (e, reply) {
    if (reply && reply.status) setStatus(reply.status)
  })

  ipc.on('iris-agent-start-reply', function (e, reply) {
    if (!reply.ok) {
      setStatus('failed', reply.error)
    }
  })

  ipc.on('iris-agent-settings', function () {
    refreshModelBadge()
  })

  ipc.on('iris-agent-status-reply', function (e, status) {
    if (status && status.settings) {
      lastSettings = status.settings
      refreshModelBadge()
    }
  })

  ipc.on('iris-agent-probe-reply', function (e, reply) {
    setStatus(reply.ok ? 'idle' : 'failed', reply.ok ? 'Model server reachable' : 'Model server: ' + reply.error)
  })

  ipc.send('iris-agent-status')

  settings.listen('irisAI', refreshModelBadge)

  window.addEventListener('keydown', function (e) {
    // Esc closes the panel when it has focus; pause is a button in the panel
    if (e.key === 'Escape' && panelOpen && document.activeElement && document.activeElement.closest && document.activeElement.closest('.iris-panel')) {
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
      require('navbar/tabEditor.js').hide()
      taskInput.value = 'Demo: click the middle of the page, scroll down, then stop'
      submitTask()
    }, 4500)
  }
}

module.exports = { initialize, togglePanel, openPanel: function () { setPanel(true) }, closePanel: function () { setPanel(false) } }
