'use strict'

/*
 * iris/agent/coordinateMapper.js
 *
 * The single place where "pixels the model saw" become "coordinates the page receives".
 *
 * There are three rectangles in play and they are all different on a Retina display:
 *
 *   1. image     — the PNG the model was shown. `capturePage()` returns *device* pixels,
 *                  so on a 2x display a 1440x900 view yields 2880x1800. We may also
 *                  downscale that PNG before sending it to the model (cost/latency), which
 *                  makes the image size a *fourth* value; that is why image and view sizes
 *                  are carried independently and never assumed to be 1:1 or 1:2.
 *   2. view      — the target WebContentsView's bounds in CSS pixels (what
 *                  sendInputEvent() expects).
 *   3. visual    — optional: the on-screen marker overlay lives in the browser UI window,
 *                  which is the same coordinate space as the view bounds.
 *
 * Rules enforced here:
 *   - mapping is an exact affine scale per axis (no rounding until the very last step)
 *   - the final CSS coordinate is clamped into the view so a hallucinated off-screen
 *     point cannot make the injector aim outside the page
 *   - round( css ⇄ image ) is stable for the vast majority of points (asserted in tests)
 *
 * This module is pure: no Electron, no DOM.
 */

const SPACES = ['screenshot', 'normalized', 'relative-1000']

function assertPositiveFinite (n, name) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
    throw new TypeError(`coordinate mapping: ${name} must be a positive finite number, got ${JSON.stringify(n)}`)
  }
}

/**
 * @param {object} geom
 * @param {number} geom.imageWidth   width in px of the image handed to the model
 * @param {number} geom.imageHeight  height in px of that image
 * @param {number} geom.viewWidth    CSS px width of the target view
 * @param {number} geom.viewHeight   CSS px height of the target view
 */
function createMapping (geom) {
  assertPositiveFinite(geom.imageWidth, 'imageWidth')
  assertPositiveFinite(geom.imageHeight, 'imageHeight')
  assertPositiveFinite(geom.viewWidth, 'viewWidth')
  assertPositiveFinite(geom.viewHeight, 'viewHeight')

  return {
    imageWidth: geom.imageWidth,
    imageHeight: geom.imageHeight,
    viewWidth: geom.viewWidth,
    viewHeight: geom.viewHeight,
    scaleX: geom.viewWidth / geom.imageWidth,
    scaleY: geom.viewHeight / geom.imageHeight,
    devicePixelRatio: geom.devicePixelRatio || (geom.imageWidth / geom.viewWidth)
  }
}

/**
 * Detect a non-absolute coordinate convention used by the model for a whole action.
 *
 * 'normalized'   : every coordinate lies in [0,1]  -> fraction of the image
 * 'relative-1000': every coordinate lies in [0,1000] and the image is wider/taller than
 *                  1000 px -> the Qwen-VL "relative coordinates" convention. Only enabled
 *                  when explicitly requested, because it is ambiguous with absolute pixels.
 */
function detectCoordinateSpace (coords, mapping, mode) {
  if (!coords.length) return 'screenshot'
  const values = coords.filter(c => c !== undefined && c !== null)
  if (!values.length) return 'screenshot'

  if (mode === 'relative-1000') return 'relative-1000'
  if (mode === 'normalized') return 'normalized'

  // auto
  const allUnit = values.every(v => v >= 0 && v <= 1)
  if (allUnit) return 'normalized'
  return 'screenshot'
}

const COORD_FIELDS = ['x', 'y', 'fromX', 'fromY', 'toX', 'toY']

/**
 * Convert one image-space number to CSS px for its axis.
 * `kind` is 'x' or 'y'; `space` is the convention the model used.
 */
function imageToCssValue (value, space, mapping, kind) {
  if (!Number.isFinite(value)) throw new TypeError('coordinate is not finite')
  let px
  if (space === 'normalized') {
    px = value * (kind === 'x' ? mapping.imageWidth : mapping.imageHeight)
  } else if (space === 'relative-1000') {
    px = (value / 1000) * (kind === 'x' ? mapping.imageWidth : mapping.imageHeight)
  } else {
    px = value
  }
  const css = px * (kind === 'x' ? mapping.scaleX : mapping.scaleY)
  const max = kind === 'x' ? mapping.viewWidth - 1 : mapping.viewHeight - 1
  return Math.min(max, Math.max(0, Math.round(css)))
}

