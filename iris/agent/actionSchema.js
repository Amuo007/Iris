'use strict'

/*
 * iris/agent/actionSchema.js
 *
 * The strict action grammar used by the Iris agent, plus a recovery parser that can
 * tolerate sloppy model framing (markdown fences, leading prose, single quotes,
 * trailing commas, flat "thought + action + x + y" layouts) while remaining strict
 * about semantics: an action that cannot be proven safe and well-formed is rejected.
 *
 * This module is pure: no Electron, no DOM, no network.
 */

const COORD_TYPES = new Set(['click', 'double_click', 'right_click', 'drag', 'scroll'])

/* Actions after which the page (or the tab) is different, so a batch must stop there. */
const PAGE_CHANGING = new Set(['navigate', 'back', 'switch_tab', 'new_tab', 'close_tab', 'zoom', 'find', 'dialog', 'upload', 'ask_user', 'recall', 'bookmarks', 'lookup', 'tailor_resume', 'cover_letter'])

const MAX_BATCH = 6

const SCROLL_DIRECTIONS = ['up', 'down', 'left', 'right']

/*
 * Required/optional fields per action type. `coords` are expressed in *screenshot
 * pixels* (device px of the image the model was shown) and are validated against the
 * image size by validateAction().
 */
const SPEC = {
  click: { required: ['x', 'y'], optional: ['button'] },
  double_click: { required: ['x', 'y'], optional: ['button'] },
  right_click: { required: ['x', 'y'], optional: [] },
  drag: { required: ['fromX', 'fromY', 'toX', 'toY'], optional: [] },
  scroll: { required: ['direction'], optional: ['x', 'y', 'amount'] },
  type: { required: ['text'], optional: ['x', 'y', 'clear', 'enter'] },
  key: { required: ['key'], optional: ['modifiers'] },
  shortcut: { required: ['keys'], optional: [] },
  wait: { required: [], optional: ['ms'] },
  navigate: { required: ['url'], optional: [] },
  back: { required: [], optional: [] },
  switch_tab: { required: ['tab'], optional: [] },
  new_tab: { required: [], optional: ['url'] },
  close_tab: { required: [], optional: ['tab'] },
  zoom: { required: ['x', 'y'], optional: [] },
  find: { required: ['text'], optional: [] },
  dialog: { required: ['accept'], optional: ['text'] },
  upload: { required: ['file'], optional: [] },
  ask_user: { required: ['question'], optional: [] },
  save_account: { required: ['site', 'username'], optional: ['password', 'purpose'] },
  lookup: { required: ['query'], optional: ['kind'] },
  recall: { required: ['query'], optional: [] },
  judge: { required: ['item', 'keep'], optional: ['why'] },
  update_plan: { required: ['plan'], optional: [] },
  bookmark: { required: [], optional: ['title', 'url', 'remove'] },
  bookmarks: { required: [], optional: ['query'] },
  tailor_resume: { required: ['title'], optional: ['company', 'requirements', 'url'] },
  cover_letter: { required: ['title'], optional: ['company', 'requirements'] },
  log_application: { required: ['status'], optional: ['company', 'title', 'url', 'note'] },
  move: { required: ['x', 'y'], optional: [] },
  done: { required: [], optional: ['answer'] },
  fail: { required: [], optional: ['reason'] }
}

const TERMINAL = new Set(['done', 'fail'])

/* Synonyms that small models emit constantly. Map them before validating. */
const TYPE_ALIASES = {
  left_click: 'click',
  single_click: 'click',
  tap: 'click',
  press: 'click',
  click_on: 'click',
  dblclick: 'double_click',
  dbl_click: 'double_click',
  rightclick: 'right_click',
  leftclick: 'click',
  doubleclick: 'double_click',
  'double-click': 'double_click',
  contextmenu: 'right_click',
  'right-click': 'right_click',
  secondary_click: 'right_click',
  keystroke: 'key',
  keypress: 'key',
  press_key: 'key',
  key_press: 'key',
  hotkey: 'shortcut',
  keyboard_shortcut: 'shortcut',
  key_combo: 'shortcut',
  scroll_down: 'scroll',
  scroll_up: 'scroll',
  swipe: 'scroll',
  hover: 'move',
  mouse_move: 'move',
  move_mouse: 'move',
  mouseover: 'move',
  input: 'type',
  write: 'type',
  enter_text: 'type',
  type_text: 'type',
  open_url: 'navigate',
  search: 'navigate',
  go_back: 'back',
  switch_to_tab: 'switch_tab',
  select_tab: 'switch_tab',
  tab: 'switch_tab',
  open_tab: 'new_tab',
  newtab: 'new_tab',
  closetab: 'close_tab',
  zoom_in: 'zoom',
  find_in_page: 'find',
  answer_dialog: 'dialog',
  handle_dialog: 'dialog',
  upload_file: 'upload',
  choose_file: 'upload',
  ask: 'ask_user',
  ask_human: 'ask_user',
  tailor: 'tailor_resume',
  make_resume: 'tailor_resume',
  tailor_cv: 'tailor_resume',
  log_job: 'log_application',
  write_cover_letter: 'cover_letter',
  coverletter: 'cover_letter',
  record_application: 'log_application',
  web_search: 'lookup',
  quick_search: 'lookup',
  look_up: 'lookup',
  search_page: 'find',
  ctrl_f: 'find',
  inspect: 'zoom',
  navigate_back: 'back',
  goto: 'navigate',
  go_to_url: 'navigate',
  wait_: 'wait',
  sleep: 'wait',
  pause: 'wait',
  complete: 'done',
  finish: 'done',
  task_complete: 'done',
  answer: 'done',
  error: 'fail',
  abort: 'fail',
  give_up: 'fail'
}

