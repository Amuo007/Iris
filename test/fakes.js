'use strict'

/*
 * Test doubles. NOTHING here touches the network — the real model server is never called
 * from tests (see README: the developer's local server is the one pi itself runs on).
 */

/** A model that replays a scripted list of raw assistant messages. */
class FakeModel {
  /**
   * @param {Array<string|function>} replies strings, or (ctx) => string. `null` means "throw".
   */
  constructor (replies = []) {
    this.replies = replies
    this.calls = []
    this.index = 0
  }

  next (ctx) {
    this.calls.push({
      step: ctx.step,
      messageCount: ctx.messages.length,
      images: ctx.messages.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter(p => p.type === 'image_url').length : 0), 0),
      lastUser: typeof ctx.messages[ctx.messages.length - 1]?.content === 'string'
        ? ctx.messages[ctx.messages.length - 1].content
        : (ctx.messages[ctx.messages.length - 1]?.content?.find(p => p.type === 'text')?.text ?? '')
    })
    const reply = this.replies[this.index]
    if (this.index < this.replies.length) this.index++
    if (typeof reply === 'function') return reply(ctx)
    if (reply === undefined) return JSON.stringify({ thought: 'nothing left scripted', action: { type: 'fail', reason: 'fake model queue exhausted' } })
    if (reply === null) throw new Error('fake model network error')
    return reply
  }

  get callCount () {
    return this.calls.length
  }
}

/**
 * A stand-in for the browser: records injected actions, fakes page loading, and hands back
 * synthetic "screenshots" at whatever geometry the test needs (Retina, downscaled, etc).
 */
class FakeComputer {
  constructor (options = {}) {
    this.width = options.width || 2880
    this.height = options.height || 1800
    this.devicePixelRatio = options.devicePixelRatio || 2
    this.viewWidth = options.viewWidth || (this.width / this.devicePixelRatio)
    this.viewHeight = options.viewHeight || (this.height / this.devicePixelRatio)
    this.url = options.url || 'https://example.com/'
    this.loadingSchedule = options.loadingSchedule || [] // array of bools, one per screenshot
    this.actResults = options.actResults || [] // array of {ok,error} or Error
    this.actions = []
    this.screenshots = 0
    this.pausedByUser = false
    this.takeover = null
    this.takeoverCount = 0
    this.failScreenshotTimes = options.failScreenshotTimes || 0
  }

  screenshot () {
    this.screenshots++
    if (this.failScreenshotTimes > 0) {
      this.failScreenshotTimes--
      throw new Error('capture unavailable')
    }
    const loading = this.loadingSchedule.length ? !!this.loadingSchedule[Math.min(this.screenshots - 1, this.loadingSchedule.length - 1)] : false
    return {
      dataUrl: 'data:image/png;base64,' + 'A'.repeat(24) + '#' + this.screenshots,
      width: this.width,
      height: this.height,
      viewWidth: this.viewWidth,
      viewHeight: this.viewHeight,
      devicePixelRatio: this.devicePixelRatio,
      url: this.url,
      loading
    }
  }

  act (action) {
    this.actions.push(action)
    const result = this.actResults.length ? this.actResults[Math.min(this.actions.length - 1, this.actResults.length - 1)] : { ok: true }
    if (result instanceof Error) return Promise.reject(result)
    return Promise.resolve(result)
  }

  state () {
    return {
      pausedByUser: this.pausedByUser,
      takeover: this.takeover,
      takeoverCount: this.takeoverCount,
      url: this.url,
      loading: false
    }
  }

  /** Simulate the human grabbing the mouse. */
  userInteracts (kind, at) {
    this.pausedByUser = true
    this.takeover = { kind: kind || 'click', at: at || { x: 10, y: 10 } }
    this.takeoverCount++
  }
}

/** Zero-delay clock + timer so the loop runs instantly in tests. */
function virtualClock () {
  let t = 0
  return {
    now: () => t,
    delay: (ms) => { t += ms || 0; return Promise.resolve() },
    advance: (ms) => { t += ms }
  }
}

const json = (thought, action) => JSON.stringify({ thought, action })

module.exports = { FakeModel, FakeComputer, virtualClock, json }
