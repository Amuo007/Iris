'use strict'

const test = require('node:test')
const assert = require('node:assert')

const { planInputEvents, planDuration, keyCodeFor, modifiersFor } = require('../iris/agent/inputPlan')
const types = (plan) => plan.map(p => p.event.type)

test('click moves the pointer, presses and releases', () => {
  const plan = planInputEvents({ type: 'click', x: 120, y: 80, button: 'left' })
  assert.deepStrictEqual(types(plan), ['mouseMove', 'mouseDown', 'mouseUp'])
  assert.deepStrictEqual([plan[0].event.x, plan[0].event.y], [120, 80])
  assert.strictEqual(plan[1].event.button, 'left')
  assert.strictEqual(plan[1].event.clickCount, 1)
})

test('double click sends two presses with clickCount 1 then 2', () => {
  const plan = planInputEvents({ type: 'double_click', x: 5, y: 6 })
  assert.deepStrictEqual(types(plan), ['mouseMove', 'mouseDown', 'mouseUp', 'mouseDown', 'mouseUp'])
  assert.strictEqual(plan[1].event.clickCount, 1)
  assert.strictEqual(plan[3].event.clickCount, 2)
  assert.strictEqual(plan[4].event.clickCount, 2)
})

test('right click uses the right button', () => {
  const plan = planInputEvents({ type: 'right_click', x: 5, y: 6, button: 'right' })
  assert.strictEqual(plan[1].event.button, 'right')
  assert.strictEqual(plan[2].event.button, 'right')
})

test('drag interpolates between the endpoints and always releases at the end', () => {
  const plan = planInputEvents({ type: 'drag', fromX: 0, fromY: 0, toX: 100, toY: 50 }, { dragSteps: 10 })
  assert.strictEqual(types(plan)[0], 'mouseMove')
  assert.strictEqual(plan[1].event.type, 'mouseDown')
  assert.strictEqual(plan[plan.length - 1].event.type, 'mouseUp')
  assert.deepStrictEqual(
    { x: plan[plan.length - 1].event.x, y: plan[plan.length - 1].event.y },
    { x: 100, y: 50 }
  )
  // monotonic in x
  const xs = plan.filter(p => p.event.type === 'mouseMove').map(p => p.event.x)
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] >= xs[i - 1])
  assert.ok(xs.length >= 10)
})

test('scroll emits wheel events with the right sign', () => {
  const down = planInputEvents({ type: 'scroll', direction: 'down', amount: 3, x: 10, y: 20 })
  const wheels = down.filter(p => p.event.type === 'mouseWheel')
  assert.strictEqual(wheels.length, 3)
  // Chromium convention, verified live: negative deltaY scrolls the page down
  assert.ok(wheels.every(w => w.event.deltaY < 0))
  assert.ok(wheels.every(w => w.event.x === 10 && w.event.y === 20))

  const up = planInputEvents({ type: 'scroll', direction: 'up', amount: 2, x: 1, y: 2 })
  assert.ok(up.filter(p => p.event.type === 'mouseWheel').every(w => w.event.deltaY > 0))

  const left = planInputEvents({ type: 'scroll', direction: 'left', amount: 1, x: 1, y: 2 })
  assert.ok(left.filter(p => p.event.type === 'mouseWheel').every(w => w.event.deltaX > 0 && w.event.deltaY === 0))
})

test('typing emits one char event per character, in order', () => {
  const plan = planInputEvents({ type: 'type', text: 'Hi there!' })
  const chars = plan.filter(p => p.event.type === 'char').map(p => p.event.keyCode)
  assert.strictEqual(chars.join(''), 'Hi there!')
})

test('typing newlines and tabs emits key events', () => {
  const plan = planInputEvents({ type: 'type', text: 'a\nb\t' })
  const keyCodes = plan.filter(p => p.event.type === 'keyDown').map(p => p.event.keyCode)
  assert.deepStrictEqual(keyCodes, ['Return', 'Tab'])
})

test('typing is unicode safe (emoji survive)', () => {
  const plan = planInputEvents({ type: 'type', text: 'café \u{1F600}' })
  const text = plan.filter(p => p.event.type === 'char').map(p => p.event.keyCode).join('')
  assert.strictEqual(text, 'café \u{1F600}')
})

test('key presses come in down/up pairs with canonical key codes', () => {
  const plan = planInputEvents({ type: 'key', key: 'enter', modifiers: ['shift'] })
  assert.deepStrictEqual(types(plan), ['keyDown', 'keyUp'])
  assert.strictEqual(plan[0].event.keyCode, 'Return')
  assert.deepStrictEqual(plan[0].event.modifiers, ['shift'])
})

test('shortcuts map our modifier names to Electron spellings', () => {
  const plan = planInputEvents({ type: 'shortcut', keys: 'command+l', key: 'l', modifiers: ['command'] })
  assert.strictEqual(plan[0].event.keyCode, 'L')
  assert.deepStrictEqual(plan[0].event.modifiers, ['meta'])
})

test('keyCodeFor covers letters, digits, function and navigation keys', () => {
  assert.strictEqual(keyCodeFor('a'), 'A')
  assert.strictEqual(keyCodeFor('7'), '7')
  assert.strictEqual(keyCodeFor('f12'), 'F12')
  assert.strictEqual(keyCodeFor('PageUp'), 'PageUp')
  assert.strictEqual(keyCodeFor(''), null)
})

