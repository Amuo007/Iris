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
const prompts = require('./prompts')
const { parseLookups } = require('./lookup')

const DEFAULTS = {
  maxAutoWaits: 4,
  settleDelayMs: 350,
  markerDwellMs: 120,
  maxModelMsPerStep: 180 * 1000,
  maxCaptureFailures: 5,
  planThinking: 'medium', // the plan is one call: worth thinking about
  reviewEvery: 20, // with a plan, a check-in every N steps (Deep: every 15)
  planLookupsQuick: 3, // look-ups the Smart planner may make (Quick / Deep)
  planLookupsDeep: 8,
  runLookups: 6, // look-ups during a run (the lookup action); 0 turns the action off
  answerCheck: true, // one quick call removes details from the final answer that Iris never saw
  maxServerWaitMs: 10 * 60 * 1000, // 0 = wait for the model server forever (non-stop runs)
  askTimeoutMs: 0, // non-stop runs: if a question is not answered in time, carry on without it (0 = wait)
  noAsk: '', // set (to what to do instead): ask_user never pauses the run
  coordinateSpace: 'auto'
}

/* The model server is restarting, loading or briefly unreachable: wait, don't give up. */
const SERVER_DOWN = /cannot reach the model server|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed|responded 50[234]|not loaded|loading model|server is busy|terminated|other side closed|unresponsive|reset by the backend|reloaded automatically/i
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
  const lookupFn = typeof opts.lookup === 'function' ? opts.lookup : null

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
  let planActive = false
  let lastAnswer = ''
  let finishChecked = false
  let runLookups = 0
  let smartLevel = null
  let asking = false // paused on an ask_user question (may time out in a non-stop run)
  let strictNudgeAt = -100 // judgements counted when Iris was last told to be stricter

  /* a look-up never fails the run: an error comes back as text the model can read */
  async function runLookup (req) {
    try {
      const r = await lookupFn(req)
      return r && typeof r.text === 'string' ? r : { ok: false, text: 'Lookup returned nothing.', count: 0 }
    } catch (err) {
      return { ok: false, text: 'Lookup failed: ' + (err && err.message ? err.message : err), count: 0 }
    }
  }

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

  /**
   * Block while paused; resolve false if the run was stopped while waiting. With a timeout (a
   * question in a non-stop run), an unanswered pause ends by itself and onTimeout says so.
   */
  function waitForResume (timeoutMs, onTimeout) {
    if (stopRequested) return Promise.resolve(false)
    if (!pauseRequested) return Promise.resolve(true)
    setStatus('paused')
    emit('pause:waiting', { step: state.step, timeoutMs: timeoutMs || 0 })
    const pausedAt = now()
    return new Promise(function (resolve) {
      resumeDeferred = { resolve: function (v) { safety.creditPause(now() - pausedAt); resolve(v) } }
      const timedOutFor = resumeDeferred
      if (timeoutMs > 0) {
        delay(timeoutMs).then(function () {
          if (resumeDeferred && !stopRequested && timedOutFor === resumeDeferred) {
            if (onTimeout) onTimeout()
            pauseRequested = false
            emit('resume', { timedOut: true })
            setStatus('running')
            resolveResume()
          }
        })
      }
    })
  }

  /*
   * Auto thinking: think (low) where it pays — the first look, a new page, after a miss or an error,
   * when Iris has something to say about the page, or after 4 quick steps in a row — and answer
   * straight away on routine steps on the same page (scrolling on, filling the rest of a form).
   */
  let quickRun = 0
  let lastObsUrl = null
  function thinkingFor (obs, unchanged, lastActed, lastFailed) {
    if (cfg.thinking !== 'auto') return undefined
    const sameUrl = lastObsUrl !== null && obs.url === lastObsUrl
    lastObsUrl = obs.url || ''
    const routine = sameUrl && !unchanged && !lastFailed && !obs.note && !obs.firstOfTask && lastActed &&
      ['scroll', 'type', 'wait', 'zoom', 'find', 'upload', 'key'].indexOf(lastActed.type) !== -1
    if (routine && quickRun < 4) { quickRun++; return 'off' }
    quickRun = 0
    return 'low'
  }

  async function modelNext (messages, step, obs, thinking) {
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
          thinking: thinking,
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

    // ---- 0. Smart mode: questions → quick look-ups → a plan, before the first screenshot ----
    let planned = false
    planActive = false
    finishChecked = false
    runLookups = 0
    smartLevel = runOptions && runOptions.plan ? (runOptions.plan === 'deep' ? 'deep' : 'quick') : null
    if (runOptions && runOptions.plan) {
      emit('plan:start', { level: smartLevel })
      try {
        const extraRaw = typeof cfg.systemExtra === 'function' ? cfg.systemExtra() : cfg.systemExtra
        const extra = extraRaw && typeof extraRaw === 'object' ? [extraRaw.stable, extraRaw.live].filter(Boolean).join('\n\n') : extraRaw
        const current = history.plan() || (runOptions.projectPlan || null)
        let budget = lookupFn ? (smartLevel === 'deep' ? cfg.planLookupsDeep : cfg.planLookupsQuick) : 0
        let rounds = smartLevel === 'deep' ? 2 : 1
        let asked = !!current || !!runOptions.noQuestions
        let answers = ''
        let reply = null
        let text = ''
        const convo = [] // look-up requests and their results, in order
        for (let turn = 0; turn < 5; turn++) {
          const canLook = budget > 0 && rounds > 0
          const perRound = Math.min(budget, smartLevel === 'deep' ? 4 : 3)
          const messages = prompts.planMessages(task, extra, {
            allowQuestions: !asked,
            answers: answers || undefined,
            current,
            level: smartLevel,
            lookups: canLook ? { max: perRound } : null
          }).concat(convo)
          // Quick plans with light thinking; Deep (and "full" thinking users) think it through
          const thinking = smartLevel === 'quick' && cfg.planThinking === 'medium' ? 'low' : cfg.planThinking
          modelAbort = typeof AbortController === 'function' ? new AbortController() : null
          const planStarted = now()
          try {
            reply = await model.next({
              messages,
              step: 0,
              thinking,
              history: [],
              signal: modelAbort ? modelAbort.signal : undefined,
              onProgress: function (p) { emit('model:progress', Object.assign({ step: 0, planning: true, elapsedMs: now() - planStarted }, p, { reasoning: undefined })) }
            })
          } finally {
            modelAbort = null
          }
          if (stopRequested) return finish('stopped', stopRequested)
          text = String(typeof reply === 'string' ? reply : (reply && reply.content) || '').trim()

          const questions = !asked ? prompts.parseQuestions(text) : null
          if (questions) {
            // a short quiz before planning; the user answers in the panel (or skips)
            asked = true
            lastAnswer = ''
            emit('questions', { questions })
            pauseRequested = true
            if (!(await waitForResume(cfg.askTimeoutMs))) return finish('stopped', stopRequested)
            answers = lastAnswer || '(the user skipped the questions: use your best judgement)'
            continue
          }
          const wanted = canLook ? parseLookups(text, perRound) : null
          if (wanted) {
            rounds--
            budget -= wanted.length
            const results = []
            for (const req of wanted) {
              emit('lookup', { step: 0, kind: req.kind, query: req.query, planning: true })
              const r = await runLookup(req)
              results.push(r.text)
              emit('lookup:result', { step: 0, kind: req.kind, query: req.query, ok: r.ok, count: r.count, items: r.items, planning: true })
              if (stopRequested) return finish('stopped', stopRequested)
            }
            convo.push({ role: 'assistant', content: text })
            convo.push({ role: 'user', content: prompts.lookupResultsMessage(results, budget > 0 && rounds > 0) })
            continue
          }
          break
        }
        if (text && !prompts.parseQuestions(text) && !parseLookups(text)) {
          const said = answers && !/^\(the user skipped/.test(answers) ? answers : ''
          const full = (said ? text + '\nThe user said: ' + said.replace(/\n/g, '; ') : text).slice(0, 2600)
          history.setPlan(full)
          planned = true
          planActive = true
          emit('plan', { text: full, usage: reply && reply.usage, modelMs: reply && reply.ms, level: smartLevel })
        }
      } catch (err) {
        if (stopRequested) return finish('stopped', stopRequested)
        emit('error', { step: 0, where: 'plan', error: err.message })
      }
    } else if (history.plan()) {
      planned = true
      planActive = true
    }

    let autoWaits = 0
    let lastTakeoverCount = 0
    let captureFailures = 0
    let serverDownSince = 0
    let serverWaits = 0
    let compactions = 0
    let lastFingerprint = null
    let lastActed = null
    let lastFailed = false
    asking = false

    /* eslint-disable no_constant_condition */
    while (true) {
      // ---- 1. human controls + stop conditions -------------------------------
      if (stopRequested) return finish('stopped', stopRequested)
      if (pauseRequested && !(await waitForResume(asking ? cfg.askTimeoutMs : 0, function () {
        history.addSystemNote('The user did not answer within ' + Math.round(cfg.askTimeoutMs / 60000) + ' minutes and may be away. ' +
          'Carry on without it: skip whatever needs them (another site, another item) and continue the task.')
        emit('ask:timeout', { step: state.step })
      }))) return finish('stopped', stopRequested)
      asking = false
      if (pendingApproval) {
        // resumed after a sensitive-action pause: the human approved that action (or the payment)
        approvedKey = pendingApproval
        pendingApproval = null
        history.addSystemNote(approvedKey === 'payment' ? 'The user approved the payment. Go ahead and pay now.'
          : approvedKey === 'application' ? 'The user checked the application and approved it. Submit it now.' : 'The user approved it. Go ahead.')
      } else {
        approvedKey = null
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
      if (Array.isArray(obs.files)) obs.files.forEach(function (f) { history.addFile(f) })

      // did the last action visibly do anything? (cheap, pixel-level)
      const unchanged = !!(lastActed && obs.fingerprint && lastFingerprint && obs.fingerprint === lastFingerprint)
      if (unchanged && !obs.note) {
        obs.note = 'Your last action (' + describeAction(lastActed) + ') did not visibly change the page.' +
          (/click/.test(lastActed.type) ? ' If you aimed at a small button or link, you probably missed it: zoom in on it, or aim at its exact centre.' : '')
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

      const every = smartLevel === 'deep' ? Math.min(cfg.reviewEvery, 15) : cfg.reviewEvery
      if (planned && every > 0 && state.step > 1 && state.step % every === 0) {
        history.addSystemNote(prompts.reviewNote())
      }
      if (state.step === 1 && !followUp && !obs.emptyTab) obs.firstOfTask = true
      const left = safety.config.maxSteps > 0 ? safety.config.maxSteps - state.step + 1 : 0
      if (left > 0 && left <= 3) obs.note = (obs.note ? obs.note + '\n' : '') + prompts.finishReminder(left)
      history.addObservation(obs, state.step)

      // ---- 4. think ----------------------------------------------------------
      const stepThinking = thinkingFor(obs, unchanged, lastActed, lastFailed)
      let raw
      safety.beforeModelCall()
      emit('model:start', { step: state.step })
      try {
        const extra = typeof cfg.systemExtra === 'function' ? cfg.systemExtra() : cfg.systemExtra
        // { stable, live }: the stable part opens the prompt (cached), the live part goes last
        const split = extra && typeof extra === 'object' ? extra : { stable: extra, live: '' }
        raw = await modelNext(history.messages(split.stable || undefined, split.live || undefined), state.step, obs, stepThinking)
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
        lastFailed = true
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
      if (parsed.learn) emit('learn', { step: state.step, tip: parsed.learn, url: obs.url })
      const batch = parsed.actions && parsed.actions.length ? parsed.actions : [parsed.action]
      emit('thought', { step: state.step, thought: parsed.thought, action: parsed.action, actions: batch, reasoning, usage, modelMs })

      const mapping = createMapping({
        imageWidth: obs.width,
        imageHeight: obs.height,
        viewWidth: obs.viewWidth,
        viewHeight: obs.viewHeight,
        devicePixelRatio: obs.devicePixelRatio
      })

      pageState.thought = parsed.thought || ''
      let outcome = null
      lastFailed = false
      for (let i = 0; i < batch.length; i++) {
        outcome = await perform(batch[i], i, batch.length, mapping, obs, pageState, unchanged)
        if (outcome.finished) return outcome.finished
        if (outcome.failed) lastFailed = true
        if (outcome.stopBatch) break
      }
      lastActed = batch[batch.length - 1]

      if (stopRequested) return finish('stopped', stopRequested)
      /* eslint-enable no_constant_condition */
    }
  }

  /*
   * Before the answer is shown: a quick, thinking-free call checks it against what Iris noted and
   * saw, and takes out details that appear nowhere (an invented time, a guessed price).
   */
  async function checkAnswer (answer, obs) {
    // short tasks answer from the screen in front of them; long ones are where details get invented
    if (!cfg.answerCheck || !answer || answer.length < 60 || !/\d/.test(answer) || state.step < 5) return answer
    try {
      const entries = history.transcript()
      const evidence = entries.filter(function (e) { return e.thought || e.kind === 'note' || e.kind === 'followup' })
        .map(function (e) { return '- ' + (e.thought || e.text) }).join('\n')
      // what Iris itself typed into the page (a name, an email on a form) is known, not invented
      const typed = []
      entries.forEach(function (e) {
        if (e.kind !== 'assistant' || !/"type"\s*:\s*"type"/.test(e.raw || '')) return
        const p = parseAction(e.raw, { imageWidth: 100000, imageHeight: 100000 })
        ;((p.ok && p.actions) || []).forEach(function (a) { if (a.type === 'type' && a.text && !/\{\{/.test(a.text)) typed.push('- typed into the page: ' + a.text.slice(0, 200)) })
      })
      const notes = history.notes().map(function (n) { return '- note: ' + n }).join('\n')
      const digest = history.digest().join('\n')
      const text = [digest, notes, typed.slice(-40).join('\n'), evidence].filter(Boolean).join('\n').slice(-9000)
      emit('model:start', { step: state.step, checking: true })
      const reply = await model.next({
        messages: prompts.answerCheckMessages(state.task, answer, text, obs && obs.dataUrl),
        step: state.step,
        thinking: 'off',
        history: []
      })
      const fixed = prompts.parseAnswerCheck(typeof reply === 'string' ? reply : (reply && reply.content), answer)
      if (!fixed) return answer
      emit('answer:checked', { step: state.step, removed: fixed.removed })
      return fixed.answer
    } catch (err) {
      log('answer check failed: ' + (err && err.message))
      return answer
    }
  }

  /** Carry out one parsed action. Returns { finished } to end the run, { stopBatch } to re-look. */
  async function perform (action, index, total, mapping, obs, pageState, unchanged) {
    // ---- terminal states -----------------------------------------------------
    if (isTerminal(action)) {
      // a planned run must have looked at what it reports: send it back once if it judged nothing
      const stepsLeft = safety.config.maxSteps > 0 ? safety.config.maxSteps - state.step : Infinity
      if (action.type === 'done' && planActive && !finishChecked && stepsLeft > 2 && history.decisions().kept.length === 0 && history.decisions().skipped === 0) {
        finishChecked = true
        history.addSystemNote(prompts.finishCheckNote())
        emit('finish:check', { step: state.step })
        return { stopBatch: true }
      }
      if (action.type === 'done') return { finished: finish('done', null, await checkAnswer(action.answer || null, obs)) }
      return { finished: finish('failed', action.reason || 'the model reported the task as impossible') }
    }

    // ---- 6. map --------------------------------------------------------------
    let mapped
    try {
      mapped = mapActionToView(action, mapping, { coordinateSpace: cfg.coordinateSpace })
      mapped.anchorCss = actionAnchorCss(action, mapping)
      // what this step means to do, in the model's words (the computer aims differently at a checkbox)
      if (pageState.thought) mapped.intent = String(pageState.thought).slice(0, 300)
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
      approved: approvedKey,
      thought: pageState.thought || ''
    })
    if (approvedKey !== 'payment' && approvedKey !== 'application') approvedKey = null // these approvals cover the whole step
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

    // ---- a revised plan replaces the old one (kept through every compaction) --------
    if (action.type === 'update_plan') {
      history.setPlan(action.plan.slice(0, 2400))
      planActive = true
      emit('plan', { text: action.plan.slice(0, 2400), updated: true })
      return {}
    }

    // ---- a decision about a candidate: remembered, nothing happens on the page ------
    if (action.type === 'judge') {
      history.addVerdict(action.item, action.keep, pageState.url || obs.url)
      emit('verdict', { step: state.step, item: action.item, keep: action.keep, why: action.why || '' })
      // keeping nearly everything means the bar is too low: say so, once every 15 judgements
      const d = history.decisions()
      const judged = d.kept.length + d.skipped
      if (judged >= 10 && judged - strictNudgeAt >= 15 && d.kept.length / judged >= 0.85) {
        strictNudgeAt = judged
        history.addSystemNote(prompts.stricterNote(d.kept.length, judged))
        emit('remember', { step: state.step, note: 'Kept ' + d.kept.length + ' of ' + judged + ': raising the bar', automatic: true })
      }
      return {}
    }

    // ---- a quick look-up outside the browser: the results arrive as text --------------
    if (action.type === 'lookup') {
      emit('action', { step: state.step, index, total, action, actionView: mapped, anchor: null, description: describeAction(action), automatic: false })
      if (!lookupFn || cfg.runLookups <= 0) {
        history.addSystemNote('Look-ups are turned off. Use the browser.')
        return { stopBatch: true }
      }
      if (runLookups >= cfg.runLookups) {
        history.addSystemNote('You have used all ' + cfg.runLookups + ' look-ups for this task. Use the browser.')
        return { stopBatch: true }
      }
      runLookups++
      const req = { kind: action.kind || 'web', query: action.query }
      emit('lookup', { step: state.step, kind: req.kind, query: req.query })
      const r = await runLookup(req)
      emit('lookup:result', { step: state.step, kind: req.kind, query: req.query, ok: r.ok, count: r.count, items: r.items })
      history.addSystemNote(r.text + '\n(' + (cfg.runLookups - runLookups) + ' look-ups left for this task.)')
      return { stopBatch: true }
    }

    // ---- ask the human: pause until they answer (or just press Resume) ------------
    if (action.type === 'ask_user' && cfg.noAsk) {
      // a run the user left to Iris (job applications): no question waits on them — decide, or note it and go on
      history.addSystemNote('Do not ask the user in this run — they are away and want Iris to decide. ' + cfg.noAsk)
      return { stopBatch: true }
    }
    if (action.type === 'ask_user') {
      emit('action', { step: state.step, index, total, action, actionView: mapped, anchor: null, description: describeAction(action), automatic: false })
      emit('ask', { step: state.step, question: action.question, timeoutMs: cfg.askTimeoutMs || 0 })
      pauseRequested = true
      asking = true
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
      return { stopBatch: true, failed: true }
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
      const t = String(text || '').trim()
      lastAnswer = t
      if (t && state.step > 0) history.addSystemNote('The user says: ' + t)
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
