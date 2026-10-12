'use strict'

/*
 * iris/agent/fakeModel.js
 *
 * A deterministic stand-in for a vision model. It replies with actions expressed relative
 * to the screenshot it was "shown" (via ctx.lastObservation), which lets the whole loop —
 * capture, parse, map, inject, marker — run for real without any network access.
 *
 * Used by the test suite, and by the browser when launched with IRIS_FAKE_MODEL=1 so the
 * end-to-end wiring can be demonstrated and screenshotted on a machine that has no model
 * server available.
 */

const { createHistory } = require('./history')

const DEFAULT_SCRIPT = [
  { thought: 'This tab has no page in it yet, so I will open one.', action: { type: 'navigate', url: 'https://example.com/' } },
  { thought: 'I will click near the middle of the page to focus it.', action: { type: 'click', fx: 0.5, fy: 0.42 } },
  { thought: 'Now I will scroll down to see more of the page.', action: { type: 'scroll', direction: 'down', amount: 3, fx: 0.5, fy: 0.5 } },
  { thought: 'This demo proves capture, mapping, injection and the marker overlay.', action: { type: 'done', answer: 'Demo finished: saw the page, clicked, scrolled and stopped.' } }
]

/**
 * @param {object} opts { script: [{thought, action}] where action fx/fy are image fractions }
 */
function createFakeModel (opts) {
  const cfg = opts || {}
  const script = cfg.script || DEFAULT_SCRIPT
  let index = 0

  return {
    name: 'fake-model',
    next (ctx) {
      const step = script[Math.min(index, script.length - 1)]
      index++
      const obs = ctx.lastObservation || {}
      const w = obs.width || 1000
      const h = obs.height || 700
      const action = Object.assign({}, step.action)

      if (action.fx !== undefined) action.x = Math.round(action.fx * w)
      if (action.fy !== undefined) action.y = Math.round(action.fy * h)
      delete action.fx
      delete action.fy

      return JSON.stringify({ thought: step.thought, action })
    },
    reset () {
      index = 0
    }
  }
}

module.exports = { createFakeModel, DEFAULT_SCRIPT }
