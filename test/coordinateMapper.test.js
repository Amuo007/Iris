'use strict'

const test = require('node:test')
const assert = require('node:assert')

const {
  createMapping,
  mapActionToView,
  mapCssPointToImage,
  actionAnchorCss,
  detectCoordinateSpace,
  fitDimensions
} = require('../iris/agent/coordinateMapper')

/* ---------- Retina / scale factors -------------------------------------- */

test('1x display maps 1:1', () => {
  const m = createMapping({ imageWidth: 1440, imageHeight: 900, viewWidth: 1440, viewHeight: 900, devicePixelRatio: 1 })
  const out = mapActionToView({ type: 'click', x: 500, y: 400 }, m)
  assert.strictEqual(out.x, 500)
  assert.strictEqual(out.y, 400)
})

test('Retina 2x halves screenshot coordinates', () => {
  const m = createMapping({ imageWidth: 2880, imageHeight: 1800, viewWidth: 1440, viewHeight: 900, devicePixelRatio: 2 })
  const out = mapActionToView({ type: 'click', x: 1000, y: 800 }, m)
  assert.strictEqual(out.x, 500)
  assert.strictEqual(out.y, 400)
  assert.strictEqual(out.coordinateSpace, 'screenshot')
})

test('Retina 3x maps exactly', () => {
  const m = createMapping({ imageWidth: 4320, imageHeight: 2700, viewWidth: 1440, viewHeight: 900, devicePixelRatio: 3 })
  const out = mapActionToView({ type: 'click', x: 1500, y: 900 }, m)
  assert.strictEqual(out.x, 500)
  assert.strictEqual(out.y, 300)
})

test('a downscaled screenshot maps correctly (independent scale)', () => {
  // 2x capture of a 1440x900 view, resized to 1024 wide before being sent to the model
  const m = createMapping({ imageWidth: 1024, imageHeight: 640, viewWidth: 1440, viewHeight: 900, devicePixelRatio: 2 })
  const out = mapActionToView({ type: 'click', x: 512, y: 320 }, m)
  assert.strictEqual(out.x, 720)
  assert.strictEqual(out.y, 450)
})

test('non-uniform aspect is scaled per axis, not uniformly', () => {
  const m = createMapping({ imageWidth: 1000, imageHeight: 500, viewWidth: 1234, viewHeight: 432 })
  const out = mapActionToView({ type: 'click', x: 500, y: 250 }, m)
  assert.strictEqual(out.x, Math.round(500 * 1.234))
  assert.strictEqual(out.y, Math.round(250 * 0.864))
})

test('origin and bottom-right corner land inside the view', () => {
  const m = createMapping({ imageWidth: 2880, imageHeight: 1800, viewWidth: 1440, viewHeight: 900, devicePixelRatio: 2 })
  const tl = mapActionToView({ type: 'click', x: 0, y: 0 }, m)
  assert.deepStrictEqual({ x: tl.x, y: tl.y }, { x: 0, y: 0 })
  const br = mapActionToView({ type: 'click', x: 2880, y: 1800 }, m)
  assert.strictEqual(br.x, 1439)
  assert.strictEqual(br.y, 899)
})

test('out-of-range coordinates are clamped, never sent outside the page', () => {
  const m = createMapping({ imageWidth: 2880, imageHeight: 1800, viewWidth: 1440, viewHeight: 900, devicePixelRatio: 2 })
  const out = mapActionToView({ type: 'click', x: 99999, y: -50 }, m)
  assert.strictEqual(out.x, 1439)
  assert.strictEqual(out.y, 0)
})

test('round-trip css -> image -> css is stable at 1x, 2x and 3x', () => {
  for (const dpr of [1, 2, 3]) {
    const m = createMapping({ imageWidth: 1440 * dpr, imageHeight: 900 * dpr, viewWidth: 1440, viewHeight: 900, devicePixelRatio: dpr })
    let mismatches = 0
    for (let x = 0; x < 1440; x += 7) {
      for (let y = 0; y < 900; y += 11) {
        const img = mapCssPointToImage({ x, y }, m)
        const back = mapActionToView({ type: 'click', x: img.x, y: img.y }, m)
        if (back.x !== x || back.y !== y) mismatches++
      }
    }
    assert.strictEqual(mismatches, 0, `round-trip failed at dpr=${dpr}`)
  }
})

