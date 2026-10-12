'use strict'

/*
 * iris/agent/agentLoop.js
 *
 * The observe → think → act → verify loop.
 *
 *   ┌──────────────────────────────────────────────────────────────────────┐
 *   │ 1. stop-gate: steps / wall clock / pause / takeover                  │
 *   │ 2. perceive: computer.screenshot()  (device px PNG + page state)     │
 *   │ 3. settle:   if the page is still loading, auto-`wait` (bounded)    │
 *   │ 4. think:    model.next(messages) with a per-step timeout           │
 *   │ 5. parse:    actionSchema.parseAction → strict action or correction │
 *   │ 6. map:      coordinateMapper maps image px → CSS px (Retina-safe)   │
 *   │ 7. gate:     safety.beforeAction (blocked urls, loops, takeover)    │
 *   │ 8. mark:     emit the marker position so the human sees where        │
 *   │ 9. act:      computer.act() → real mouse / key events                │
 *  10. verify:    record the outcome; terminal action ends the run        │
 *   └──────────────────────────────────────────────────────────────────────┘
 *
 * No Electron, no DOM, no network: `model` and `computer` are injected, so this file is
 * exercised end-to-end by the test suite with a scripted fake model.
 */

const { parseAction, describeAction, isTerminal } = require('./actionSchema')
const { createMapping, mapActionToView, actionAnchorCss } = require('./coordinateMapper')
const { createSafetyGate } = require('./safety')
const { createHistory } = require('./history')

const DEFAULTS = {
  maxAutoWaits: 4,
  settleDelayMs: 350,
  markerDwellMs: 120,
  maxModelMsPerStep: 90 * 1000,
  coordinateSpace: 'auto'
}

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * @param {object} opts
 * @param {{next: function}} opts.model          model.next({messages, step}) -> string|Promise
 * @param {object} opts.computer                 see file header
 * @param {function} [opts.onEvent]              onEvent(type, payload)
 * @param {object} [opts.safety]                 overrides for the safety gate
 * @param {function} [opts.delay]                injectable timer (tests run instantly)
 * @param {function} [opts.now]                  injectable clock
 */
