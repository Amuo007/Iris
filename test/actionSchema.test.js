'use strict'

const test = require('node:test')
const assert = require('node:assert')

const { parseAction, validateAction, describeAction, isTerminal, ACTION_TYPES, parseObjectLoose } = require('../iris/agent/actionSchema')

const LIMITS = { imageWidth: 2880, imageHeight: 1800 }

test('accepts the canonical shape', () => {
  const r = parseAction('{"thought":"I see the search box","action":{"type":"click","x":512,"y":300}}', LIMITS)
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.action.type, 'click')
  assert.strictEqual(r.action.x, 512)
  assert.strictEqual(r.action.y, 300)
  assert.strictEqual(r.thought, 'I see the search box')
})

test('accepts a bare action object', () => {
  const r = parseAction('{"type":"type","text":"hello world"}', LIMITS)
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.action.text, 'hello world')
})

test('accepts the flat shape (action as a string + sibling fields)', () => {
  const r = parseAction('{"thought":"click it","action":"click","x":10,"y":20}', LIMITS)
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.action.type, 'click')
  assert.strictEqual(r.action.x, 10)
})

test('accepts markdown-fenced JSON', () => {
  const raw = 'Sure! Here is my action:\n```json\n{"thought":"open menu","action":{"type":"click","x":100,"y":200}}\n```\nHope that helps.'
  const r = parseAction(raw, LIMITS)
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.action.x, 100)
})

test('accepts prose-wrapped JSON (no fences)', () => {
  const raw = 'I will scroll down. {"thought":"more content below","action":{"type":"scroll","direction":"down","amount":4,"x":700,"y":900}}'
  const r = parseAction(raw, LIMITS)
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.action.direction, 'down')
  assert.strictEqual(r.action.amount, 4)
})

test('repairs trailing commas, Python literals and single quotes', () => {
  assert.strictEqual(parseAction("{'thought':'x','action':{'type':'click','x':5,'y':6,}}", LIMITS).ok, true)
  assert.strictEqual(parseAction('{"thought":True,"action":{"type":"wait","ms":500}}', LIMITS).action.ms, 500)
})

test('coerces numeric strings and rounds fractional coordinates', () => {
  const r = parseAction('{"action":{"type":"click","x":"1 234","y":77.6}}', LIMITS)
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.action.x, 1234)
  assert.strictEqual(r.action.y, 78)
})

test('normalizes common action aliases', () => {
  assert.strictEqual(parseAction('{"action":{"type":"left_click","x":9,"y":9}}', LIMITS).action.type, 'click')
  assert.strictEqual(parseAction('{"action":{"type":"dblclick","x":9,"y":9}}', LIMITS).action.type, 'double_click')
  assert.strictEqual(parseAction('{"action":{"type":"Dbl_Click","x":9,"y":9}}', LIMITS).action.type, 'double_click')
  assert.strictEqual(parseAction('{"action":{"type":"keypress","key":"Enter"}}', LIMITS).action.key, 'enter')
  assert.strictEqual(parseAction('{"action":{"type":"hotkey","keys":"CMD+L"}}', LIMITS).action.keys, 'command+l')
  assert.strictEqual(parseAction('{"action":{"type":"complete","answer":"42"}}', LIMITS).action.type, 'done')
})

test('normalizes modifiers', () => {
  assert.deepStrictEqual(parseAction('{"action":{"type":"key","key":"r","modifiers":["Ctrl","Shift"]}}', LIMITS).action.modifiers, ['control', 'shift'])
})

test('rejects unknown action types', () => {
  const r = parseAction('{"action":{"type":"launch_missiles","x":1,"y":1}}', LIMITS)
  assert.strictEqual(r.ok, false)
  assert.match(r.error, /unknown or missing action type/)
})

test('rejects missing coordinates', () => {
  const r = parseAction('{"action":{"type":"click","x":10}}', LIMITS)
  assert.strictEqual(r.ok, false)
  assert.match(r.error, /missing required field "y"/)
})

test('rejects non-finite coordinates', () => {
  for (const bad of ['NaN', 'Infinity', '"abc"', 'null', '[1,2]']) {
    const r = parseAction(`{"action":{"type":"click","x":${bad},"y":10}}`, LIMITS)
    assert.strictEqual(r.ok, false, `should reject x=${bad}`)
  }
})

test('rejects coordinates outside the screenshot', () => {
  assert.strictEqual(parseAction('{"action":{"type":"click","x":3000,"y":10}}', LIMITS).ok, false)
  assert.strictEqual(parseAction('{"action":{"type":"click","x":10,"y":-3}}', LIMITS).ok, false)
  // edge of the image is allowed
  assert.strictEqual(parseAction('{"action":{"type":"click","x":2879,"y":1799}}', LIMITS).ok, true)
})

