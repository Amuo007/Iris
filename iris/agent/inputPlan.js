'use strict'

/*
 * iris/agent/inputPlan.js
 *
 * Turns a validated, view-space action into the exact list of native input events that the
 * Electron side will hand to webContents.sendInputEvent().
 *
 * Living here (rather than in the Electron layer) keeps the whole input behaviour — click
 * sequences, double-click clickCounts, drag interpolation, wheel deltas, key codes and
 * modifier spelling — unit-testable without a browser.
 *
 * Pure.
 */

/* Names the model uses → Chromium/KeyboardEvent-style keyCodes accepted by Electron. */
var KEY_CODES = {
  enter: 'Return',
  return: 'Return',
  escape: 'Escape',
  esc: 'Escape',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  space: 'Space',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End',
  comma: 'Comma',
  period: 'Period',
  slash: 'Slash',
  semicolon: 'Semicolon',
  quote: 'Quote',
  equal: 'Equal',
  minus: 'Minus',
  backslash: 'Backslash',
  bracketsquareleft: 'OpenBracket',
  bracketsquareright: 'CloseBracket'
}

/* Our canonical modifier names → the spellings Electron accepts. */
var MODIFIER_SPELLING = {
  command: 'meta',
  cmd: 'meta',
  meta: 'meta',
  control: 'control',
  ctrl: 'control',
  shift: 'shift',
  option: 'alt',
  alt: 'alt'
}

function keyCodeFor (key) {
  if (typeof key !== 'string' || !key) return null
  const lower = key.toLowerCase()
  if (KEY_CODES[lower]) return KEY_CODES[lower]
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return 'F' + lower.slice(1)
  if (/^[a-z]$/.test(lower)) return lower.toUpperCase()
  if (/^[0-9]$/.test(key)) return key
  if (key.length === 1) return key.toUpperCase()
  return null
}

function isWhitespaceChar (c) {
  return c === '\n' || c === '\r' || c === '\t'
}

function modifiersFor (modifiers) {
  if (!modifiers || !modifiers.length) return undefined
  const out = []
  for (const m of modifiers) {
    const s = MODIFIER_SPELLING[String(m).toLowerCase()]
    if (s && !out.includes(s)) out.push(s)
  }
  return out.length ? out : undefined
}

function mouseMove (x, y, clickCount) {
  return { type: 'mouseMove', x, y, movementX: 0, movementY: 0, clickCount: clickCount || 0 }
}

function mouseDown (x, y, button, clickCount) {
  return { type: 'mouseDown', x, y, button: button || 'left', clickCount: clickCount || 1 }
}

function mouseUp (x, y, button, clickCount) {
  return { type: 'mouseUp', x, y, button: button || 'left', clickCount: clickCount || 1 }
}

/*
 * Enter needs a `char` event between keyDown and keyUp: Chromium's implicit form
 * submission (search boxes!) listens for the keypress, which a bare keyDown never produces.
 */
function enterEvents (add, firstDelay) {
  add({ type: 'keyDown', keyCode: 'Return' }, firstDelay)
  add({ type: 'char', keyCode: '\r', text: '\r', unmodifiedText: '\r' })
  add({ type: 'keyUp', keyCode: 'Return' }, 40)
}

/**
 * @param {object} action mapped (view-space) action
 * @param {object} [opts] { dragSteps, wheelStepPx, betweenEventMs }
 * @returns {Array<{event: object, delayMs: number}>} in order
 */
