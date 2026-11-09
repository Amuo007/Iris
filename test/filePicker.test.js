'use strict'
/* global DOMException */

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const F = require('../iris/agent/filePicker')

const agentSource = fs.readFileSync(path.join(__dirname, '../main/irisAgent.js'), 'utf8')

test('the newer system picker is hidden before page scripts, and refused on a page already built', async () => {
  const page = { showOpenFilePicker: function () { return Promise.resolve([]) }, DOMException }
  page.window = page
  vm.createContext(page)
  vm.runInContext(F.HIDE_FS_PICKER, page)
  assert.strictEqual(vm.runInContext("'showOpenFilePicker' in window", page), false, 'react-dropzone then uses its file box')

  // a native function stands in for the browser's own: the refused one still looks like it
  const built = { showOpenFilePicker: Object.prototype.hasOwnProperty, DOMException }
  built.window = built
  vm.createContext(built)
  vm.runInContext(F.REFUSE_FS_PICKER, built)
  await assert.rejects(vm.runInContext('window.showOpenFilePicker({ multiple: false })', built), function (e) { return e.name === 'SecurityError' },
    'a SecurityError is what makes react-dropzone click its file box')
  assert.match(vm.runInContext('String(window.showOpenFilePicker)', built), /\[native code\]/)
  assert.strictEqual(vm.runInContext('window.showOpenFilePicker.name', built), 'hasOwnProperty')

  const none = { DOMException }
  none.window = none
  vm.createContext(none)
  vm.runInContext(F.REFUSE_FS_PICKER, none)
  assert.strictEqual(vm.runInContext("'showOpenFilePicker' in window", none), false, 'a page without it does not get one')
})

test('the file box for a picker that names none: the resume box for the resume, the cover letter box for the letter', () => {
  const gem = [{ text: 'Click to upload or drag and drop here', area: 'Resume * Click to upload or drag and drop here', empty: true }]
  assert.strictEqual(F.rankFileBoxes(gem, 'resume'), 0, 'one box: that box')
  const two = [{ text: 'Cover letter  Attach', empty: true }, { text: 'Resume/CV * Attach', empty: true }]
  assert.strictEqual(F.rankFileBoxes(two, 'resume'), 1)
  assert.strictEqual(F.rankFileBoxes(two, 'cover'), 0)
  assert.strictEqual(F.rankFileBoxes([{ text: 'Upload your CV', empty: true }, { text: 'Transcript', empty: true }], 'resume'), 0)
  const three = [{ text: 'Resume *', empty: false }, { text: 'Cover Letter', empty: true }, { text: 'Unofficial transcript *', empty: true }]
  assert.strictEqual(F.rankFileBoxes(three, 'transcript'), 2, 'the transcript box for the transcript, not the first empty one')
  assert.strictEqual(F.rankFileBoxes([{ text: 'Attachment', empty: false }, { text: 'Attachment', empty: true }], ''), 1, 'an empty box before a filled one')
  assert.strictEqual(F.rankFileBoxes([{ text: 'Resume', empty: true, disabled: true }, { text: 'Other', empty: true }], 'resume'), 1, 'never a disabled box')
  assert.strictEqual(F.rankFileBoxes([{ text: 'Resume', disabled: true }], 'resume'), -1)
  assert.strictEqual(F.rankFileBoxes([], 'resume'), -1)
})

test('"coverage" or "discover" around a box does not make it a cover letter box, and its own label outweighs its area', () => {
  const boxes = [
    { text: 'Resume * Attach', area: 'Insurance coverage  Resume * Attach', empty: true },
    { text: 'Other documents', area: 'How did you discover this role? Other documents', empty: true }
  ]
  assert.strictEqual(F.rankFileBoxes(boxes, 'resume'), 0)
  const insurance = [
    { text: 'Upload', area: 'Proof of insurance coverage  Upload', empty: true },
    { text: 'Upload', area: 'Cover letter (optional)  Upload', empty: true }
  ]
  assert.strictEqual(F.rankFileBoxes(insurance, 'cover'), 1, 'the cover letter is not proof of coverage')
  const labelled = [
    { text: 'Resume', area: 'Resume and cover letter section', empty: true },
    { text: 'Cover letter', area: 'Resume and cover letter section', empty: true }
  ]
  assert.strictEqual(F.rankFileBoxes(labelled, 'cover'), 1)
  assert.strictEqual(F.rankFileBoxes(labelled, 'resume'), 0)
})