test('rejects empty text and overlong text', () => {
  assert.strictEqual(parseAction('{"action":{"type":"type","text":""}}', LIMITS).ok, false)
  assert.strictEqual(parseAction(JSON.stringify({ action: { type: 'type', text: 'x'.repeat(5000) } }), LIMITS).ok, false)
})

test('rejects bad scroll directions and out-of-range amounts', () => {
  assert.strictEqual(parseAction('{"action":{"type":"scroll","direction":"sideways"}}', LIMITS).ok, false)
  assert.strictEqual(parseAction('{"action":{"type":"scroll","direction":"down","amount":999}}', LIMITS).ok, false)
})

test('rejects a zero-length drag', () => {
  const r = parseAction('{"action":{"type":"drag","fromX":5,"fromY":5,"toX":5,"toY":5}}', LIMITS)
  assert.strictEqual(r.ok, false)
  assert.match(r.error, /same point/)
})

test('rejects messages with no JSON at all', () => {
  const r = parseAction('I think we should click the button.', LIMITS)
  assert.strictEqual(r.ok, false)
  assert.match(r.error, /no JSON object found|unparseable/)
})

test('rejects empty and non-string input', () => {
  assert.strictEqual(parseAction('', LIMITS).ok, false)
  assert.strictEqual(parseAction('   ', LIMITS).ok, false)
  assert.strictEqual(parseAction(undefined, LIMITS).ok, false)
  assert.strictEqual(parseAction({ nope: 1 }, LIMITS).ok, false)
})

test('picks the fenced action when several JSON blobs appear', () => {
  const raw = 'Earlier I considered {"x":1,"y":1} but now:\n```json\n{"thought":"final","action":{"type":"click","x":800,"y":600}}\n```'
  const r = parseAction(raw, LIMITS)
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.action.x, 800)
})

test('reads coordinates nested in args/parameters', () => {
  assert.strictEqual(parseAction('{"action":{"type":"click","args":{"x":3,"y":4}}}', LIMITS).action.x, 3)
  assert.strictEqual(parseAction('{"action":{"type":"click","parameters":{"x":3,"y":4}}}', LIMITS).action.y, 4)
})

test('terminal actions are recognised', () => {
  assert.strictEqual(isTerminal(parseAction('{"action":{"type":"done","answer":"ok"}}', LIMITS).action), true)
  assert.strictEqual(isTerminal(parseAction('{"action":{"type":"fail","reason":"no"}}', LIMITS).action), true)
  assert.strictEqual(isTerminal(parseAction('{"action":{"type":"click","x":1,"y":1}}', LIMITS).action), false)
})

test('defaults are applied (button, wait ms, scroll anchor)', () => {
  assert.strictEqual(parseAction('{"action":{"type":"click","x":1,"y":1}}', LIMITS).action.button, 'left')
  assert.strictEqual(parseAction('{"action":{"type":"right_click","x":1,"y":1}}', LIMITS).action.button, 'right')
  assert.strictEqual(parseAction('{"action":{"type":"wait"}}', LIMITS).action.ms, 800)
  const s = parseAction('{"action":{"type":"scroll","direction":"down"}}', LIMITS).action
  assert.deepStrictEqual({ x: s.x, y: s.y, amount: s.amount }, { x: 1440, y: 900, amount: 5 })
})

test('validateAction covers every declared action type', () => {
  const samples = {
    click: { x: 1, y: 1 },
    double_click: { x: 1, y: 1 },
    right_click: { x: 1, y: 1 },
    move: { x: 1, y: 1 },
    drag: { fromX: 1, fromY: 1, toX: 9, toY: 9 },
    scroll: { direction: 'down' },
    type: { text: 'hi' },
    key: { key: 'enter' },
    shortcut: { keys: 'cmd+r' },
    wait: {},
    navigate: { url: 'https://example.com' },
    back: {},
    switch_tab: { tab: 2 },
    new_tab: {},
    close_tab: {},
    zoom: { x: 5, y: 5 },
    find: { text: 'Directions' },
    dialog: { accept: true },
    upload: { file: 'cv.pdf' },
    ask_user: { question: 'What is the code?' },
    save_account: { site: 'shop.test', username: 'me@x.test', password: '{{Password}}' },
    recall: { query: 'PhoneCLI' },
    judge: { item: 'Paper A', keep: true, why: 'fits' },
    update_plan: { plan: 'Goal: x' },
    bookmark: {},
    bookmarks: { query: 'news' },
    lookup: { query: 'best ski boots', kind: 'web' },
    tailor_resume: { title: 'Android Developer', company: 'ShopFast', requirements: 'Kotlin, Compose' },
    cover_letter: { title: 'Android Developer', company: 'ShopFast' },
    log_application: { status: 'applied', company: 'ShopFast', title: 'Android Developer' },
    autofill: {},
    done: {},
    fail: {}
  }
  for (const type of ACTION_TYPES) {
    assert.ok(samples[type], `no sample for ${type}`)
    const r = validateAction(Object.assign({ type }, samples[type]), LIMITS)
    assert.strictEqual(r.ok, true, `${type} should validate: ${r.error}`)
  }
})