function planInputEvents (action, opts) {
  if (!action || typeof action !== 'object') throw new TypeError('inputPlan: action is required')
  const cfg = Object.assign({ dragSteps: 12, wheelStepPx: 120, betweenEventMs: 12 }, opts || {})
  const out = []
  const add = (event, delayMs) => out.push({ event, delayMs: delayMs === undefined ? cfg.betweenEventMs : delayMs })

  switch (action.type) {
    case 'move':
      add(mouseMove(action.x, action.y))
      break

    case 'click':
    case 'left_click':
      // real pointers move before they press: many pages need mouseover first
      add(mouseMove(action.x, action.y))
      add(mouseDown(action.x, action.y, action.button))
      add(mouseUp(action.x, action.y, action.button), 60)
      break

    case 'double_click':
      add(mouseMove(action.x, action.y))
      add(mouseDown(action.x, action.y, action.button, 1))
      add(mouseUp(action.x, action.y, action.button, 1), 40)
      add(mouseDown(action.x, action.y, action.button, 2), 40)
      add(mouseUp(action.x, action.y, action.button, 2), 80)
      break

    case 'right_click':
      add(mouseMove(action.x, action.y))
      add(mouseDown(action.x, action.y, 'right'))
      add(mouseUp(action.x, action.y, 'right'), 80)
      break

    case 'drag': {
      const steps = Math.max(2, Math.min(40, cfg.dragSteps))
      add(mouseMove(action.fromX, action.fromY), 30)
      add(mouseDown(action.fromX, action.fromY, 'left'), 60)
      for (let i = 1; i <= steps; i++) {
        const t = i / steps
        add(mouseMove(
          Math.round(action.fromX + (action.toX - action.fromX) * t),
          Math.round(action.fromY + (action.toY - action.fromY) * t),
          1
        ), 10)
      }
      add(mouseUp(action.toX, action.toY, 'left', 1), 60)
      break
    }

    case 'scroll': {
      const x = action.x
      const y = action.y
      if (x === undefined || y === undefined) throw new Error('scroll needs an anchor point')
      const ticks = Math.max(1, action.amount || 3)
      const magnitude = ticks * cfg.wheelStepPx
      add(mouseMove(x, y), 0)
      for (let i = 0; i < ticks; i++) {
        const event = { type: 'mouseWheel', x, y, deltaX: 0, deltaY: 0, wheelTicksX: 0, wheelTicksY: 0, hasPreciseScrollingDeltas: false }
        if (action.direction === 'down') event.deltaY = cfg.wheelStepPx
        else if (action.direction === 'up') event.deltaY = -cfg.wheelStepPx
        else if (action.direction === 'right') event.deltaX = cfg.wheelStepPx
        else event.deltaX = -cfg.wheelStepPx
        if (i === ticks - 1) event.wheelTicksY = event.deltaY > 0 ? 1 : (event.deltaY < 0 ? -1 : 0)
        add(event, 30)
      }
      if (magnitude > 4800) throw new Error('scroll amount too large')
      break
    }

    case 'type': {
      if (typeof action.text !== 'string') throw new Error('type requires text')
      const mods = modifiersFor(action.modifiers)
      if (action.x !== undefined && action.y !== undefined) {
        // focus the field first; three clicks select whatever is already in it
        add(mouseMove(action.x, action.y))
        const clicks = action.clear ? 3 : 1
        for (let c = 1; c <= clicks; c++) {
          add(mouseDown(action.x, action.y, 'left', c), 20)
          add(mouseUp(action.x, action.y, 'left', c), c === clicks ? 120 : 30)
        }
      } else if (action.clear) {
        add({ type: 'keyDown', keyCode: 'A', modifiers: ['meta'] })
        add({ type: 'keyUp', keyCode: 'A', modifiers: ['meta'] }, 40)
      }
      for (const ch of action.text) {
        if (isWhitespaceChar(ch)) {
          if (ch === '\t') {
            add({ type: 'keyDown', keyCode: 'Tab' })
            add({ type: 'keyUp', keyCode: 'Tab' }, 20)
          } else {
            enterEvents(add)
          }
        } else {
          // `char` is what actually inserts text into a focused field. Non-ASCII and
          // astral-plane characters (emoji, CJK, accents) have no named keyCode, so the
          // character itself is used as the keyCode.
          const code = keyCodeFor(ch) || ch
          add(Object.assign({ type: 'char', keyCode: code, text: ch, unmodifiedText: ch.toLowerCase() }, mods ? { modifiers: mods } : {}), 8)
        }
      }
      if (action.enter) enterEvents(add, 60)
      break
    }

    case 'key': {
      const code = keyCodeFor(action.key)
      if (!code) throw new Error('unknown key name: ' + action.key)
      const mods = modifiersFor(action.modifiers)
      if (code === 'Return' && !mods) {
        enterEvents(add)
        break
      }
      add(Object.assign({ type: 'keyDown', keyCode: code }, mods ? { modifiers: mods } : {}))
      add(Object.assign({ type: 'keyUp', keyCode: code }, mods ? { modifiers: mods } : {}), 40)
      break
    }

    case 'shortcut': {
      const parts = String(action.keys || '').split('+')
      const main = keyCodeFor(parts[parts.length - 1])
      if (!main) throw new Error('shortcut has no usable key: ' + action.keys)
      const mods = modifiersFor(parts.slice(0, -1))
      add(Object.assign({ type: 'keyDown', keyCode: main }, mods ? { modifiers: mods } : {}))
      add(Object.assign({ type: 'keyUp', keyCode: main }, mods ? { modifiers: mods } : {}), 60)
      break
    }

    case 'wait':
    case 'back':
    case 'navigate':
    case 'done':
    case 'fail':
      break

    default:
      throw new Error('inputPlan: unsupported action type "' + action.type + '"')
  }

  return out
}

/** Rough duration of an action in ms, used by the UI progress bar. */
function planDuration (plan) {
  return plan.reduce((sum, e) => sum + (e.delayMs || 0), 0)
}

module.exports = { planInputEvents, planDuration, keyCodeFor, modifiersFor, KEY_CODES }