function cssToImageValue (value, mapping, kind) {
  const px = value * (kind === 'x' ? (1 / mapping.scaleX) : (1 / mapping.scaleY))
  return Math.round(px)
}

/** Collect every coordinate present on an action. */
function actionCoords (action) {
  return COORD_FIELDS.map(f => action[f]).filter(v => typeof v === 'number' && Number.isFinite(v))
}

/**
 * Map a parsed action from image space to CSS/view space.
 * Returns a NEW action; the original is untouched.
 *
 * @param {object} action validated action from actionSchema
 * @param {object} mapping from createMapping()
 * @param {object} [opts] { coordinateSpace: 'auto'|'normalized'|'relative-1000' }
 */
function mapActionToView (action, mapping, opts) {
  if (!action || typeof action !== 'object') throw new TypeError('action is required')
  const space = detectCoordinateSpace(actionCoords(action), mapping, (opts && opts.coordinateSpace) || 'auto')

  const out = Object.assign({}, action)
  const isKind = f => (f === 'x' || f === 'fromX' || f === 'toX') ? 'x' : 'y'

  for (const f of COORD_FIELDS) {
    if (typeof out[f] === 'number') {
      out[f] = imageToCssValue(out[f], space, mapping, isKind(f))
    }
  }

  // scroll amount is in "wheel ticks", not pixels: leave it alone.
  out.coordinateSpace = space
  return out
}

/**
 * Map CSS px (e.g. a real user event observed in the UI window) back to image space.
 * Used to tell the model "the human just clicked here".
 */
function mapCssPointToImage (point, mapping) {
  return {
    x: cssToImageValue(point.x, mapping, 'x'),
    y: cssToImageValue(point.y, mapping, 'y')
  }
}

/**
 * Where a given action lands, in CSS px, for drawing the marker overlay.
 * Returns null for actions that have no spatial position.
 */
function actionAnchorCss (action, mapping) {
  if (typeof action.x === 'number' && typeof action.y === 'number') {
    return { x: imageToCssValue(action.x, action.coordinateSpace || 'screenshot', mapping, 'x'), y: imageToCssValue(action.y, action.coordinateSpace || 'screenshot', mapping, 'y') }
  }
  if (typeof action.fromX === 'number' && typeof action.fromY === 'number') {
    return { x: imageToCssValue(action.fromX, action.coordinateSpace || 'screenshot', mapping, 'x'), y: imageToCssValue(action.fromY, action.coordinateSpace || 'screenshot', mapping, 'y') }
  }
  return null
}

/**
 * Compute the view-space rectangle of the region a screenshot covers, in case a partial
 * capture (capturePage(rect)) is ever used.
 */
function imageRegionToViewCss (region, mapping) {
  return {
    x: imageToCssValue(region.x, 'screenshot', mapping, 'x'),
    y: imageToCssValue(region.y, 'screenshot', mapping, 'y'),
    width: Math.round(region.width * mapping.scaleX),
    height: Math.round(region.height * mapping.scaleY)
  }
}

/**
 * Fit an image into a max dimension (used to downscale before calling the model).
 * Keeps integer dimensions so the mapping stays exact enough to invert.
 */
function fitDimensions (width, height, maxDimension) {
  if (!maxDimension || !Number.isFinite(maxDimension)) return { width, height }
  const longest = Math.max(width, height)
  if (longest <= maxDimension) return { width, height }
  const scale = maxDimension / longest
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  }
}

module.exports = {
  createMapping,
  mapActionToView,
  mapCssPointToImage,
  actionAnchorCss,
  imageRegionToViewCss,
  detectCoordinateSpace,
  fitDimensions,
  COORDINATE_SPACES: SPACES
}