function isPlainObject (v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/* ------------------------------------------------------------------ *
 * JSON extraction
 * ------------------------------------------------------------------ */

/**
 * Pull every plausible JSON object string out of a raw model message, best first.
 * Order matters: fenced blocks win, then the whole message, then balanced-brace slices.
 */
function extractJsonCandidates (text) {
  const out = []
  const seen = new Set()
  const push = (s) => {
    if (typeof s !== 'string') return
    const t = s.trim()
    if (!t || seen.has(t)) return
    seen.add(t)
    out.push(t)
  }

  // 1. ```json ... ``` or ``` ... ```
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/g
  let m
  while ((m = fence.exec(text)) !== null) push(m[1])

  // 2. the whole message
  push(text)

  // 3. every balanced top-level {...} slice (string- and escape-aware)
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === '{') {
      if (depth === 0) start = i
      depth++
    } else if (c === '}') {
      if (depth > 0) {
        depth--
        if (depth === 0 && start >= 0) push(text.slice(start, i + 1))
      }
    }
  }

  return out
}

/** Repair the framing mistakes LLMs make that JSON.parse refuses. */
function repairJson (s) {
  let t = s.trim()

  // trailing comma before } or ]
  t = t.replace(/,\s*([}\]])/g, '$1')

  // Python-ish literals
  t = t.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null')

  // smart quotes used as string delimiters
  t = t.replace(/[\u2018\u2019\u201A]/g, "'")

  // "y="329 or "y"=329: an equals sign where the colon belongs
  t = t.replace(/"([A-Za-z_]+)"?\s*=\s*"?(-?\d+(?:\.\d+)?)(?=\s*[,}])/g, '"$1":$2')

  // ,y":828 — a key that lost its opening quote
  t = t.replace(/([{,]\s*)([A-Za-z_]+)"\s*:/g, '$1"$2":')

  // "x":141,896 — the y key left out after x
  t = t.replace(/"x"\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)(?=\s*[,}])/g, '"x":$1,"y":$2')

  return t
}

/**
 * Quotes the model forgot to escape inside a string: {"thought":"the list shows "Toronto, Ontario" first"}.
 * A double quote ends a string only when JSON can go on after it (a colon, a comma and the next value,
 * a closing brace or bracket); any other one is part of the text and gets escaped.
 */
function escapeInnerQuotes (s) {
  let out = ''
  let inStr = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (!inStr) {
      if (c === '"') inStr = true
      out += c
      continue
    }
    if (c === '\\') { out += c + (s[i + 1] || ''); i++; continue }
    if (c === '"') {
      const rest = s.slice(i + 1).replace(/^\s+/, '')
      if (rest === '' || /^[}\]:]/.test(rest) || /^,\s*("|\{|\[|-?\d|true\b|false\b|null\b|$)/.test(rest)) { inStr = false; out += c } else out += '\\"'
      continue
    }
    out += c
  }
  return out
}

/**
 * Convert a single-quoted pseudo-JSON object into real JSON. Only used as a last resort,
 * and only when the value contains no double quotes inside single-quoted strings.
 */
function singleQuoteToJson (s) {
  let out = ''
  let inDouble = false
  let inSingle = false
  let esc = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (esc) { out += c; esc = false; continue }
    if (c === '\\') { out += c; esc = true; continue }
    if (inDouble) {
      if (c === '"') inDouble = false
      out += c
      continue
    }
    if (inSingle) {
      if (c === "'") { inSingle = false; out += '"' } else if (c === '"') { out += '\\"' } else { out += c }
      continue
    }
    if (c === '"') { inDouble = true; out += c; continue }
    if (c === "'") { inSingle = true; out += '"'; continue }
    out += c
  }
  return out
}

function tryParseObject (candidate) {
  const attempts = [candidate, repairJson(candidate)]
  const sq = singleQuoteToJson(attempts[attempts.length - 1])
  if (sq !== attempts[attempts.length - 1]) attempts.push(sq, repairJson(sq))
  const inner = escapeInnerQuotes(repairJson(candidate))
  if (inner !== attempts[1]) attempts.push(inner)

  for (const a of attempts) {
    try {
      const v = JSON.parse(a)
      if (isPlainObject(v)) return v
      // some models return [ {...} ]
      if (Array.isArray(v) && isPlainObject(v[0])) return v[0]
    } catch (e) { /* try next */ }
  }
  return null
}

