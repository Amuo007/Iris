'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const R = require('../iris/agent/resuma')

function computer (cancel) {
  const source = fs.readFileSync(path.join(__dirname, '../main/irisAgent.js'), 'utf8')
  const calls = []
  function IrisComputer () {}
  const tabs = [
    { id: 'application', url: 'https://jobs.citi.com/job/123', active: true },
    { id: 'board', url: 'https://www.ycombinator.com/jobs/role/software-engineer' },
    { id: 'email', url: 'https://mail.google.com/mail/u/0/' }
  ]
  const context = {
    URL,
    IrisComputer,
    irisResumaLib: R,
    irisResumeCancel: async function (file) { calls.push(['cancel', file]); return cancel ? cancel() : true },
    irisPageIsJob: (url) => /citi/.test(url),
    // no job board page in these cases (see irisBoardPageIsJob)
    irisBoardPageIsJob: () => null,
    irisApplicationAt: (url) => /myworkdayjobs/.test(url) ? { status: 'applied' } : null,
    irisProbablySent: () => false,
    irisOtherPosting: (urls, url) => /\/job\/456$/.test(url),
    IRIS_MAIL_SITE: /mail\.google\.com/,
    irisSiteOf: (url) => new URL(url).hostname,
    irisTabList: () => tabs,
    irisSameJob: (job, action) => job.url === action.url,
    irisTabs: { tabs, selected: 'application' },
    irisTabInfo: () => null,
    irisTabCommand: async function (cmd) { calls.push(['tab', cmd]) }
  }
  vm.createContext(context)
  const methods = source.slice(source.indexOf('IrisComputer.prototype.abandonResume ='), source.indexOf('IrisComputer.prototype.resumeForUpload ='))
  vm.runInContext(methods, context)
  const act = source.slice(source.indexOf('IrisComputer.prototype.act ='), source.indexOf('const IRIS_SNAP_RINGS'))
  vm.runInContext(act, context)
  const c = new IrisComputer()
  c.jobsMode = true
  c.tabId = 'application'
  c.lastJob = { title: 'Python Developer', company: 'Citi', url: tabs[0].url, resume: '/citi.pdf', tabId: 'application' }
  c.lastResume = '/citi.pdf'
  c.resumeRun = { jobId: 'running' }
  c.view = () => ({ webContents: {} })
  return { c, calls, context }
}

test('Citi redirect to an already-applied Workday job cancels the running resume without another log', async () => {
  const { c, calls } = computer()
  await c.noteResumeDestination({ url: 'https://citi.wd5.myworkdayjobs.com/2/job/Python-Developer_261002498-1', title: 'Python Developer' })
  assert.deepStrictEqual(calls, [['cancel', '/citi.pdf']])
  assert.strictEqual(c.resumeRun, null)
  assert.strictEqual(c.lastResume, null)
  assert.match(c.lastJob.resumeCancelled, /already handled/)
  await c.noteResumeDestination({ url: 'https://citi.wd5.myworkdayjobs.com/2/job/Python-Developer_261002498-1' })
  assert.strictEqual(calls.length, 1, 'do not cancel the same run twice')
})

test('closing the application waits for cancellation before moving on', async () => {
  let release
  const { c, calls } = computer(() => new Promise(resolve => { release = resolve }))
  const result = c.act({ type: 'close_tab' })
  await Promise.resolve()
  assert.strictEqual(calls.length, 1)
  release(true)
  await result
  assert.deepStrictEqual(calls.map(x => x[0]), ['cancel', 'tab'])
})

test('switching back to job listings cancels; switching to email preserves the resume', async () => {
  const board = computer()
  await board.c.act({ type: 'switch_tab', tab: 2 })
  assert.deepStrictEqual(board.calls.map(x => x[0]), ['cancel', 'tab'])
  const email = computer()
  await email.c.act({ type: 'switch_tab', tab: 3 })
  assert.deepStrictEqual(email.calls.map(x => x[0]), ['tab'])
  assert.ok(email.c.resumeRun)
})

test('explicit move-on cancels while retaining job metadata for its application log', async () => {
  const { c, calls } = computer()
  const result = await c.act({ type: 'cancel_resume', reason: 'posting is closed' })
  assert.ok(result.ok)
  assert.deepStrictEqual(calls, [['cancel', '/citi.pdf']])
  assert.strictEqual(c.lastJob.title, 'Python Developer')
  assert.strictEqual(c.lastJob.resumeCancelled, 'posting is closed')
})

test('another posting at the same company cancels, while a cross-site application redirect continues', async () => {
  const other = computer()
  await other.c.noteResumeDestination({ url: 'https://jobs.citi.com/job/456', title: 'Python Developer' })
  assert.deepStrictEqual(other.calls, [['cancel', '/citi.pdf']])
  const redirect = computer()
  await redirect.c.noteResumeDestination({ url: 'https://apply.citi.com/job/456', title: 'Python Developer' })
  assert.deepStrictEqual(redirect.calls, [])
  assert.ok(redirect.c.resumeRun)
})

test('Citi public posting is rejected before any resume request using its actual Job Req Id', async () => {
  const { c, calls, context } = computer()
  const jobs = fs.readFileSync(path.join(__dirname, '../main/irisJobs.js'), 'utf8')
  const history = [{ company: 'Citi', title: 'Python Developer', status: 'applied', url: 'https://citi.wd5.myworkdayjobs.com/2/job/New-York-New-York-United-States/Python-Developer_261002498-1', at: Date.now() }]
  Object.assign(context, {
    URLSearchParams,
    irisApplicationsLoad: () => history,
    irisAppliedLib: require('../iris/agent/applied'),
    irisCareerLib: require('../iris/agent/career'),
    irisCareerLoad: () => ({ prefs: { dailyLimit: 0 } }),
    irisPostingTextFor: () => 'Python Developer\nJob Req Id:\n\n261002498\nLocation: New York\n' + 'Develop Python APIs and React applications. '.repeat(30),
    DBUG: () => {},
    broadcastEvent: (event) => calls.push(['event', event.type]),
    irisResumeStart: () => { calls.push(['start resume']); throw new Error('must not request a duplicate resume') }
  })
  vm.runInContext(jobs.slice(jobs.indexOf('function irisJobKey ('), jobs.indexOf('/* A job left for the user')), context)
  vm.runInContext(jobs.slice(jobs.indexOf('function irisPostingNumbers ('), jobs.indexOf('/* A fresh-list job already handled')), context)
  c.lastJob = null
  c.view = () => ({ webContents: { getURL: () => 'https://jobs.citi.com/job/new-york/python-developer/287/102161068544', getTitle: () => 'Python Developer | Citi Careers' } })
  const result = await c.act({ type: 'tailor_resume', company: 'Citi', title: 'Python Developer', url: 'https://jobs.citi.com/job/new-york/python-developer/287/102161068544' })
  assert.ok(result.ok)
  assert.deepStrictEqual(calls, [], 'no resume:start event, service request or fallback for an already-applied requisition')
  assert.match(c.notes.join('\n'), /No resume was requested/)
  assert.strictEqual(context.irisApplicationBeforeTailoring({ company: 'Citi', title: 'Python Developer', url: 'https://jobs.citi.com/job/new-york/python-developer/287/102161068545', requirements: 'Job Req Id: 261002499' }), null, 'same title and company with a different requisition remains eligible')
})
