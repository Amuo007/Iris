'use strict'

const test = require('node:test')
const assert = require('node:assert')
const a = require('../iris/agent/applied')

const MIN = 60 * 1000
const NOW = Date.UTC(2026, 9, 24, 22, 0)
const squash = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '')

// the shapes main/irisAgent.js builds (keys and numbers from irisJobKey / irisJobIds, given here by hand)
const conf = (url, key, nums, site, ago) => ({ url, at: NOW - (ago || MIN), key, ids: a.postingIds(key, nums), site, squashed: squash(url) })
const log = (key, nums, site, extra) => Object.assign({ key, ids: a.postingIds(key, nums), site, co: '', here: '', strict: false }, extra || {})

test('a LinkedIn job is known by its number at every address', () => {
  assert.strictEqual(a.linkedinJobId('https://www.linkedin.com/jobs/view/4479608949/'), '4479608949')
  assert.strictEqual(a.linkedinJobId('https://www.linkedin.com/jobs/view/software-engineer-at-acme-4479608949?trk=x'), '4479608949')
  assert.strictEqual(a.linkedinJobId('https://www.linkedin.com/jobs/search/?currentJobId=4479608949&keywords=engineer'), '4479608949')
  assert.strictEqual(a.linkedinJobId('https://www.linkedin.com/jobs/collections/easy-apply/?currentJobId=4479608949'), '4479608949')
  assert.strictEqual(a.linkedinJobId('https://www.linkedin.com/jobs/search/?keywords=engineer'), '')
  assert.strictEqual(a.linkedinJobId('https://jobs.lever.co/acme/4479608949'), '')
  assert.strictEqual(a.linkedinJobId('not a url'), '')
})

test('Easy Apply counts by what LinkedIn shows', () => {
  assert.ok(a.linkedinConfirmed({ dialog: 'Application sent\nYour application was sent to Explore Logistics!', text: '' }, 'https://www.linkedin.com/jobs/search/?currentJobId=1234567'))
  assert.ok(a.linkedinConfirmed({ dialog: '', text: 'Software Engineer · Houston\nApplication submitted now' }, 'https://www.linkedin.com/jobs/view/1234567/'))
  // a search page lists other jobs beside the one selected: its words alone are not this job's
  assert.ok(!a.linkedinConfirmed({ dialog: '', text: 'Application submitted 2 days ago' }, 'https://www.linkedin.com/jobs/search/?currentJobId=1234567'))
  assert.ok(!a.linkedinConfirmed({ dialog: 'Easy Apply to Acme\nContact info', text: '' }, 'https://www.linkedin.com/jobs/view/1234567/'))
  assert.ok(!a.linkedinConfirmed(null, 'https://www.linkedin.com/jobs/view/1234567/'))
})

test('one firm\'s thank-you page does not cover its other jobs', () => {
  const board = 'jobs.ashbyhq.com/true-talent-solutions-partners'
  const site = 'jobs.ashbyhq.com/true-talent-solutions-partners'
  const jobA = board + '/2b774d29-4bb6-47f6-9c90-75f56bf66638'
  const jobB = board + '/75a8f9d4-926a-43cf-a353-9629484f19be'
  const seenA = conf('https://' + jobA + '/application', jobA, [], site)
  // job B logged while only job A's confirmation was seen: the same site and company, but another posting
  assert.ok(!a.confirmationMatches(seenA, log(jobB, [], site, { co: 'truet' }), NOW))
  // job A itself
  assert.ok(a.confirmationMatches(seenA, log(jobA, [], site, { co: 'truet' }), NOW))
  // the page in front of Iris is job A's: still not job B's
  assert.ok(!a.confirmationMatches(seenA, log(jobB, [], site, { here: seenA.url }), NOW))
})

test('a confirmation with no posting id still counts on the company\'s own site', () => {
  // Workday's candidate home after Submit names no job: the site decides, as before
  const site = 'acme.wd5.myworkdayjobs.com'
  const seen = conf('https://acme.wd5.myworkdayjobs.com/en-US/External/userHome', 'acme.wd5.myworkdayjobs.com/en-us/external/userhome', [], site)
  assert.ok(a.confirmationMatches(seen, log('acme.wd5.myworkdayjobs.com/job/r-01372756', [], site), NOW))
  // a number on one side and a UUID on the other (SmartRecruiters' thank-you page): not "another posting"
  const sr = conf('https://jobs.smartrecruiters.com/oneclick-ui/company/Acme/publication/2b774d29-4bb6-47f6-9c90-75f56bf66638', 'jobs.smartrecruiters.com/oneclick-ui/company/acme/publication/2b774d29-4bb6-47f6-9c90-75f56bf66638', [], 'jobs.smartrecruiters.com/oneclick-ui')
  assert.ok(a.confirmationMatches(sr, log('jobs.smartrecruiters.com/acme/744000012345678-software-engineer', ['744000012345678'], 'jobs.smartrecruiters.com/acme', { co: 'acme' }), NOW))
})

test('Greenhouse numbers: the same posting matches, another one does not', () => {
  const seen = conf('https://boards.greenhouse.io/embed/job_app/confirmation?for=aqr&token=8284812', 'boards.greenhouse.io/embed/job_app/confirmation?for=aqr&token=8284812', ['8284812'], 'boards.greenhouse.io/embed')
  assert.ok(a.confirmationMatches(seen, log('careers.aqr.com/jobs?gh_jid=8284812', ['8284812'], 'careers.aqr.com/jobs'), NOW))
  assert.ok(!a.confirmationMatches(seen, log('careers.aqr.com/jobs?gh_jid=8284999', ['8284999'], 'careers.aqr.com/jobs', { co: 'aqr' }), NOW))
})

test('LinkedIn jobs match by number only, and old confirmations expire', () => {
  const site = 'www.linkedin.com/jobs'
  const seen = conf('https://www.linkedin.com/jobs/view/4479608949/', 'linkedin.com/jobs/view/4479608949', ['4479608949'], site)
  assert.ok(a.confirmationMatches(seen, log('linkedin.com/jobs/view/4479608949', ['4479608949'], site, { strict: true }), NOW))
  assert.ok(!a.confirmationMatches(seen, log('linkedin.com/jobs/view/4471111111', ['4471111111'], site, { strict: true }), NOW))
  // a LinkedIn address with no job number: no "same site" pass
  assert.ok(!a.confirmationMatches(seen, log('linkedin.com/jobs/collections/easy-apply', [], site, { strict: true }), NOW))
  // seen 50 minutes ago: too old
  const old = conf('https://jobs.lever.co/acme/2b774d29-4bb6-47f6-9c90-75f56bf66638/thanks', 'jobs.lever.co/acme/2b774d29-4bb6-47f6-9c90-75f56bf66638', [], 'jobs.lever.co/acme', 50 * MIN)
  assert.ok(!a.confirmationMatches(old, log('jobs.lever.co/acme/2b774d29-4bb6-47f6-9c90-75f56bf66638', [], 'jobs.lever.co/acme'), NOW))
})