test('describeAction produces readable summaries', () => {
  assert.match(describeAction({ type: 'click', x: 3, y: 4 }), /Click at \(3, 4\)/)
  assert.match(describeAction({ type: 'scroll', direction: 'down', amount: 3 }), /Scroll down/)
  assert.match(describeAction({ type: 'type', text: 'a'.repeat(60) }), /…/)
  assert.match(describeAction({ type: 'shortcut', keys: 'meta+l' }), /Shortcut meta\+l/)
})

test('type can click a field first, clear it and press enter in one action', () => {
  const r = parseAction('{"thought":"search","action":{"type":"type","text":"weather","x":640,"y":173,"clear":true,"enter":true}}', LIMITS)
  assert.strictEqual(r.ok, true)
  assert.deepStrictEqual(r.action, { type: 'type', text: 'weather', x: 640, y: 173, clear: true, enter: true })
  assert.match(describeAction(r.action), /and press Enter/)
})

test('type accepts "submit" as an alias for enter and rejects a half coordinate', () => {
  assert.strictEqual(parseAction('{"action":{"type":"type","text":"a","submit":true}}', LIMITS).action.enter, true)
  assert.strictEqual(parseAction('{"action":{"type":"type","text":"a","x":5}}', LIMITS).ok, false)
})

test('back and search aliases parse', () => {
  assert.strictEqual(parseAction('{"action":{"type":"go_back"}}', LIMITS).action.type, 'back')
  assert.strictEqual(parseAction('{"action":{"type":"search","url":"weather in paris"}}', LIMITS).action.type, 'navigate')
  assert.match(describeAction({ type: 'navigate', url: 'weather in paris' }), /Search for/)
  assert.match(describeAction({ type: 'navigate', url: 'example.com' }), /Open example\.com/)
})

test('a list of actions parses as a batch and stops at the first page change', () => {
  const r = parseAction(JSON.stringify({ thought: 'fill the form', remember: 'login page is /signin', actions: [
    { type: 'type', text: 'me@x.com', x: 10, y: 10 },
    { type: 'type', text: '{{Password}}', x: 10, y: 40 },
    { type: 'click', x: 20, y: 80 },
    { type: 'navigate', url: 'example.com' },
    { type: 'click', x: 1, y: 1 }
  ] }), LIMITS)
  assert.strictEqual(r.ok, true)
  assert.deepStrictEqual(r.actions.map(a => a.type), ['type', 'type', 'click', 'navigate'])
  assert.strictEqual(r.remember, 'login page is /signin')
})

test('a bad item rejects the whole batch with its reason', () => {
  const r = parseAction('{"actions":[{"type":"click","x":1,"y":1},{"type":"click","x":99999,"y":1}]}', LIMITS)
  assert.strictEqual(r.ok, false)
  assert.match(r.error, /outside the screenshot/)
})

test('tab actions and zoom validate', () => {
  assert.strictEqual(parseAction('{"action":{"type":"switch_tab","tab":"2"}}', LIMITS).action.tab, 2)
  assert.strictEqual(parseAction('{"action":{"type":"switch_tab"}}', LIMITS).ok, false)
  assert.strictEqual(parseAction('{"action":{"type":"new_tab","url":"example.com"}}', LIMITS).action.url, 'example.com')
  assert.deepStrictEqual(parseAction('{"action":{"type":"zoom","x":3,"y":4}}', LIMITS).action, { type: 'zoom', x: 3, y: 4 })
})

test('lookup keeps a known kind and falls back to web', () => {
  assert.strictEqual(validateAction({ type: 'lookup', query: 'x', kind: 'Papers' }, LIMITS).action.kind, 'papers')
  assert.strictEqual(validateAction({ type: 'lookup', query: 'x', kind: 'google' }, LIMITS).action.kind, 'web')
  assert.strictEqual(validateAction({ type: 'web_search', query: 'x' }, LIMITS).action.type, 'lookup')
})

test('bookmark can name a URL and remove it', () => {
  const r = validateAction({ type: 'bookmark', url: 'https://a.test', remove: 'true' }, LIMITS)
  assert.deepStrictEqual(r.action, { type: 'bookmark', url: 'https://a.test', remove: true })
})