/* ------------------------------------------------------------------ *
 * Field coercion
 * ------------------------------------------------------------------ */

function toNumber (v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const cleaned = v.replace(/[,\s]/g, '')
    if (cleaned === '') return null
    const n = Number(cleaned)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function toInteger (v) {
  const n = toNumber(v)
  return n === null ? null : Math.round(n)
}

function toNonNegative (v, max) {
  const n = toInteger(v)
  if (n === null || n < 0) return null
  if (typeof max === 'number' && n > max) return null
  return n
}

function toStringValue (v) {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return null
}

function toBoolean (v) {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') return /^(true|yes|1)$/i.test(v.trim())
  return false
}

function normalizeType (raw) {
  if (typeof raw !== 'string') return null
  let t = raw.trim().toLowerCase().replace(/\s+/g, '_')
  if (TYPE_ALIASES[t]) t = TYPE_ALIASES[t]
  return SPEC[t] ? t : null
}

const MODIFIER_ALIASES = {
  cmd: 'command', command: 'command', meta: 'command', super: 'command', win: 'command', windows: 'command',
  ctrl: 'control', control: 'control',
  alt: 'option', option: 'option', opt: 'option',
  shift: 'shift', shiftkey: 'shift'
}

function normalizeModifiers (v) {
  if (v == null) return []
  const list = Array.isArray(v) ? v : String(v).split(/[+\-\s|,]+/)
  const out = []
  for (const m of list) {
    const s = String(m).trim().toLowerCase()
    if (!s) continue
    const mapped = MODIFIER_ALIASES[s]
    if (mapped && !out.includes(mapped)) out.push(mapped)
  }
  return out
}

function normalizeKeyName (v) {
  const s = toStringValue(v)
  if (s === null) return null
  const t = s.trim()
  if (!t) return null
  const lower = t.toLowerCase()
  const map = {
    enter: 'enter', return: 'enter', returnkey: 'enter',
    escape: 'escape', esc: 'escape',
    space: 'space', spacebar: 'space', ' ': 'space',
    tab: 'tab', backspace: 'backspace', delete: 'delete', del: 'delete',
    up: 'up', down: 'down', left: 'left', right: 'right',
    pageup: 'pageup', page_up: 'pageup', pagedown: 'pagedown', page_down: 'pagedown',
    home: 'home', end: 'end',
    f1: 'f1', f2: 'f2', f3: 'f3', f4: 'f4', f5: 'f5', f6: 'f6',
    f7: 'f7', f8: 'f8', f9: 'f9', f10: 'f10', f11: 'f11', f12: 'f12'
  }
  if (map[lower]) return map[lower]
  if (/^[a-z0-9]$/.test(lower)) return lower
  if (/^[a-z]$/.test(t)) return lower
  return t
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

/**
 * Validate + normalize an already-extracted action object.
 *
 * @param {object} obj candidate action ({ type, ...fields } )
 * @param {object} [limits] { imageWidth, imageHeight } when the action's coordinates are
 *        known to be expressed in screenshot pixels.
 * @returns {{ok: true, action: object}|{ok: false, error: string}}
 */
function validateAction (obj, limits) {
  if (!isPlainObject(obj)) return { ok: false, error: 'action is not an object' }

  const type = normalizeType(obj.type)
  if (!type) {
    return { ok: false, error: 'unknown or missing action type: ' + JSON.stringify(obj.type === undefined ? null : obj.type) }
  }

  const spec = SPEC[type]
  const action = { type }
  const errors = []

  const get = (field) => {
    if (Object.prototype.hasOwnProperty.call(obj, field)) return obj[field]
    // look inside a nested "args"/"parameters"/"input" object
    for (const k of ['args', 'parameters', 'params', 'input', 'arguments']) {
      if (isPlainObject(obj[k]) && Object.prototype.hasOwnProperty.call(obj[k], field)) return obj[k][field]
    }
    return undefined
  }

  const inRange = (n, max) => {
    if (n === null) return false
    if (typeof max !== 'number') return true
    return n >= 0 && n <= max
  }

  const coordError = (name, value, max) => {
    const n = toInteger(value)
    if (n === null) { errors.push(`${name} must be a finite number (got ${JSON.stringify(value)})`); return null }
    if (!inRange(n, max)) { errors.push(`${name}=${n} is outside the screenshot (0..${max})`); return null }
    return n
  }

  if (type === 'type' && obj.enter === undefined) {
    const alias = obj.submit !== undefined ? obj.submit : (obj.press_enter !== undefined ? obj.press_enter : obj.pressEnter)
    if (alias !== undefined) obj = Object.assign({}, obj, { enter: alias })
  }

  const w = limits && typeof limits.imageWidth === 'number' ? limits.imageWidth : undefined
  const h = limits && typeof limits.imageHeight === 'number' ? limits.imageHeight : undefined

  for (const field of spec.required.concat(spec.optional)) {
    const value = get(field)
    const isRequired = spec.required.includes(field)
    if (value === undefined || value === null || value === '') {
      if (isRequired) errors.push(`missing required field "${field}" for action "${type}"`)
      continue
    }

    switch (field) {
      case 'x': {
        const n = coordError('x', value, w)
        if (n !== null) action.x = n
        break
      }
      case 'y': {
        const n = coordError('y', value, h)
        if (n !== null) action.y = n
        break
      }
      case 'fromX': {
        const n = coordError('fromX', value, w)
        if (n !== null) action.fromX = n
        break
      }
      case 'fromY': {
        const n = coordError('fromY', value, h)
        if (n !== null) action.fromY = n
        break
      }
      case 'toX': {
        const n = coordError('toX', value, w)
        if (n !== null) action.toX = n
        break
      }
      case 'toY': {
        const n = coordError('toY', value, h)
        if (n !== null) action.toY = n
        break
      }
      case 'amount': {
        const n = toInteger(value)
        if (n === null || n < 1 || n > 40) errors.push(`amount must be 1..40 (got ${JSON.stringify(value)})`)
        else action.amount = n
        break
      }
      case 'ms': {
        const n = toNonNegative(value, 30000)
        if (n === null) errors.push(`ms must be 0..30000 (got ${JSON.stringify(value)})`)
        else action.ms = n
        break
      }
      case 'direction': {
        const d = toStringValue(value)
        const dl = d === null ? null : d.trim().toLowerCase()
        if (!dl || !SCROLL_DIRECTIONS.includes(dl)) errors.push(`direction must be one of ${SCROLL_DIRECTIONS.join('|')}`)
        else action.direction = dl
        break
      }
      case 'text': {
        const s = toStringValue(value)
        if (s === null) errors.push('text must be a string')
        else if (s.length === 0) errors.push('text must not be empty')
        else if (s.length > 4000) errors.push('text is too long (max 4000 characters)')
        else action.text = s
        break
      }
      case 'key': {
        const k = normalizeKeyName(value)
        if (!k) errors.push('key must be a key name')
        else action.key = k
        break
      }
      case 'keys': {
        // "cmd+shift+l" -> modifiers + key, kept as a canonical string
        const s = toStringValue(value)
        const parts = Array.isArray(value) ? value.map(p => String(p).trim().toLowerCase()).filter(Boolean)
          : s.toLowerCase().split(/[+\- ]+/).filter(Boolean)
        if (!parts.length) { errors.push('keys must name at least one key'); break }
        const mods = []
        let main = null
        for (const p of parts) {
          const m = MODIFIER_ALIASES[p]
          if (m) { if (!mods.includes(m)) mods.push(m) } else main = p
        }
        if (!main) { errors.push('keys must include a non-modifier key'); break }
        action.key = main
        action.modifiers = mods
        action.keys = mods.concat(main).join('+')
        break
      }
      case 'modifiers': {
        action.modifiers = normalizeModifiers(value)
        break
      }
      case 'button': {
        const b = toStringValue(value)
        const bl = b === null ? '' : b.trim().toLowerCase()
        if (['left', 'right', 'middle'].includes(bl)) action.button = bl
        else if (/^[0-2]$/.test(bl)) action.button = ['left', 'middle', 'right'][Number(bl)]
        else errors.push(`button must be left|middle|right (got ${JSON.stringify(value)})`)
        break
      }
      case 'url': {
        const s = toStringValue(value)
        if (!s || !/\S/.test(s)) errors.push('url must be a non-empty string')
        else action.url = s.trim()
        break
      }
      case 'tab': {
        const n = toInteger(value)
        if (n === null || n < 1 || n > 200) errors.push(`tab must be a tab number from the list (got ${JSON.stringify(value)})`)
        else action.tab = n
        break
      }
      case 'kind': {
        const k = toStringValue(value)
        const kl = k === null ? '' : k.trim().toLowerCase()
        action.kind = ['web', 'papers', 'arxiv', 'wiki', 'page', 'jobs'].includes(kl) ? kl : 'web'
        break
      }
      case 'status': {
        const v = String(toStringValue(value) || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
        const map = { applied: 'applied', submitted: 'applied', done: 'applied', skipped: 'skipped', skip: 'skipped', not_a_fit: 'skipped', needs_you: 'needs_you', needs_user: 'needs_you', stuck: 'needs_you', blocked: 'needs_you', failed: 'failed', error: 'failed' }
        if (!map[v]) errors.push('status must be applied|skipped|needs_you|failed')
        else action.status = map[v]
        break
      }
      case 'company':
      case 'requirements':
      case 'note':
      case 'purpose':
      case 'title':
      case 'plan':
      case 'item':
      case 'why':
      case 'query':
      case 'site':
      case 'username':
      case 'password':
      case 'file':
      case 'question': {
        const v = toStringValue(value)
        if (!v || !v.trim()) errors.push(field + ' must be a non-empty string')
        else action[field] = v.trim()
        break
      }
      case 'keep':
      case 'remove':
      case 'accept':
      case 'clear':
      case 'enter': {
        action[field] = toBoolean(value)
        break
      }
      case 'answer':
      case 'reason': {
        const s = toStringValue(value)
        if (s !== null) action[field] = s
        break
      }
      default:
        break
    }
  }

  if (type === 'shortcut' && !action.keys) {
    errors.push('shortcut requires "keys"')
  }

  if (errors.length) return { ok: false, error: errors.join('; ') }

  // defaults that the injector relies on
  if (COORD_TYPES.has(type) || type === 'move') {
    if (action.type === 'scroll') {
      action.direction = action.direction || 'down'
      action.amount = action.amount || 5
    }
    if (action.button === undefined) action.button = type === 'right_click' ? 'right' : 'left'
  }
  if (type === 'wait' && action.ms === undefined) action.ms = 800
  if (type === 'type' && (action.x === undefined) !== (action.y === undefined)) {
    return { ok: false, error: 'type needs both x and y, or neither' }
  }
  if (type === 'scroll' && (action.x === undefined || action.y === undefined)) {
    // scrolling with no anchor means "scroll the viewport centre"
    if (w && h) { action.x = Math.round(w / 2); action.y = Math.round(h / 2) }
  }

  // semantic sanity checks
  if (type === 'drag' && action.fromX === action.toX && action.fromY === action.toY) {
    return { ok: false, error: 'drag start and end are the same point' }
  }

  return { ok: true, action }
}

/* ------------------------------------------------------------------ *
 * Public entry point
 * ------------------------------------------------------------------ */

/**
 * Parse a raw model message into a well-formed action.
 *
 * @param {string} rawText full assistant message content
 * @param {object} [limits] { imageWidth, imageHeight } of the screenshot that was shown
 * @returns {{ok: true, action: object, thought: string|null}|{ok: false, error: string}}
 */
function parseAction (rawText, limits) {
  if (typeof rawText !== 'string') return { ok: false, error: 'model returned no text' }
  if (!rawText.trim()) return { ok: false, error: 'model returned empty text' }

  const candidates = extractJsonCandidates(rawText)
  if (!candidates.length) return { ok: false, error: 'no JSON object found in model output' }

  const errors = []
  for (const c of candidates) {
    const obj = tryParseObject(c)
    if (!obj) { errors.push('unparseable JSON: ' + c.slice(0, 120)); continue }

    let thought = null

    // Shape A (canonical): { "thought": "...", "action": { "type": ... } }
    // Shape B (flat):      { "thought": "...", "action": "click", "x": 1, "y": 2 }
    // Shape C (bare):      { "type": "click", "x": 1, "y": 2 }
    let actionObj = null
    let batch = null
    if (Array.isArray(obj.actions) && obj.actions.length) {
      batch = obj.actions
      thought = toStringValue(obj.thought ?? obj.reasoning ?? obj.reason ?? obj.explanation)
    } else if (Array.isArray(obj.action) && obj.action.length) {
      batch = obj.action
      thought = toStringValue(obj.thought ?? obj.reasoning ?? obj.explanation)
    } else if (isPlainObject(obj.action) && Array.isArray(obj.action.actions) && obj.action.actions.length) {
      // {"action":{"actions":[...]}} or {"action":{"type":"actions","actions":[...]}}: a list put one level too deep
      batch = obj.action.actions
      thought = toStringValue(obj.thought ?? obj.reasoning ?? obj.explanation)
    } else if (isPlainObject(obj.action)) {
      actionObj = obj.action
      thought = toStringValue(obj.thought ?? obj.reasoning ?? obj.reason ?? obj.explanation)
    } else if (typeof obj.action === 'string' && SPEC[normalizeType(obj.action)]) {
      actionObj = Object.assign({}, obj, { type: obj.action })
      thought = toStringValue(obj.thought ?? obj.reasoning ?? obj.reason ?? obj.explanation)
    } else if (obj.type !== undefined) {
      actionObj = obj
      thought = toStringValue(obj.thought ?? obj.reasoning ?? obj.reason ?? obj.explanation)
    }

    const inner = isPlainObject(obj.action) ? obj.action : {}
    const remember = toStringValue(obj.remember ?? obj.note ?? obj.memory ?? inner.remember)
    const learn = toStringValue(obj.learn ?? obj.skill ?? obj.lesson ?? inner.learn)

    if (batch) {
      const actions = []
      let bad = null
      let noted = remember
      let learned = learn
      for (let item of batch.slice(0, MAX_BATCH + 2)) {
        // [{"action":{"type":"lookup",…}}, …]: each item wrapped one level too deep
        if (isPlainObject(item) && item.type === undefined && isPlainObject(item.action)) item = item.action
        // "remember"/"learn" written as if they were actions: keep the text, it is not an action
        const kind = isPlainObject(item) && typeof item.type === 'string' ? item.type.trim().toLowerCase() : ''
        if (kind === 'remember' || kind === 'note' || kind === 'memory' || kind === 'learn') {
          const t = toStringValue(item.text ?? item.note ?? item.value ?? item.remember ?? item.learn)
          if (t && kind === 'learn') learned = learned || t
          else if (t) noted = noted ? noted + '\n' + t : t
          continue
        }
        if (actions.length >= MAX_BATCH) break
        const res = validateAction(item, limits)
        if (!res.ok) { bad = res.error; break }
        actions.push(res.action)
        // nothing after a page change or a terminal action can be planned from this screenshot
        if (PAGE_CHANGING.has(res.action.type) || TERMINAL.has(res.action.type)) break
      }
      if (bad) { errors.push(bad); continue }
      // only notes and no real action: look again (a short wait) rather than reject the reply
      if (!actions.length && (noted || learned)) actions.push({ type: 'wait', ms: 300 })
      if (!actions.length) { errors.push('empty actions list'); continue }
      return { ok: true, action: actions[0], actions, thought, remember: noted || null, learn: learned || null }
    }

    if (!actionObj) { errors.push('no "action" field'); continue }

    const res = validateAction(actionObj, limits)
    if (!res.ok) { errors.push(res.error); continue }

    return { ok: true, action: res.action, actions: [res.action], thought: thought, remember: remember || null, learn: learn || null }
  }

  return { ok: false, error: errors[errors.length - 1] || 'could not extract a valid action' }
}

/** Human-readable one-liner for the step timeline. */
function describeAction (action) {
  if (!action || !action.type) return 'invalid action'
  switch (action.type) {
    case 'click': return `Click at (${action.x}, ${action.y})`
    case 'double_click': return `Double-click at (${action.x}, ${action.y})`
    case 'right_click': return `Right-click at (${action.x}, ${action.y})`
    case 'move': return `Move pointer to (${action.x}, ${action.y})`
    case 'drag': return `Drag (${action.fromX}, ${action.fromY}) \u2192 (${action.toX}, ${action.toY})`
    case 'scroll': return `Scroll ${action.direction}${action.x !== undefined ? ` at (${action.x}, ${action.y})` : ''} \u00d7${action.amount}`
    case 'type': return `Type "${action.text.length > 40 ? action.text.slice(0, 40) + '\u2026' : action.text}"${action.enter ? ' and press Enter' : ''}`
    case 'key': return `Press ${((action.modifiers || []).join('+') ? (action.modifiers.join('+') + '+') : '') + action.key}`
    case 'shortcut': return `Shortcut ${action.keys}`
    case 'wait': return `Wait ${action.ms} ms`
    case 'navigate': return /^[a-z]+:\/\/|^[^\s]+\.[a-z]{2,}(\/|$)/i.test(action.url) ? `Open ${action.url}` : `Search for "${action.url}"`
    case 'back': return 'Go back'
    case 'switch_tab': return `Switch to tab ${action.tab}`
    case 'new_tab': return action.url ? `Open a new tab: ${action.url}` : 'Open a new tab'
    case 'close_tab': return action.tab ? `Close tab ${action.tab}` : 'Close this tab'
    case 'zoom': return `Zoom in at (${action.x}, ${action.y})`
    case 'find': return `Find "${action.text}" on the page`
    case 'dialog': return action.accept ? 'Answer the dialog: OK' + (action.text ? ` ("${action.text}")` : '') : 'Answer the dialog: Cancel'
    case 'upload': return `Upload ${action.file}`
    case 'ask_user': return `Ask you: ${action.question}`
    case 'save_account': return `Save the account for ${action.site}`
    case 'recall': return `Recall "${action.query}"`
    case 'judge': return (action.keep ? 'Keep' : 'Skip') + ` "${action.item}"` + (action.why ? ` — ${action.why}` : '')
    case 'update_plan': return 'Update the plan'
    case 'bookmark': return action.remove ? 'Remove the bookmark' + (action.url ? ' for ' + action.url : '') : 'Bookmark ' + (action.url || 'this page')
    case 'lookup': return 'Look up (' + (action.kind || 'web') + ') "' + action.query + '"'
    case 'bookmarks': return action.query ? `Look up bookmarks for "${action.query}"` : 'List bookmarks'
    case 'tailor_resume': return 'Tailor the resume for ' + action.title + (action.company ? ' at ' + action.company : '')
    case 'cover_letter': return 'Write a cover letter for ' + action.title + (action.company ? ' at ' + action.company : '')
    case 'log_application': return ({ applied: 'Applied', skipped: 'Skipped', needs_you: 'Needs you', failed: 'Could not apply' })[action.status] + (action.title ? ': ' + action.title : '') + (action.company ? ' at ' + action.company : '')
    case 'done': return action.answer ? `Done \u2014 ${action.answer}` : 'Done'
    case 'fail': return action.reason ? `Stopped \u2014 ${action.reason}` : 'Stopped'
    default: return action.type
  }
}

function isTerminal (action) {
  return !!(action && TERMINAL.has(action.type))
}

/** The spec text handed to the model. Kept next to the parser so they cannot drift. */
const ACTION_SPEC_TEXT = [
  'Reply with EXACTLY ONE JSON object and nothing else (no prose, no markdown fences):',
  '{"thought":"<one short sentence: what you see and what you do next>","action":{"type":"<type>",...}}',
  'To do several things on the SAME screen in one go (fill a form, then submit), send a list instead:',
  '{"thought":"...","actions":[{...},{...},{...}]}     (max 6; stops after anything that changes the page)',
  'Optional: "remember":"<fact worth keeping>" saves a note you will see on every later step.',
  'Optional: "learn":"<short tip about THIS website>" saves a skill for next time, e.g. a direct URL that',
  'goes straight to results, or where a hidden button is. Only real, reusable shortcuts; you will see them next visit.',
  '',
  'Actions. x/y are pixel positions in the screenshot, from its top-left corner:',
  '  click        {"x":int,"y":int}',
  '  double_click {"x":int,"y":int}',
  '  right_click  {"x":int,"y":int}',
  '  move         {"x":int,"y":int}                     (hover, e.g. to open a menu)',
  '  drag         {"fromX":int,"fromY":int,"toX":int,"toY":int}',
  '  type         {"text":str,"x":int?,"y":int?,"clear":bool?,"enter":bool?}',
  '               clicks (x,y) first when given, then REPLACES the text already in the field',
  '               ("clear":false adds to it instead);',
  '               enter:true presses Enter after typing (submits searches and forms)',
  '  key          {"key":"enter|tab|escape|backspace|delete|up|down|left|right|pagedown|pageup|home|end|a..z","modifiers":["command"|"shift"]?}',
  '               (command+a/c/v/x/z work: select all, copy, paste, cut, undo)',
  '  scroll       {"direction":"down|up","amount":int?,"x":int?,"y":int?}   (amount = wheel notches, default 5)',
  '  zoom         {"x":int,"y":int}  look closer: the next screenshot is a 2x close-up around that point',
  '  find         {"text":str}       find text on the page (like Cmd+F): jumps to it and highlights it; repeat for the next match',
  '  dialog       {"accept":bool,"text":str?}  answer a browser dialog (alert / confirm / prompt) Iris tells you about',
  '  upload       {"file":str}       choose a file in an open file picker (a name from the list Iris gives you, or a full path)',
  '  ask_user     {"question":str}   pause and ask the user (CAPTCHA, a one-time code, a missing detail, a choice only they can make)',
  '  judge        {"item":str,"keep":bool,"why":str}  your decision about a candidate (a paper, product, page)',
  '               after reading enough of it; it is saved, so you never judge the same thing twice',
  '  update_plan  {"plan":str}       rewrite your plan when you learn something that changes it (same parts)',
  '  bookmark     {"title":str?,"url":str?,"remove":bool?}  bookmark the page you are on (or url) on the bookmarks bar;',
  '               remove:true deletes that bookmark',
  '  bookmarks    {"query":str?}     look up the user\'s bookmarks (title and URL); then navigate to one',
  '  recall       {"query":str}      search everything saved in this chat (notes, downloads, pages visited),',
  '               e.g. a paper title or ID; the best matches come back on the next step',
  '  save_account {"site":str,"username":str,"password":str,"purpose":str}  after creating an account, record it',
  '               for the user (password: the placeholder you typed, e.g. "{{Password}}"; purpose: why it was made)',
  '  lookup       {"kind":"web|papers|arxiv|wiki|page|jobs","query":str}  a quick look-up OUTSIDE the browser, as text:',
  '               web = search results with snippets, papers = papers with abstracts and citation counts,',
  '               arxiv = newest arXiv preprints, wiki = encyclopedia summary, page = text of one public page (query = its URL),',
  '               jobs = every opening on one company\'s Greenhouse/Lever/Ashby board, filtered (query = board address + words,',
  '               e.g. "jobs.lever.co/acme software engineer toronto").',
  '               Use it to decide where to go, to check a fact, or to read a long public list (jobs, products,',
  '               papers) in one step instead of scrolling. Do the task itself (forms, accounts, downloads,',
  '               purchases) in the browser. A few per task.',
  '  navigate     {"url":str}        open a URL, or give plain words to search the web',
  '  back         {}                 browser Back button',
  '  new_tab      {"url":str?}       open a new tab (and switch to it)',
  '  switch_tab   {"tab":int}        switch to a tab from the "Tabs" list',
  '  close_tab    {"tab":int?}       close a tab (default: the current one)',
  '  wait         {"ms":int?}        only while a page is visibly loading',
  '  done         {"answer":str}     task complete; answer tells the user the result or what you found',
  '  fail         {"reason":str}     task impossible',
  '',
  'Rules:',
  '- Act only on what the newest screenshot shows. If what you need is not visible, scroll or navigate.',
  '- On a long page, use find with a likely word (e.g. "Directions", "Price", "°F") instead of scrolling back and forth.',
  '- One screen of scrolling is about amount 6.',
  '- Take the shortest path: open a known URL directly, and fill a field with ONE "type" action',
  '  (x, y, text, enter:true). Fill a whole form with one "actions" list.',
  '- Click the centre of the element you mean. If it is small or you are not sure where it is, zoom first.',
  '- Iris types exactly the text you give. A text box that looks cut off is just too narrow to show it all;',
  '  do not retype or "fix" it. Fields outlined in red are invalid: read the message near them.',
  '- When a link opens a new tab, Iris switches to it automatically; the "Tabs" list shows all tabs.',
  '- If your last action changed nothing, do something different. Never repeat a failed action.',
  '- A menu that opened when the pointer went over it stays open while the pointer rests there. If it covers',
  '  what you need to see (e.g. right after you clicked one of its items), move the pointer to an empty part of',
  '  the page; do not click the item again.',
  '- Close cookie banners, ads and pop-ups that cover the page (their X, "Close", "No thanks", or Escape). Never click ads.',
  '- If a tab you did not want opened by itself (an ad or pop-up), close it with close_tab and carry on in your own tab.',
  '- To download a file, click its download link or button. Iris saves it to the Downloads folder by itself and tells you when it is done.',
  '- To upload a file, click the upload button or "Choose file"; Iris then lists files you can pick with upload.',
  '- Date fields (mm/dd/yyyy): click the FIRST part of the field (the "mm" at its left end), then type all the',
  '  digits with no slashes (23 Oct 2026 → "10232026"); the field moves on by itself. If digits landed in the',
  '  wrong part, click "mm" again and retype. Time fields the same way. Do not use the calendar pop-up.',
  '- Dropdowns (a box with ▼ or "Select…") whose options you can tell (Yes / No, a country): type the OPTION\'S OWN',
  '  words into it, e.g. {"type":"type","x":..,"y":..,"text":"Yes","clear":false,"enter":true}, not your own wording',
  '  ("Canadian citizen" is not an option; "Yes" is). Unsure what the options are: click it to open the list, then',
  '  pick by typing the option\'s words with enter:true (more reliable than clicking the option). Options that are',
  '  ranges or numbers ("Less than 1 year", "1-2 years", "$50k-$75k"): open the list first and type the whole option',
  '  as listed — a bare number picks the first option containing it. If a field then shows another option than the',
  '  one you meant, pick again.',
  '  A whole form, dropdowns included, can go in one "actions" list; then check each field in the next screenshot.',
  '- Enter (enter:true) only picks a dropdown option or runs a search. Never press Enter in a form\'s text box: it',
  '  sends the whole form, often before it is complete. Send a form only with its own submit button.',
  '- Fields with suggestions (cities, airports, addresses): type, then make sure the list shows matches for what',
  '  you typed before clicking one (an old list can still be showing); if not, wait once. Check the field afterwards.',
  '- A "Verifying you are human" / "Just a moment" page often clears by itself: wait up to about 10 s.',
  '  Never solve a CAPTCHA or puzzle yourself. If it stays, use another site that has the same thing;',
  '  if only that site will do, use ask_user so the user can do it.',
  '- When asked to find or choose the best things, open each candidate and read enough (abstract, summary,',
  '  reviews) to judge it against what the user needs; record judge before you download or add it.',
  '- Close tabs you opened only to help (an email inbox, a pop-up) once you are done with them.',
  '- Report only what you saw on a page or in look-up results during this task. Never fill in titles,',
  '  names, numbers or facts from memory; if you could not find or confirm something, leave it out or say so.',
  '- Details you will need for the final answer (times, prices, names, codes) and that will leave the',
  '  screen: save them with "remember" when you see them. Before "done", check each detail of your answer',
  '  against the screenshot or your notes; leave out anything that is in neither.',
  '- As soon as the screenshot shows the answer, reply "done" with the answer. If you found a faster way',
  '  around this site than the obvious one, include "learn" in that same reply.'
].join('\n')

module.exports = {
  parseAction,
  validateAction,
  describeAction,
  isTerminal,
  extractJsonCandidates,
  parseObjectLoose: tryParseObject,
  normalizeModifiers,
  normalizeKeyName,
  ACTION_SPEC_TEXT,
  PAGE_CHANGING,
  MAX_BATCH,
  ACTION_TYPES: Object.keys(SPEC),
  TERMINAL_TYPES: Array.from(TERMINAL)
}
