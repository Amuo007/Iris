'use strict'

/*
 * iris/agent/agentLoop.js
 *
 * The observe → think → act → verify loop.
 *
 *   ┌──────────────────────────────────────────────────────────────────────┐
 *   │ 1. stop-gate: steps / wall clock / pause / takeover                  │
 *   │ 2. perceive: computer.screenshot()  (device px image + page state)   │
 *   │    a capture failure is retried and never charged as a step          │
 *   │ 3. settle:   if the page is still loading, auto-`wait` (bounded)    │
 *   │ 4. think:    model.next(messages) — streamed, abortable, timed       │
 *   │ 5. parse:    actionSchema.parseAction → strict action or correction │
 *   │ 6. map:      coordinateMapper maps image px → CSS px (Retina-safe)   │
 *   │ 7. gate:     safety.beforeAction (blocked urls, loops, sensitive)   │
 *   │ 8. mark:     emit the marker position so the human sees where        │
 *   │ 9. act:      computer.act() → real mouse / key events                │
 *  10. settle:    computer.settle() waits for the page to react           │
 *   └──────────────────────────────────────────────────────────────────────┘
 *
 * No Electron, no DOM, no network: `model` and `computer` are injected, so this file is
 * exercised end-to-end by the test suite with a scripted fake model.
 */

const { parseAction, describeAction, isTerminal, PAGE_CHANGING } = require('./actionSchema')
const { createMapping, mapActionToView, actionAnchorCss } = require('./coordinateMapper')
const { createSafetyGate } = require('./safety')
const { createHistory } = require('./history')

const DEFAULTS = {
  maxAutoWaits: 4,
  settleDelayMs: 350,
  markerDwellMs: 120,
  maxModelMsPerStep: 180 * 1000,
  maxCaptureFailures: 5,
  maxServerWaitMs: 10 * 60 * 1000, // 0 = wait for the model server forever (non-stop runs)
  coordinateSpace: 'auto'
}