function createAgent (opts) {
  if (!opts || !opts.model || typeof opts.model.next !== 'function') throw new TypeError('agent requires a model with next()')
  if (!opts.computer) throw new TypeError('agent requires a computer')

  const cfg = Object.assign({}, DEFAULTS, opts.config || {})
  const computer = opts.computer
  const model = opts.model
  const emit = typeof opts.onEvent === 'function' ? opts.onEvent : function () {}
  const log = typeof opts.log === 'function' ? opts.log : function () {}
  const delay = opts.delay || wait
  const now = opts.now || Date.now

  const safety = createSafetyGate(Object.assign({ now }, opts.safety || {}))
  const history = createHistory(opts.history || {})

  const state = {
    status: 'idle', // idle | running | paused | stopping | done | failed | stopped
    task: null,
    reason: null,
    answer: null,
    step: 0,
    pausedByUser: false,
    takeover: null
  }

  let pauseRequested = false
  let stopRequested = null
  let resumeDeferred = null

  function resolveResume () {
    if (resumeDeferred) {
      const d = resumeDeferred
      resumeDeferred = null
      d.resolve(!stopRequested)
    }
  }

  function setStatus (status, reason) {
    state.status = status
    if (reason !== undefined) state.reason = reason
    emit('status', { status, reason: reason === undefined ? state.reason : reason, step: state.step })
  }

  function callComputer (fn, args) {
    const r = fn.call(computer, args)
    return r && typeof r.then === 'function' ? r : Promise.resolve(r)
  }

  /** Block while paused; resolve false if the run was stopped while waiting. */
  function waitForResume () {
    if (stopRequested) return Promise.resolve(false)
    if (!pauseRequested) return Promise.resolve(true)
    setStatus('paused')
    emit('pause:waiting', { step: state.step })
    return new Promise(function (resolve) { resumeDeferred = { resolve } })
  }

  async function modelNext (messages, step, obs) {
    const timeoutMs = safety.config.maxModelMsPerStep || cfg.maxModelMsPerStep
    let timer = null
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('model did not respond within ' + timeoutMs + ' ms')), timeoutMs)
    })
    try {
      return await Promise.race([
        Promise.resolve(model.next({
          messages: messages,
          step: step,
          history: history.transcript(),
          lastObservation: {
            width: obs.width, height: obs.height,
            viewWidth: obs.viewWidth, viewHeight: obs.viewHeight,
            url: obs.url, loading: obs.loading
          }
        })),
        timeout
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  function finish (status, reason, answer) {
    if (status === 'done') state.answer = answer || null
    setStatus(status, reason)
    emit('run:end', {
      status,
      reason: reason || null,
      answer: answer || state.answer || null,
      steps: state.step,
      stats: safety.snapshot()
    })
    return { status, reason: reason || null, answer: answer || state.answer || null, steps: state.step, stats: safety.snapshot() }
  }

  async function screenshotSafe () {
    try {
      const obs = await callComputer(computer.screenshot)
      if (!obs || typeof obs !== 'object') throw new Error('screenshot() returned nothing')
      if (!obs.viewWidth && obs.width && obs.devicePixelRatio) {
        obs.viewWidth = obs.width / obs.devicePixelRatio
        obs.viewHeight = obs.height / obs.devicePixelRatio
      }
      if (!obs.viewWidth && obs.width) { obs.viewWidth = obs.width; obs.viewHeight = obs.height }
      if (!obs.devicePixelRatio) obs.devicePixelRatio = obs.width / obs.viewWidth
      return { ok: true, obs }
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) }
    }
  }

  async function run (task) {
    if (!task || typeof task !== 'string') throw new TypeError('run(task) requires a non-empty string')
    if (state.status === 'running') throw new Error('agent is already running')

    pauseRequested = false
    stopRequested = null
    state.task = task
    state.step = 0
    state.answer = null
    state.reason = null
    state.pausedByUser = false
    state.takeover = null
    history.start(task)
    setStatus('running', null)
    emit('run:start', { task })

    let autoWaits = 0
    let lastTakeoverCount = 0

    /* eslint-disable no_constant_condition */
    while (true) {
      // ---- 1. human controls + stop conditions -------------------------------
      if (stopRequested) return finish('stopped', stopRequested)
      if (pauseRequested && !(await waitForResume())) return finish('stopped', stopRequested)

      const stepGate = safety.beforeStep()
      if (!stepGate.allow) return finish('stopped', stepGate.reason)

      state.step = stepGate.step
      emit('step:start', { step: state.step, remaining: safety.config.maxSteps - state.step })

      // a real human touched the page → pause and tell the model why
      log('phase:readPageState')
      const pageState = await readPageState()
      log('phase:readPageState done')
      const takeoverCount = pageState.takeoverCount || 0
      if (takeoverCount > lastTakeoverCount) {
        lastTakeoverCount = takeoverCount
        state.pausedByUser = true
        state.takeover = pageState.takeover || null
        history.addTakeover(state.takeover)
        emit('takeover', { step: state.step, info: state.takeover })
        pauseRequested = true
        continue
      }

      // ---- 2. perceive -------------------------------------------------------
      log('phase:screenshot')
      const shot = await screenshotSafe()
      log('phase:screenshot done ok=' + shot.ok)
      if (!shot.ok) {
        safety.noteRetry('screenshot failed: ' + shot.error)
        emit('error', { step: state.step, where: 'screenshot', error: shot.error })
        if (stopRequested) return finish('stopped', stopRequested)
        await delay(cfg.settleDelayMs)
        continue
      }
      const obs = shot.obs
      emit('observation', {
        step: state.step,
        dataUrl: obs.dataUrl,
        url: obs.url,
        loading: !!obs.loading,
        width: obs.width,
        height: obs.height,
        viewWidth: obs.viewWidth,
        viewHeight: obs.viewHeight,
        devicePixelRatio: obs.devicePixelRatio
      })

      // ---- 3. settle: never act on a page that is still painting ------------
      if (obs.loading && autoWaits < cfg.maxAutoWaits) {
        autoWaits++
        const ms = Math.min(2500, 500 * autoWaits)
        emit('action', {
          step: state.step,
          action: { type: 'wait', ms },
          description: 'Waiting for the page to finish loading',
          automatic: true,
          anchor: null
        })
        history.addSystemNote('Waiting ' + ms + ' ms — the page was still loading.')
        await delay(ms)
        continue
      }
      if (!obs.loading) autoWaits = 0

      history.addObservation(obs)

      // ---- 4. think ----------------------------------------------------------
      let raw
      safety.beforeModelCall()
      try {
        raw = await modelNext(history.messages(), state.step, obs)
      } catch (err) {
        const gate = safety.noteRetry(err.message)
        emit('error', { step: state.step, where: 'model', error: err.message })
        if (!gate.allow) return finish('failed', gate.reason)
        await delay(cfg.settleDelayMs)
        continue
      }

      if (stopRequested) return finish('stopped', stopRequested)

      const text = typeof raw === 'string' ? raw : (raw && raw.content) || ''

      // ---- 5. parse ----------------------------------------------------------
      const parsed = parseAction(text, { imageWidth: obs.width, imageHeight: obs.height })
      if (!parsed.ok) {
        const gate = safety.noteRetry(parsed.error)
        emit('rejected', { step: state.step, error: parsed.error, raw: text })
        history.addCorrection(parsed.error)
        if (!gate.allow) return finish('failed', gate.reason)
        continue
      }

      safety.noteSuccess()
      history.addAssistant(text, parsed.thought, parsed.action)
      emit('thought', { step: state.step, thought: parsed.thought, action: parsed.action })

      // ---- terminal states ---------------------------------------------------
      if (isTerminal(parsed.action)) {
        if (parsed.action.type === 'done') return finish('done', null, parsed.action.answer)
        return finish('failed', parsed.action.reason || 'the model reported the task as impossible')
      }

      // ---- 6. map ------------------------------------------------------------
      let mapped
      try {
        const mapping = createMapping({
          imageWidth: obs.width,
          imageHeight: obs.height,
          viewWidth: obs.viewWidth,
          viewHeight: obs.viewHeight,
          devicePixelRatio: obs.devicePixelRatio
        })
        mapped = mapActionToView(parsed.action, mapping, { coordinateSpace: cfg.coordinateSpace })
        mapped.anchorCss = actionAnchorCss(parsed.action, mapping)
      } catch (err) {
        const gate = safety.noteRetry('coordinate mapping failed: ' + err.message)
        emit('error', { step: state.step, where: 'mapping', error: err.message })
        if (!gate.allow) return finish('failed', gate.reason)
        continue
      }

      // ---- 7. stop gate on the action itself ---------------------------------
      const actionGate = safety.beforeAction(mapped, { pausedByUser: pauseRequested, url: pageState.url })
      if (!actionGate.allow) {
        emit('blocked', { step: state.step, kind: actionGate.kind, reason: actionGate.reason, action: parsed.action })
        if (actionGate.kind === 'loop') {
          history.addSystemNote('You repeated an ineffective action. Waiting for the human to resume.')
          pauseRequested = true
          continue
        }
        if (actionGate.kind === 'takeover') { pauseRequested = true; continue }
        return finish('stopped', actionGate.reason)
      }

      // ---- 8. marker ----------------------------------------------------------
      emit('action', {
        step: state.step,
        action: parsed.action,
        actionView: mapped,
        anchor: mapped.anchorCss || null,
        description: describeAction(parsed.action),
        automatic: false
      })
      if (mapped.anchorCss && cfg.markerDwellMs > 0) await delay(cfg.markerDwellMs)

      if (stopRequested) return finish('stopped', stopRequested)

      // ---- 9. act -------------------------------------------------------------
      let result
      try {
        result = await callComputer(computer.act, mapped)
      } catch (err) {
        result = { ok: false, error: err && err.message ? err.message : String(err) }
      }

      if (!result || result.ok !== true) {
        const message = (result && result.error) || 'the page rejected the input'
        const gate = safety.noteRetry(message)
        emit('action:result', { step: state.step, ok: false, error: message })
        history.addFailure(message)
        if (!gate.allow) return finish('failed', gate.reason)
      } else {
        emit('action:result', { step: state.step, ok: true })
      }

      // ---- 10. verify / settle -------------------------------------------------
      if (cfg.settleDelayMs > 0) await delay(cfg.settleDelayMs)
      if (stopRequested) return finish('stopped', stopRequested)
      /* eslint-enable no_constant_condition */
    }
  }

  async function readPageState () {
    if (typeof computer.state !== 'function') return { pausedByUser: false }
    try {
      const s = await callComputer(computer.state)
      return s || { pausedByUser: false }
    } catch (err) {
      return { pausedByUser: false }
    }
  }

  return {
    run,
    pause (reason) {
      pauseRequested = true
      emit('pause', { reason: reason || 'user' })
      if (state.status === 'running') setStatus('paused', reason || 'user')
    },
    resume () {
      pauseRequested = false
      state.pausedByUser = false
      emit('resume', {})
      if (state.status === 'paused') setStatus('running')
      resolveResume()
    },
    stop (reason) {
      stopRequested = reason || 'stopped by user'
      pauseRequested = false
      emit('stop', { reason: stopRequested })
      if (state.status !== 'idle') setStatus('stopping', stopRequested)
      resolveResume()
    },
    status () {
      return {
        status: state.status,
        step: state.step,
        task: state.task,
        reason: state.reason,
        answer: state.answer,
        paused: pauseRequested,
        stats: safety.snapshot()
      }
    },
    transcript () {
      return history.transcript()
    },
    config: cfg
  }
}

module.exports = { createAgent, DEFAULTS }