test('the page script compiles and carries what it is asked for as a string only', () => {
  const expr = F.pageFileBox('resume"); alert(1); ("')
  assert.doesNotThrow(function () { return new vm.Script(expr) })
  assert.ok(expr.indexOf(JSON.stringify('resume"); alert(1); ("')) >= 0)
  assert.doesNotThrow(function () { return new vm.Script(F.pageFileBox('')) })
})

/* a small page: elements with tag, own text, attributes and children; enough of the DOM for pageFileBox */
function fakePage (build) {
  const all = []
  function node (tag, attrs, kids) {
    const n = Object.assign({ tagName: tag.toUpperCase(), own: '', parentElement: null, files: null, disabled: false, shadowRoot: null }, attrs || {})
    n.kids = kids || []
    n.kids.forEach(function (k) { k.parentElement = n })
    n.getAttribute = function (a) { return (n.attrs || {})[a] || null }
    n.getRootNode = function () { return doc }
    Object.defineProperty(n, 'innerText', { get: function () { return [n.own].concat(n.kids.map(function (k) { return k.innerText })).filter(Boolean).join('\n') } })
    n.querySelectorAll = function (sel) { return find(n.kids, sel) }
    n.querySelector = function (sel) { return find(n.kids, sel)[0] || null }
    all.push(n)
    return n
  }
  function find (roots, sel) {
    const out = []
    const visit = function (k) {
      const label = /^label\[for="(.+)"\]$/.exec(sel)
      if (sel === '*' || (sel === 'input[type=file]' && k.tagName === 'INPUT' && k.type === 'file') ||
          (sel === 'iframe, frame' && /^I?FRAME$/.test(k.tagName)) || (label && k.tagName === 'LABEL' && k.htmlFor === label[1])) out.push(k)
      k.kids.forEach(visit)
    }
    roots.forEach(visit)
    return out
  }
  const body = build(node)
  const doc = { querySelectorAll: function (sel) { return find([body], sel) }, querySelector: function (sel) { return find([body], sel)[0] || null } }
  return { document: doc, CSS: { escape: function (s) { return s } }, nodes: all }
}

test('the page script finds Gem\'s one box, and on a two-box form the box that the file is for', () => {
  const gem = fakePage(function (h) {
    return h('form', {}, [
      h('div', { own: 'First name *' }),
      h('div', { className: 'flex-30' }, [h('div', { own: 'Resume *' }), h('div', { own: 'Click to upload or drag and drop here' }, [h('input', { type: 'file' })])])
    ])
  })
  const box = vm.runInNewContext(F.pageFileBox('resume'), gem)
  assert.ok(box && box.type === 'file')

  const two = fakePage(function (h) {
    return h('form', {}, [
      h('section', {}, [h('div', { own: 'Cover letter' }), h('div', { own: 'Click to upload' }, [h('input', { type: 'file', name: 'c' })])]),
      h('section', {}, [h('label', { own: 'Resume *', htmlFor: 'resume-file' }), h('div', { own: 'Click to upload' }, [h('input', { type: 'file', id: 'resume-file' })])])
    ])
  })
  assert.strictEqual(vm.runInNewContext(F.pageFileBox('resume'), two).id, 'resume-file')
  assert.strictEqual(vm.runInNewContext(F.pageFileBox('cover'), two).name, 'c')
  assert.strictEqual(vm.runInNewContext(F.pageFileBox('resume'), fakePage(function (h) { return h('form', {}, [h('div', { own: 'No uploads here' })]) })), null)
  const noEscape = Object.assign(two, { CSS: undefined })
  assert.strictEqual(vm.runInNewContext(F.pageFileBox('resume'), noEscape).id, 'resume-file', 'a page without CSS.escape still gets its box')
})