test('a list of actions nested inside "action" is still a batch, and remember inside it counts', () => {
  const a = parseAction('{"thought":"fill","action":{"actions":[{"type":"type","text":"Iris","x":10,"y":10},{"type":"click","x":20,"y":20}],"remember":"Train 331 06:10-07:39"}}', LIMITS)
  assert.strictEqual(a.ok, true)
  assert.deepStrictEqual(a.actions.map(x => x.type), ['type', 'click'])
  assert.strictEqual(a.remember, 'Train 331 06:10-07:39')
  const b = parseAction('{"thought":"fill","action":{"type":"actions","actions":[{"type":"click","x":1,"y":1}]}}', LIMITS)
  assert.strictEqual(b.ok, true)
  assert.strictEqual(b.actions.length, 1)
})

test('"remember" written as an action inside a list becomes the note, the rest still runs', () => {
  const r = parseAction('{"thought":"keep it","actions":[{"type":"judge","item":"Paper A","keep":true,"why":"fits"},{"type":"click","x":5,"y":6},{"type":"remember","text":"KEPT: Paper A"}]}', LIMITS)
  assert.strictEqual(r.ok, true)
  assert.deepStrictEqual(r.actions.map(a => a.type), ['judge', 'click'])
  assert.strictEqual(r.remember, 'KEPT: Paper A')
})

test('an equals sign instead of a colon is repaired', () => {
  const r = parseAction('{"thought":"fill","actions":[{"type":"type","x":392,"y="329,"text":"11122026"},{"type":"click","x":210,"y":"390"}]}', LIMITS)
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.actions[0].y, 329)
  assert.strictEqual(r.actions[1].y, 390)
})

test('job actions: statuses are normalised, unknown ones refused', () => {
  assert.strictEqual(validateAction({ type: 'log_application', status: 'Needs you' }, LIMITS).action.status, 'needs_you')
  assert.strictEqual(validateAction({ type: 'log_application', status: 'submitted' }, LIMITS).action.status, 'applied')
  assert.strictEqual(validateAction({ type: 'log_application', status: 'maybe' }, LIMITS).ok, false)
  assert.strictEqual(validateAction({ type: 'tailor', title: 'ML Engineer' }, LIMITS).action.type, 'tailor_resume')
})

test('quotes the model forgot to escape inside its text are repaired', () => {
  // seen live: the reply was refused twice and the step was lost
  const r = parseAction('{"thought":"Location dropdown shows "Toronto, Ontario, Canada" as the first match. I\'ll click it to select.","action":{"type":"click","x":640,"y":715}}', LIMITS)
  assert.ok(r.ok)
  assert.deepStrictEqual([r.action.type, r.action.x, r.action.y], ['click', 640, 715])
  assert.match(r.thought, /shows "Toronto, Ontario, Canada" as/)
  const d = parseAction('{"thought":"He said "hi", then left","action":{"type":"done","answer":"The page says "Draft deleted"."}}', LIMITS)
  assert.ok(d.ok)
  assert.strictEqual(d.action.answer, 'The page says "Draft deleted".')
  // well-formed JSON with lists and numbers is untouched
  assert.deepStrictEqual(parseObjectLoose('{"a":"x","b":["p","q"],"c":1}'), { a: 'x', b: ['p', 'q'], c: 1 })
})

test('a key that lost its opening quote, or a y written without its key, still parses', () => {
  const a = parseAction('{"thought":"click Apply","action":{"type":"click","x":295,y":828}}', LIMITS)
  assert.ok(a.ok)
  assert.deepStrictEqual([a.action.x, a.action.y], [295, 828])
  const b = parseAction('{"thought":"open the recipe","action":{"type":"click","x":141,896}}', LIMITS)
  assert.ok(b.ok)
  assert.deepStrictEqual([b.action.x, b.action.y], [141, 896])
})

test('a list whose items are each wrapped as {"action":{…}} is read', () => {
  // seen live: refused as "unknown or missing action type"
  const r = parseAction('{"thought":"look things up","actions":[{"action":{"type":"lookup","kind":"arxiv","query":"agent harness"}},{"action":{"type":"lookup","kind":"arxiv","query":"MCP agents"}}]}', LIMITS)
  assert.ok(r.ok, r.error)
  assert.strictEqual(r.action.query, 'agent harness') // a look-up ends the step: its results come first
  const f = parseAction('{"thought":"fill","actions":[{"action":{"type":"type","x":10,"y":20,"text":"Jordan"}},{"action":{"type":"type","x":10,"y":60,"text":"Lee"}}]}', LIMITS)
  assert.deepStrictEqual(f.actions.map(a => a.text), ['Jordan', 'Lee'])
})