/* The model server is restarting, loading or briefly unreachable: wait, don't give up. */
const SERVER_DOWN = /cannot reach the model server|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed|responded 50[234]|not loaded|loading model|server is busy/i
const CONTEXT_FULL = /exceeds the available context size|context_length_exceeded|maximum context length|context window/i

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * @param {object} opts
 * @param {{next: function}} opts.model          model.next({messages, step, onProgress, signal})
 *                                               -> string | {content, reasoning, usage, ms}
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
  const history = createHistory(Object.assign({ maxSteps: safety.config.maxSteps }, opts.history || {}))

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
  let modelAbort = null
  let approvedKey = null
  let pendingApproval = null
  let takeoverAcknowledged = false

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
      timer = setTimeout(() => reject(new Error('the model did not answer within ' + Math.round(timeoutMs / 1000) + ' s')), timeoutMs)
    })
    modelAbort = typeof AbortController === 'function' ? new AbortController() : null
    const started = now()
    try {
      return await Promise.race([
        Promise.resolve(model.next({
          messages: messages,
          step: step,
          history: history.transcript(),
          signal: modelAbort ? modelAbort.signal : undefined,
          onProgress: function (p) {
            emit('model:progress', Object.assign({ step, elapsedMs: now() - started }, p, { reasoning: undefined }))
          },
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
      modelAbort = null
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

  async function settleAfter (action) {
    if (typeof computer.settle === 'function') {
      try {
        await callComputer(computer.settle, action)
      } catch (err) {
        log('settle failed: ' + (err && err.message))
      }
    } else if (cfg.settleDelayMs > 0) {
      await delay(cfg.settleDelayMs)
    }
  }

  async function run (task, runOptions) {
    if (!task || typeof task !== 'string') throw new TypeError('run(task) requires a non-empty string')
    if (state.status === 'running') throw new Error('agent is already running')
    const followUp = !!(runOptions && runOptions.followUp) && history.length() > 0

    pauseRequested = false
    stopRequested = null
    approvedKey = null
    pendingApproval = null
    state.task = task
    state.step = 0
    state.answer = null
    state.reason = null
    state.pausedByUser = false
    state.takeover = null
    if (followUp) {
      history.addFollowUp(task)
      safety.reset()
    } else {
      history.start(task)
    }
    setStatus('running', null)
    emit('run:start', { task, followUp, limits: safety.snapshot().limits })

    let autoWaits = 0
    let lastTakeoverCount = 0
    let captureFailures = 0
    let serverDownSince = 0
    let serverWaits = 0
    let compactions = 0
    let lastFingerprint = null
    let lastActed = null

    /* eslint-disable no_constant_condition */
    while (true) {
      // ---- 1. human controls + stop conditions -------------------------------
      if (stopRequested) return finish('stopped', stopRequested)
      if (pauseRequested && !(await waitForResume())) return finish('stopped', stopRequested)
      if (pendingApproval) {
        // resumed after a sensitive-action pause: the human approved that exact action
        approvedKey = pendingApproval
        pendingApproval = null
      }

      const stepGate = safety.beforeStep()
      if (!stepGate.allow) return finish('stopped', stepGate.reason)

      state.step = stepGate.step
      emit('step:start', { step: state.step, remaining: safety.config.maxSteps - state.step, elapsedMs: stepGate.elapsedMs })

      // a real human touched the page → pause and tell the model why
      const pageState = await readPageState()
      const takeoverCount = pageState.takeoverCount || 0
      if (takeoverCount > lastTakeoverCount) {
        lastTakeoverCount = takeoverCount
        state.takeover = pageState.takeover || null
        history.addTakeover(state.takeover)
        // already paused for this input and the human pressed Resume: carry on
        if (!takeoverAcknowledged) {
          state.pausedByUser = true
          emit('takeover', { step: state.step, info: state.takeover })
          pauseRequested = true
          safety.refundStep()
          continue
        }
      }
      takeoverAcknowledged = false

      // ---- 2. perceive -------------------------------------------------------
      log('phase:screenshot')
      const shot = await screenshotSafe()
      log('phase:screenshot done ok=' + shot.ok)
      if (!shot.ok) {
        // seeing is not a step: the model was never asked, so the budget is untouched
        safety.refundStep()
        captureFailures++
        emit('error', { step: state.step, where: 'screenshot', error: shot.error, attempt: captureFailures })
        if (captureFailures >= cfg.maxCaptureFailures) {
          return finish('failed', "Iris can't see this page: " + shot.error)
        }
        if (stopRequested) return finish('stopped', stopRequested)
        await delay(Math.max(cfg.settleDelayMs, 400 * captureFailures))
        continue
      }
      captureFailures = 0
      const obs = shot.obs
      if (Array.isArray(obs.memos)) {
        obs.memos.forEach(function (m) {
          history.addNote(m)
          emit('remember', { step: state.step, note: m, automatic: true })
        })
      }

      // did the last action visibly do anything? (cheap, pixel-level)
      const unchanged = !!(lastActed && obs.fingerprint && lastFingerprint && obs.fingerprint === lastFingerprint)
      if (unchanged && !obs.note) {
        obs.note = 'Your last action (' + describeAction(lastActed) + ') did not visibly change the page.'
      }
      if (obs.fingerprint) lastFingerprint = obs.fingerprint

      emit('observation', {
        step: state.step,
        dataUrl: obs.dataUrl,
        url: obs.url,
        title: obs.title,
        loading: !!obs.loading,
        blank: !!obs.blank,
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
        await delay(ms)
        continue
      }
      if (!obs.loading) autoWaits = 0

      history.addObservation(obs, state.step)

      // ---- 4. think ----------------------------------------------------------
      let raw
      safety.beforeModelCall()
      emit('model:start', { step: state.step })
      try {
        const extra = typeof cfg.systemExtra === 'function' ? cfg.systemExtra() : cfg.systemExtra
        raw = await modelNext(history.messages(extra || undefined), state.step, obs)
      } catch (err) {
        if (stopRequested) return finish('stopped', stopRequested)
        const message = err && err.message ? err.message : String(err)

        if (CONTEXT_FULL.test(message)) {
          safety.refundStep()
          compactions++
          if (compactions <= 2 && history.compact()) {
            emit('error', { step: state.step, where: 'context', error: 'The model ran out of room; forgetting the oldest steps.' })
            continue
          }
          return finish('failed', "The model server's context window is too small for Iris (" + message.slice(0, 140) + '). Load the model with a larger context, such as 32K or more.')
        }

        if (SERVER_DOWN.test(message)) {
          safety.refundStep()
          if (!serverDownSince) serverDownSince = now()
          serverWaits++
          if (cfg.maxServerWaitMs > 0 && now() - serverDownSince > cfg.maxServerWaitMs) {
            return finish('failed', 'The model server was unreachable for ' + Math.round((now() - serverDownSince) / 60000) + ' minutes: ' + message)
          }
          const waitMs = Math.min(30000, 2000 * Math.pow(2, Math.min(4, serverWaits - 1)))
          emit('error', { step: state.step, where: 'server', error: message, waitMs })
          await delay(waitMs)
          continue
        }

        const gate = safety.noteRetry(message)
        emit('error', { step: state.step, where: 'model', error: message })
        if (!gate.allow) return finish('failed', gate.reason)
        await delay(Math.max(cfg.settleDelayMs, 1000))
        continue
      }
      serverDownSince = 0
      serverWaits = 0
      compactions = 0

      if (stopRequested) return finish('stopped', stopRequested)

      const text = typeof raw === 'string' ? raw : (raw && raw.content) || ''
      const reasoning = raw && typeof raw === 'object' ? raw.reasoning || '' : ''
      const usage = raw && typeof raw === 'object' ? raw.usage || null : null
      const modelMs = raw && typeof raw === 'object' ? raw.ms || null : null

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
      history.addAssistant(text, parsed.thought, parsed.action, obs.url)
      if (parsed.remember) {
        history.addNote(parsed.remember)
        emit('remember', { step: state.step, note: parsed.remember })
      }
      const batch = parsed.actions && parsed.actions.length ? parsed.actions : [parsed.action]
      emit('thought', { step: state.step, thought: parsed.thought, action: parsed.action, actions: batch, reasoning, usage, modelMs })

      const mapping = createMapping({
        imageWidth: obs.width,
        imageHeight: obs.height,
        viewWidth: obs.viewWidth,
        viewHeight: obs.viewHeight,
        devicePixelRatio: obs.devicePixelRatio
      })

      let outcome = null
      for (let i = 0; i < batch.length; i++) {
        outcome = await perform(batch[i], i, batch.length, mapping, obs, pageState, unchanged)
        if (outcome.finished) return outcome.finished
        if (outcome.stopBatch) break
      }
      lastActed = batch[batch.length - 1]

      if (stopRequested) return finish('stopped', stopRequested)
      /* eslint-enable no_constant_condition */
    }
  }

  /** Carry out one parsed action. Returns { finished } to end the run, { stopBatch } to re-look. */
  async function perform (action, index, total, mapping, obs, pageState, unchanged) {
    // ---- terminal states -----------------------------------------------------
    if (isTerminal(action)) {
      if (action.type === 'done') return { finished: finish('done', null, action.answer || null) }
      return { finished: finish('failed', action.reason || 'the model reported the task as impossible') }
    }

    // ---- 6. map --------------------------------------------------------------
    let mapped
    try {
      mapped = mapActionToView(action, mapping, { coordinateSpace: cfg.coordinateSpace })
      mapped.anchorCss = actionAnchorCss(action, mapping)
      if (obs.crop) offsetForCrop(mapped, obs.crop)
    } catch (err) {
      const gate = safety.noteRetry('coordinate mapping failed: ' + err.message)
      emit('error', { step: state.step, where: 'mapping', error: err.message })
      if (!gate.allow) return { finished: finish('failed', gate.reason) }
      return { stopBatch: true }
    }

    // ---- 7. gate on the action itself -----------------------------------------
    const actionGate = safety.beforeAction(mapped, {
      pausedByUser: pauseRequested,
      url: pageState.url,
      pageUnchanged: unchanged && index === 0,
      approved: approvedKey
    })
    approvedKey = null
    if (!actionGate.allow) {
      emit('blocked', { step: state.step, kind: actionGate.kind, reason: actionGate.reason, action })
      if (actionGate.kind === 'loop') {
        // no pause: an autonomous run should get itself unstuck
        history.addSystemNote('You have repeated the same action several times and the page did not change. It does not work. Choose a completely different approach.')
        return { stopBatch: true }
      }
      if (actionGate.kind === 'confirmation') {
        pendingApproval = actionGate.key || null
        history.addSystemNote('The user must approve your next action before it runs.')
        pauseRequested = true
        return { stopBatch: true }
      }
      if (actionGate.kind === 'takeover') { pauseRequested = true; return { stopBatch: true } }
      return { finished: finish('stopped', actionGate.reason) }
    }

    // ---- ask the human: pause until they answer (or just press Resume) ------------
    if (action.type === 'ask_user') {
      emit('action', { step: state.step, index, total, action, actionView: mapped, anchor: null, description: describeAction(action), automatic: false })
      emit('ask', { step: state.step, question: action.question })
      pauseRequested = true
      return { stopBatch: true }
    }

    // ---- 8. marker -------------------------------------------------------------
    emit('action', {
      step: state.step,
      index,
      total,
      action,
      actionView: mapped,
      anchor: mapped.anchorCss || null,
      description: describeAction(action),
      automatic: false
    })
    if (mapped.anchorCss && cfg.markerDwellMs > 0) await delay(cfg.markerDwellMs)

    if (stopRequested) return { finished: finish('stopped', stopRequested) }

    // ---- 9. act ----------------------------------------------------------------
    let result
    try {
      result = await callComputer(computer.act, mapped)
    } catch (err) {
      result = { ok: false, error: err && err.message ? err.message : String(err) }
    }

    if (!result || result.ok !== true) {
      const message = (result && result.error) || 'the page rejected the input'
      const gate = safety.noteRetry(message)
      emit('action:result', { step: state.step, index, ok: false, error: message })
      history.addFailure(message)
      if (!gate.allow) return { finished: finish('failed', gate.reason) }
      return { stopBatch: true }
    }
    emit('action:result', { step: state.step, index, ok: true })

    // ---- 10. settle -------------------------------------------------------------
    await settleAfter(mapped)
    if (stopRequested) return { finished: finish('stopped', stopRequested) }
    if (PAGE_CHANGING.has(action.type) || (result && result.pageChanged)) return { stopBatch: true }
    return {}
  }

  /* A close-up screenshot covers only part of the view: shift its points back into the page. */
  function offsetForCrop (mapped, crop) {
    ['x', 'fromX', 'toX'].forEach(function (k) { if (typeof mapped[k] === 'number') mapped[k] = Math.round(mapped[k] + crop.x) })
    ;['y', 'fromY', 'toY'].forEach(function (k) { if (typeof mapped[k] === 'number') mapped[k] = Math.round(mapped[k] + crop.y) })
    if (mapped.anchorCss) mapped.anchorCss = { x: Math.round(mapped.anchorCss.x + crop.x), y: Math.round(mapped.anchorCss.y + crop.y) }
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
    /** The human answered an ask_user question (or added an instruction while paused). */
    answer (text) {
      if (text && String(text).trim()) history.addSystemNote('The user says: ' + String(text).trim())
      this.resume()
    },
    resume () {
      pauseRequested = false
      state.pausedByUser = false
      takeoverAcknowledged = true
      emit('resume', {})
      if (state.status === 'paused') setStatus('running')
      resolveResume()
    },
    stop (reason) {
      stopRequested = reason || 'stopped by user'
      pauseRequested = false
      emit('stop', { reason: stopRequested })
      if (state.status !== 'idle') setStatus('stopping', stopRequested)
      if (modelAbort) {
        try { modelAbort.abort() } catch (e) { /* already done */ }
      }
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
    exportHistory () {
      return history.export()
    },
    importHistory (data) {
      history.import(data)
    },
    notes () {
      return history.notes()
    },
    config: cfg
  }
}

module.exports = { createAgent, DEFAULTS }