/* IrisComputer.prototype.watch with a fake tab: what DevTools is told, in order, for the tab and for a frame from another site */
function watched (failOn) {
  const source = agentSource.slice(agentSource.indexOf('const IRIS_SELECT_CSS'), agentSource.indexOf('/* Files Iris may offer for an upload'))
  const sent = []
  const logs = []
  function IrisComputer () {}
  const context = { IrisComputer, irisFilePickerLib: F, DBUG: function (m) { logs.push(m) } }
  vm.createContext(context)
  vm.runInContext(source, context)
  let onMessage = null
  const wc = {
    on: function () {},
    removeListener: function () {},
    insertCSS: function () { return Promise.resolve('css') },
    debugger: {
      isAttached: function () { return false },
      attach: function () {},
      detach: function () {},
      removeListener: function () {},
      on: function (event, fn) { if (event === 'message') onMessage = fn },
      sendCommand: async function (method, params, sid) {
        sent.push({ method, params: params || {}, sid: sid || null })
        if (method === failOn) throw new Error('target closed')
        return {}
      }
    }
  }
  const c = new IrisComputer()
  c.watch(wc)
  const settle = function () { return new Promise(function (resolve) { setTimeout(resolve, 20) }) }
  return { sent, logs, settle, frame: function (sid) { onMessage({}, 'Target.attachedToTarget', { sessionId: sid, targetInfo: { type: 'iframe' } }) } }
}

test('each tab Iris watches gets the picker hidden after the file picker is taken over; frames from other sites are left alone', async () => {
  const w = watched()
  await w.settle()
  const tab = w.sent.filter(function (s) { return s.sid === null })
  assert.deepStrictEqual(tab.map(function (s) { return s.method }), ['Page.enable', 'Page.setInterceptFileChooserDialog', 'Page.addScriptToEvaluateOnNewDocument', 'Runtime.evaluate', 'Target.setAutoAttach'])
  assert.strictEqual(tab[2].params.source, F.HIDE_FS_PICKER)
  assert.strictEqual(tab[3].params.expression, F.REFUSE_FS_PICKER)
  w.frame('captcha-frame')
  await w.settle()
  const frame = w.sent.filter(function (s) { return s.sid === 'captcha-frame' })
  assert.deepStrictEqual(frame.map(function (s) { return s.method }), ['Page.enable', 'Page.setInterceptFileChooserDialog', 'Target.setAutoAttach'], 'a CAPTCHA or payment frame keeps its own picker')
})

test('a DevTools failure while hiding the picker does not stop the tab\'s setup', async () => {
  const w = watched('Page.addScriptToEvaluateOnNewDocument')
  await w.settle()
  assert.ok(w.sent.some(function (s) { return s.method === 'Target.setAutoAttach' && s.sid === null }))
  assert.match(w.logs.join('\n'), /file picker setup failed: target closed/)
})

// objects made inside the sandbox have its prototypes: compared by value
function plain (x) { return JSON.parse(JSON.stringify(x)) }

function computer (sendCommand) {
  function IrisComputer () {}
  const logs = []
  const context = {
    URL,
    IrisComputer,
    path,
    fs,
    irisFilePickerLib: F,
    irisResumaLib: require('../iris/agent/resuma'),
    irisCareerLib: require('../iris/agent/career'),
    irisBoardPageIsJob: () => null,
    irisTranscriptFile: () => '',
    irisFindFile: () => null,
    DBUG: (m) => logs.push(m)
  }
  vm.createContext(context)
  vm.runInContext(agentSource.slice(agentSource.indexOf('IrisComputer.prototype.act ='), agentSource.indexOf('const IRIS_SNAP_RINGS')), context)
  const c = new IrisComputer()
  c.jobsMode = true
  c.lastJob = { title: 'Software Engineer, New Grad 2027', company: 'RRS Group', url: 'https://jobs.gem.com/careers-myrrsgroup/x', resume: '/rrs.pdf' }
  c.lastResume = '/rrs.pdf'
  c.resumeForUpload = async function () { return { file: '/rrs.pdf' } }
  c.view = () => ({ webContents: { debugger: { sendCommand } } })
  return { c, logs }
}