test('modifiersFor dedupes and maps aliases', () => {
  assert.deepStrictEqual(modifiersFor(['cmd', 'command', 'alt', 'option']), ['meta', 'alt'])
  assert.strictEqual(modifiersFor([]), undefined)
})

test('non-spatial actions produce no events', () => {
  assert.deepStrictEqual(planInputEvents({ type: 'wait', ms: 100 }), [])
  assert.deepStrictEqual(planInputEvents({ type: 'navigate', url: 'https://example.com' }), [])
  assert.deepStrictEqual(planInputEvents({ type: 'done' }), [])
})

test('unknown actions and bad input throw', () => {
  assert.throws(() => planInputEvents({ type: 'teleport' }), /unsupported action type/)
  assert.throws(() => planInputEvents({ type: 'scroll', direction: 'down' }), /anchor/)
  assert.throws(() => planInputEvents({ type: 'key', key: '\u{1F600}' }), /unknown key name/)
  assert.throws(() => planInputEvents(null), /required/)
})

test('planDuration sums the delays', () => {
  const plan = planInputEvents({ type: 'drag', fromX: 0, fromY: 0, toX: 10, toY: 10 }, { dragSteps: 4, betweenEventMs: 10 })
  assert.ok(planDuration(plan) > 0)
})

test('type with a target clicks, selects all (replacing the old text), types, then Enter', () => {
  const plan = planInputEvents({ type: 'type', text: 'hi', x: 10, y: 20, enter: true })
  assert.deepStrictEqual(plan.slice(0, 4).map(p => p.event ? p.event.type : p.command), ['mouseMove', 'mouseDown', 'mouseUp', 'selectAll'])
  const tail = plan.slice(-3).map(p => p.event)
  assert.deepStrictEqual(tail.map(e => e.type), ['keyDown', 'char', 'keyUp'])
  assert.strictEqual(tail[1].keyCode, '\r')
  assert.deepStrictEqual(plan.filter(p => p.event && p.event.type === 'char' && p.event.keyCode !== '\r').map(p => p.event.keyCode), ['h', 'i'])
})

test('Enter after typing waits for a dropdown\'s options to appear, in any field', () => {
  const pauseBeforeEnter = plan => plan[plan.findIndex(p => p.event && p.event.type === 'keyDown' && p.event.keyCode === 'Return') - 1].delayMs
  assert.ok(pauseBeforeEnter(planInputEvents({ type: 'type', text: 'Waterloo', x: 5, y: 5, clear: false, enter: true })) >= 1000)
  // a field that is replaced can be a searched dropdown too (a real Greenhouse School box)
  assert.ok(pauseBeforeEnter(planInputEvents({ type: 'type', text: 'University of Houston', x: 5, y: 5, enter: true })) >= 1000)
})

test('clear:false appends instead of replacing', () => {
  const plan = planInputEvents({ type: 'type', text: 'x', x: 1, y: 1, clear: false })
  assert.ok(!plan.some(p => p.command === 'selectAll'))
})

test('command+a and friends become Edit-menu commands', () => {
  assert.deepStrictEqual(planInputEvents({ type: 'key', key: 'a', modifiers: ['command'] }).map(p => p.command), ['selectAll'])
  assert.deepStrictEqual(planInputEvents({ type: 'key', key: 'v', modifiers: ['control'] }).map(p => p.command), ['paste'])
  assert.deepStrictEqual(planInputEvents({ type: 'shortcut', keys: 'cmd+shift+z' }).map(p => p.command), ['redo'])
  assert.strictEqual(planInputEvents({ type: 'key', key: 'a', modifiers: ['shift'] })[0].event.type, 'keyDown')
})

test('pressing enter also sends the char event forms need', () => {
  const plan = planInputEvents({ type: 'key', key: 'enter' })
  assert.deepStrictEqual(plan.map(p => p.event.type), ['keyDown', 'char', 'keyUp'])
})

test('the pointer glides from its last position before clicking', () => {
  const plan = planInputEvents({ type: 'click', x: 100, y: 100 }, { from: { x: 0, y: 0 } })
  const moves = plan.filter(p => p.event.type === 'mouseMove').map(p => [p.event.x, p.event.y])
  assert.ok(moves.length >= 4, 'several intermediate moves')
  assert.deepStrictEqual(moves[moves.length - 1], [100, 100])
  for (let i = 1; i < moves.length; i++) assert.ok(moves[i][0] >= moves[i - 1][0])
  assert.strictEqual(plan.filter(p => p.event.type === 'mouseDown').length, 1)
})

test('no glide without a known start, and none for scrolls', () => {
  assert.strictEqual(planInputEvents({ type: 'click', x: 5, y: 5 }).filter(p => p.event.type === 'mouseMove').length, 1)
  const scroll = planInputEvents({ type: 'scroll', direction: 'down', amount: 1, x: 50, y: 50 }, { from: { x: 0, y: 0 } })
  assert.strictEqual(scroll.filter(p => p.event.type === 'mouseMove').length, 1)
})

test('typed letters keep their case (passwords!)', () => {
  const plan = planInputEvents({ type: 'type', text: 'Tq7-blue-HARBOR@x.test' })
  assert.strictEqual(plan.filter(p => p.event.type === 'char').map(p => p.event.keyCode).join(''), 'Tq7-blue-HARBOR@x.test')
})
