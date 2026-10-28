'use strict'

const test = require('node:test')
const assert = require('node:assert')
const c = require('../iris/agent/concierge')

const MIN = 60 * 1000
const T0 = Date.UTC(2026, 9, 24, 22, 0)
const running = { selfChat: true, run: { status: 'running', task: 'Find CS jobs and apply', steps: 120, now: 'Filling the Palantir form' }, stats: { today: { applied: 22, needsYou: 6, skipped: 9, failed: 1 }, week: { applied: 120, needsYou: 30, skipped: 40, failed: 5 }, all: { applied: 610, needsYou: 160, skipped: 95, failed: 13 } } }

test('the WhatsApp agent sees what Iris is doing, the numbers and what it can do', () => {
  const m = c.conciergeMessages(Object.assign({}, running, { question: 'Which start date?', codeFor: 'TikTok — SWE' }), 'hi iris how are you')
  assert.strictEqual(m.length, 2)
  assert.ok(/Iris can: find jobs/.test(m[0].content), 'what Iris can do')
  assert.ok(/"when": "now"\|"next"/.test(m[0].content))
  const ctx = m[1].content
  assert.ok(/Message yourself/.test(ctx) && /action "none"/.test(ctx), 'notes to self are possible here')
  assert.ok(/working on "Find CS jobs and apply", step 120; this step: Filling the Palantir form/.test(ctx))
  assert.ok(/today: 22 applied, 6 need the user, 9 skipped, 1 failed; last 7 days: 120 applied/.test(ctx))
  assert.ok(/WAITING for the user's answer to: "Which start date\?"/.test(ctx))
  assert.ok(/WAITING for a code .* TikTok — SWE/.test(ctx))
  assert.ok(/The user's new message:\nhi iris how are you$/.test(ctx))
  assert.ok(/every message here is for Iris/.test(c.contextText({ selfChat: false })))
})

test('the last 24 hours and the LinkedIn notes are in the facts (a night run spans midnight)', () => {
  const t = c.contextText({ selfChat: true, run: { status: 'running' }, stats: { today: { applied: 1, needsYou: 0, skipped: 2, failed: 0 }, day: { applied: 20, needsYou: 6, skipped: 106, failed: 0 } }, linkedin: ['Steve', 'Dylan'] })
  assert.match(t, /today: 1 applied, 0 need the user, 2 skipped, 0 failed; last 24 hours: 20 applied/)
  assert.match(t, /LinkedIn connection requests with a note, last 24 hours: 2 \(to Steve, Dylan\)/)
})

test('the conversation is remembered until 20 quiet minutes', () => {
  const h = [
    { from: 'user', text: 'hi', at: T0 },
    { from: 'iris', text: '[Iris] Hey!', at: T0 + MIN },
    { from: 'user', text: 'how many today?', at: T0 + 40 * MIN },
    { from: 'iris', text: '[Iris] 22 applied.', at: T0 + 41 * MIN }
  ]
  // 39 quiet minutes between the 2nd and 3rd messages: only the newer exchange is still the conversation
  assert.deepStrictEqual(c.liveHistory(h, T0 + 45 * MIN).map(x => x.text), ['how many today?', '[Iris] 22 applied.'])
  assert.deepStrictEqual(c.liveHistory(h, T0 + 70 * MIN), [], 'quiet for 29 minutes: forgotten')
  assert.deepStrictEqual(c.liveHistory([], T0), [])
  assert.strictEqual(c.liveHistory(h.slice(0, 2), T0 + 5 * MIN).length, 2)
})

test('the decision is read from the model and checked against what is possible', () => {
  const p = function (obj, ctx, msg) { return c.parseDecision(typeof obj === 'string' ? obj : JSON.stringify(obj), ctx || running, msg || '') }
  // chat, in a code fence, "[Iris]" dropped from the reply (Iris adds it)
  const d1 = p('Sure!\n```json\n{"action":"chat","reply":"[Iris] Hey! 22 applied today."}\n```', running, 'hi iris how are you')
  assert.strictEqual(d1.action, 'chat')
  assert.strictEqual(d1.reply, 'Hey! 22 applied today.')
  // a link must be one the user wrote
  const d2 = p({ action: 'apply_link', url: 'https://made.up/job', reply: 'On it' }, running, 'found this https://jobs.lever.co/acme/123 apply pls')
  assert.strictEqual(d2.url, 'https://jobs.lever.co/acme/123')
  assert.strictEqual(d2.when, 'next')
  // "pause this and do this first"
  const d3 = p({ action: 'apply_link', url: 'https://jobs.lever.co/acme/9', when: 'now', reply: 'Doing it now' }, running, 'pause that and do this first https://jobs.lever.co/acme/9')
  assert.strictEqual(d3.when, 'now')
  // apply_link without any link is a task
  assert.strictEqual(p({ action: 'apply_link', reply: 'ok' }, running, 'apply to the Tesla job').action, 'task')
  // an answer with no question waiting is a task; a code with no code waiting is chat
  assert.strictEqual(p({ action: 'answer', answer: 'Jan 2027', reply: 'ok' }, running, 'Jan 2027').action, 'task')
  assert.strictEqual(p({ action: 'answer', reply: 'ok' }, Object.assign({}, running, { question: 'Start date?' }), 'January 2027').answer, 'January 2027')
  assert.strictEqual(p({ action: 'code', code: '123456', reply: 'ok' }, running, '123456').action, 'chat')
  assert.strictEqual(p({ action: 'code', code: '123456', reply: 'ok' }, Object.assign({}, running, { codeFor: 'TikTok' }), 'here 123 456').code, '123456')
  assert.strictEqual(p({ action: 'code', code: '999999', reply: 'ok' }, Object.assign({}, running, { codeFor: 'TikTok' }), 'here 123456').action, 'chat', 'a code the user did not write is not used')
  // a note to self
  assert.strictEqual(p({ action: 'none', reply: '' }, running, 'buy milk').action, 'none')
  // nothing usable: null (the fixed rules take over)
  assert.strictEqual(p('I think the user wants status', running, 'status'), null)
  assert.strictEqual(p({ action: 'dance' }, running, 'x'), null)
  // a task keeps the user's words when the model gives none, and always has a reply
  const d4 = p({ action: 'task' }, running, 'check my gmail for interview invites')
  assert.strictEqual(d4.task, 'check my gmail for interview invites')
  assert.ok(d4.reply)
  // a reply under another name is still the reply; chat with no reply is left empty (Iris sends the status instead)
  assert.strictEqual(p({ action: 'chat', response: 'Hey there!' }, running, 'hi iris').reply, 'Hey there!')
  assert.strictEqual(p({ action: 'chat' }, running, 'hi iris').reply, '')
})

test('"now" only when the user says so; a task with a job link is the user\'s job', () => {
  const p = function (obj, msg) { return c.parseDecision(JSON.stringify(obj), running, msg) }
  assert.strictEqual(p({ action: 'task', task: 'Check Gmail', when: 'now', reply: 'ok' }, 'check my gmail for interview invites').when, 'next')
  assert.strictEqual(p({ action: 'task', task: 'Check Gmail', when: 'now', reply: 'ok' }, 'check my gmail right now').when, 'now')
  const d = p({ action: 'task', task: 'Apply to this job: https://jobs.lever.co/acme/123', url: 'https://jobs.lever.co/acme/123', when: 'now', reply: 'ok' }, 'pause this one and work on this first https://jobs.lever.co/acme/123')
  assert.strictEqual(d.action, 'apply_link')
  assert.strictEqual(d.url, 'https://jobs.lever.co/acme/123')
  assert.strictEqual(d.when, 'now')
  assert.strictEqual(p({ action: 'task', task: 'Summarise https://example.com/post', reply: 'ok' }, 'summarise https://example.com/post').action, 'task', 'a page to read is not a job')
  assert.ok(c.addressesIris('hi iris how are you') && c.addressesIris('Hey Iris, how many today?'))
  assert.ok(!c.addressesIris('buy milk and eggs') && !c.addressesIris('irish stew'))
  // a question to "you" about the work, with no "Iris" in it (10-28: it got no answer)
  assert.ok(c.addressesIris('Just quick question how many application have you submitted and how many LinkedIn connections'))
  assert.ok(c.addressesIris('did you apply to anything in Texas?'))
  assert.ok(!c.addressesIris('apply to the Google job tomorrow') && !c.addressesIris('call mom, ask how you feel'))
})