test('drag endpoints map consistently', () => {
  const m = createMapping({ imageWidth: 2880, imageHeight: 1800, viewWidth: 1440, viewHeight: 900, devicePixelRatio: 2 })
  const out = mapActionToView({ type: 'drag', fromX: 200, fromY: 400, toX: 1000, toY: 1600 }, m)
  assert.deepStrictEqual([out.fromX, out.fromY, out.toX, out.toY], [100, 200, 500, 800])
})

test('scroll amount is not treated as a distance', () => {
  const m = createMapping({ imageWidth: 2880, imageHeight: 1800, viewWidth: 1440, viewHeight: 900, devicePixelRatio: 2 })
  const out = mapActionToView({ type: 'scroll', direction: 'down', amount: 5, x: 1440, y: 900 }, m)
  assert.strictEqual(out.amount, 5)
  assert.strictEqual(out.x, 720)
})

/* ---------- coordinate conventions -------------------------------------- */

test('normalized (0..1) coordinates are detected and scaled up', () => {
  const m = createMapping({ imageWidth: 2880, imageHeight: 1800, viewWidth: 1440, viewHeight: 900, devicePixelRatio: 2 })
  const out = mapActionToView({ type: 'click', x: 0.5, y: 0.25 }, m, { coordinateSpace: 'auto' })
  assert.strictEqual(out.coordinateSpace, 'normalized')
  assert.strictEqual(out.x, 720)
  assert.strictEqual(out.y, 225)
})

test('relative-1000 (Qwen-VL style) is opt-in and exact', () => {
  const m = createMapping({ imageWidth: 2880, imageHeight: 1800, viewWidth: 1440, viewHeight: 900, devicePixelRatio: 2 })
  const out = mapActionToView({ type: 'click', x: 500, y: 500 }, m, { coordinateSpace: 'relative-1000' })
  assert.strictEqual(out.coordinateSpace, 'relative-1000')
  assert.strictEqual(out.x, 720)
  assert.strictEqual(out.y, 450)
})

test('auto mode does not reinterpret absolute pixels as relative-1000', () => {
  const m = createMapping({ imageWidth: 2880, imageHeight: 1800, viewWidth: 1440, viewHeight: 900, devicePixelRatio: 2 })
  assert.strictEqual(detectCoordinateSpace([800, 600], m, 'auto'), 'screenshot')
})

/* ---------- misc ----------------------------------------------------------- */

test('actionAnchorCss returns where the marker goes', () => {
  const m = createMapping({ imageWidth: 2880, imageHeight: 1800, viewWidth: 1440, viewHeight: 900, devicePixelRatio: 2 })
  const a = { type: 'click', x: 1000, y: 800, coordinateSpace: 'screenshot' }
  assert.deepStrictEqual(actionAnchorCss(a, m), { x: 500, y: 400 })
  assert.strictEqual(actionAnchorCss({ type: 'type', text: 'x' }, m), null)
})

test('fitDimensions downscales the long edge only', () => {
  assert.deepStrictEqual(fitDimensions(2880, 1800, 1568), { width: 1568, height: 980 })
  assert.deepStrictEqual(fitDimensions(1200, 900, 1568), { width: 1200, height: 900 })
  assert.deepStrictEqual(fitDimensions(900, 1200, 1568), { width: 900, height: 1200 })
  assert.deepStrictEqual(fitDimensions(900, 3000, 1500), { width: 450, height: 1500 })
})

test('invalid geometry is rejected loudly', () => {
  assert.throws(() => createMapping({ imageWidth: 0, imageHeight: 100, viewWidth: 100, viewHeight: 100 }), /positive finite/)
  assert.throws(() => createMapping({ imageWidth: NaN, imageHeight: 100, viewWidth: 100, viewHeight: 100 }), /positive finite/)
  assert.throws(() => mapActionToView({ type: 'click', x: NaN, y: 1 }, createMapping({ imageWidth: 10, imageHeight: 10, viewWidth: 10, viewHeight: 10 })), /finite/)
})
