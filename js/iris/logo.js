/*
 * js/iris/logo.js
 *
 * Iris's mark: four aperture petals and a pointer. The petals are an aurora of blue, teal, cyan
 * and mint (brighter steps in dark mode, deeper ones in light mode: css/irisAgent.css sets the
 * --logo-* colours); the pointer is white with a dark outline.
 *
 * Stacked layers, so every animation moves whole layers (no repaint per frame):
 *   is-welcome  the petals fly in and settle, the pointer arrives and clicks
 *   is-idle     a slow breath and sway
 *   is-working  the iris turns, the pointer clicks, a ring spreads from its tip
 */

const PETALS = [
  'M84 270C72 164 154 72 257 64c79-6 144 39 170 97-47-56-116-69-178-38-62 30-105 85-127 159-11 36-12 77-3 113C97 364 87 321 84 270Z',
  'M84 270c6-79 67-150 151-164 73-12 139 21 169 72-40-33-97-44-150-20-66 29-102 91-111 152-8 57 9 106 32 137C116 411 77 339 84 270Z',
  'M257 64c100-5 178 67 188 156 8 70-24 137-72 170 27-54 22-112-16-157-39-46-96-67-159-62 39-34 85-52 134-51-22-24-47-42-75-56Z',
  'M340 91c70 31 109 100 105 172-3 66-33 111-72 127-24 11-47 11-73 5 56-27 82-76 77-132-4-67-45-127-103-165 23-6 45-8 66-7Z'
]

const POINTER = 'M240 237Q224 225 214 238Q208 245 212 262L235 426Q239 448 252 449Q262 451 270 438L307 384 366 384Q383 384 388 373Q394 362 378 351Z'

// each petal's gradient direction, as in the original drawing
const DIRECTIONS = [[0, 0, 1, 1], [0, 1, 1, 0], [0, 0, 1, 1], [1, 0, 0, 1]]

// gradient ids must be unique per copy: a gradient inside a hidden copy cannot paint a visible one
let made = 0

function logoMarkup (className) {
  const id = 'iris-logo-' + (++made)
  const defs = DIRECTIONS.map(function (d, i) {
    return '<linearGradient id="' + id + '-' + (i + 1) + '" x1="' + d[0] + '" y1="' + d[1] + '" x2="' + d[2] + '" y2="' + d[3] + '">' +
      '<stop class="iris-stop-' + (i + 1) + 'a"/><stop offset="1" class="iris-stop-' + (i + 1) + 'b"/></linearGradient>'
  }).join('')
  const pointerDefs = '<linearGradient id="' + id + '-p" x1=".15" y1="0" x2=".8" y2="1"><stop class="iris-stop-pa"/><stop offset="1" class="iris-stop-pb"/></linearGradient>'
  return '<span class="iris-logo' + (className ? ' ' + className : '') + '" aria-hidden="true">' +
    '<svg class="iris-logo-petals" viewBox="0 0 512 512"><defs>' + defs + '</defs>' +
    PETALS.map(function (d, i) { return '<path class="iris-petal-' + (i + 1) + '" fill="url(#' + id + '-' + (i + 1) + ')" d="' + d + '"/>' }).join('') +
    '</svg><span class="iris-logo-ripple"></span>' +
    '<svg class="iris-logo-pointer" viewBox="0 0 512 512"><defs>' + pointerDefs + '</defs><path fill="url(#' + id + '-p)" d="' + POINTER + '"/></svg></span>'
}

module.exports = { logoMarkup, PETALS, POINTER }
