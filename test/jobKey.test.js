const assert = require('assert')
const fs = require('fs')
const path = require('path')
const test = require('node:test')
const vm = require('vm')

const REVIEW = 'https://smartapply.indeed.com/beta/indeedapply/form/review-module'

function jobs (history) {
  const context = vm.createContext({ URL, URLSearchParams, irisApplicationsLoad: () => history, irisAppliedLib: require('../iris/agent/applied'), irisCareerLib: require('../iris/agent/career') })
  const src = fs.readFileSync(path.join(__dirname, '../main/irisJobs.js'), 'utf8')
  vm.runInContext(src.slice(src.indexOf('function irisJobKey ('), src.indexOf('/* A fresh-list job already handled')), context)
  return context
}

test('Indeed Easy Apply pages name no job, so one application there holds back no other job', () => {
  const c = jobs([{ id: '1', status: 'applied', company: 'EnerSys', title: 'Finance AI & Automation Developer', url: REVIEW }])
  assert.strictEqual(c.irisJobKey(REVIEW), '')
  assert.strictEqual(c.irisApplicationAt(REVIEW), null)
  assert.strictEqual(c.irisSameJob({ company: 'EnerSys', title: 'Finance AI & Automation Developer', url: REVIEW }, { company: 'Realtor.com', title: 'Software Engineer - SRE', url: REVIEW }), false)
})

test('an Indeed job is still told by its jk, on its own page and on the form', () => {
  const posting = 'https://www.indeed.com/viewjob?jk=012b9d38855c7b30'
  const c = jobs([{ id: '1', status: 'applied', company: 'Realtor.com', title: 'Software Engineer - SRE', url: posting }])
  assert.strictEqual(c.irisApplicationAt(posting).id, '1')
  assert.strictEqual(c.irisApplicationAt('https://smartapply.indeed.com/beta/indeedapply/form/review-module?jk=012b9d38855c7b30').id, '1')
  assert.strictEqual(c.irisApplicationAt('https://www.indeed.com/viewjob?jk=75108ba00a728bf3'), null)
})

test('an Indeed search page names the job open on it, and no job without one', () => {
  const lockheed = 'https://www.indeed.com/jobs?q=entry+level+software+engineer&l=Texas&vjk=5dc5ca8e8f68335f'
  const c = jobs([{ id: '1', status: 'applied', company: 'Lockheed Martin', title: 'Systems Engineer Asc', url: lockheed }])
  assert.strictEqual(c.irisJobKey(lockheed), 'indeed.com/viewjob?jk=5dc5ca8e8f68335f')
  assert.strictEqual(c.irisApplicationAt('https://www.indeed.com/viewjob?jk=5dc5ca8e8f68335f').id, '1')
  assert.strictEqual(c.irisApplicationAt('https://www.indeed.com/jobs?q=junior+devops&l=Texas&vjk=012b9d38855c7b30'), null)
  assert.strictEqual(c.irisApplicationAt('https://www.indeed.com/jobs?q=junior+devops&l=Texas'), null)
})