test('Gem: a picker with no file box behind it gets the resume through the page\'s file box', async () => {
  const sent = []
  const { c, logs } = computer(async function (method, params, sid) {
    sent.push({ method, params, sid })
    if (method === 'Runtime.evaluate') return { result: { type: 'object', subtype: 'node', objectId: 'box-1' } }
    return {}
  })
  c.pendingChooser = { frameId: 'main', mode: 'selectSingle' }
  const r = await c.act({ type: 'upload', file: 'resume' })
  assert.ok(r.ok, r.error)
  assert.deepStrictEqual(sent.map(s => s.method), ['Runtime.evaluate', 'DOM.setFileInputFiles'])
  assert.match(sent[0].params.expression, /"resume"/)
  assert.deepStrictEqual(plain(sent[1].params), { files: ['/rrs.pdf'], objectId: 'box-1' })
  assert.strictEqual(c.pendingChooser, null)
  assert.strictEqual(c.lastJob.uploaded, true)
  assert.strictEqual(c.lastJob.uploadedFile, '/rrs.pdf')
  assert.match(logs.join('\n'), /went into the page's file box \(the picker names no file box\)/)
})

test('a picker with its own file box uses it; a box gone after the wait falls back to the page\'s', async () => {
  const sent = []
  const own = computer(async function (method, params, sid) { sent.push({ method, params, sid }); return {} })
  own.c.pendingChooser = { frameId: 'f', mode: 'selectSingle', backendNodeId: 42, sessionId: 'frame-7' }
  assert.ok((await own.c.act({ type: 'upload', file: 'resume' })).ok)
  assert.deepStrictEqual(plain(sent), [{ method: 'DOM.setFileInputFiles', params: { files: ['/rrs.pdf'], backendNodeId: 42 }, sid: 'frame-7' }])

  const tries = []
  const gone = computer(async function (method, params, sid) {
    tries.push([method, sid])
    if (method === 'DOM.setFileInputFiles' && params.backendNodeId) throw new Error('No node with given id found')
    if (method === 'Runtime.evaluate') return { result: { type: 'object', subtype: 'node', objectId: 'box-2' } }
    return {}
  })
  gone.c.pendingChooser = { frameId: 'f', mode: 'selectSingle', backendNodeId: 42, sessionId: 'frame-7' }
  assert.ok((await gone.c.act({ type: 'upload', file: 'resume' })).ok)
  assert.deepStrictEqual(tries, [['DOM.setFileInputFiles', 'frame-7'], ['Runtime.evaluate', 'frame-7'], ['DOM.setFileInputFiles', 'frame-7']])
  assert.match(gone.logs.join('\n'), /No node with given id found/)
})

test('no file box anywhere: the upload fails and says why, and the picker stays for another try', async () => {
  const { c } = computer(async function (method) { return method === 'Runtime.evaluate' ? { result: { type: 'object', subtype: 'null', value: null } } : {} })
  c.pendingChooser = { frameId: 'main', mode: 'selectSingle' }
  const r = await c.act({ type: 'upload', file: 'resume' })
  assert.strictEqual(r.ok, false)
  assert.match(r.error, /could not choose the file: the picker names no file box, and no file box was found on the page/)
  assert.ok(c.pendingChooser)
  assert.ok(!c.lastJob.uploaded)
})

test('an error thrown by the page script is not taken for a file box', async () => {
  const sent = []
  const { c } = computer(async function (method, params) {
    sent.push(method)
    if (method === 'Runtime.evaluate') {
      return {
        result: { type: 'object', subtype: 'error', className: 'TypeError', objectId: 'err-1' },
        exceptionDetails: { text: 'Uncaught', exception: { description: "TypeError: Cannot read properties of undefined (reading 'escape')\n    at <anonymous>:1:1" } }
      }
    }
    return {}
  })
  c.pendingChooser = { frameId: 'main', mode: 'selectSingle' }
  const r = await c.act({ type: 'upload', file: 'resume' })
  assert.strictEqual(r.ok, false)
  assert.match(r.error, /no file box was found on the page \(TypeError: Cannot read properties of undefined \(reading 'escape'\)\)$/)
  assert.deepStrictEqual(sent, ['Runtime.evaluate'], 'the error object never goes to DOM.setFileInputFiles')
})
