'use strict'

const test = require('node:test')
const assert = require('node:assert')
const ch = require('../iris/agent/channels')

const MIN = 60 * 1000
const T0 = Date.UTC(2026, 9, 24, 17, 0)
const tiktok = { company: 'TikTok', title: 'Backend Engineer Graduate (Social Foundation)', what: 'TikTok sent a 6-digit code to your phone', url: 'https://lifeattiktok.com/resume/1/apply', tabId: 7 }

test('numbers and chat addresses', () => {
  assert.strictEqual(ch.normalizeNumber('+1 (832) 263-4489'), '18322634489')
  assert.strictEqual(ch.normalizeNumber('0091 98765 43210'), '919876543210')
  assert.strictEqual(ch.normalizeNumber('12345'), '', 'too short to be a phone number')
  assert.strictEqual(ch.jidFor('+1 832 263 4489'), '18322634489@s.whatsapp.net')
  assert.strictEqual(ch.phoneOf('18322634489:12@s.whatsapp.net'), '18322634489')
  assert.strictEqual(ch.phoneOf('123456789012345@lid'), '', 'a hidden-number address carries no phone number')
})

test('only the user\'s own number is listened to', () => {
  const user = '+1 832 263 4489'
  assert.ok(ch.isFromUser({ remoteJid: '18322634489@s.whatsapp.net' }, user))
  // WhatsApp may name the sender by a hidden id and give the number only as the alternative address
  assert.ok(ch.isFromUser({ remoteJid: '98765432101234@lid', remoteJidAlt: '18322634489@s.whatsapp.net' }, user))
  assert.ok(!ch.isFromUser({ remoteJid: '98765432101234@lid' }, user), 'not provably the user: ignored')
  assert.ok(!ch.isFromUser({ remoteJid: '15550001111@s.whatsapp.net' }, user), 'someone else')
  assert.ok(!ch.isFromUser({ remoteJid: '18322634489@s.whatsapp.net', fromMe: true }, user), 'Iris\'s own message')
  assert.ok(!ch.isFromUser({ remoteJid: '18322634489@s.whatsapp.net' }, ''), 'no number set: nobody')
  assert.strictEqual(ch.messageText({ conversation: ' 482913 ' }), '482913')
  assert.strictEqual(ch.messageText({ extendedTextMessage: { text: 'code 482913' } }), 'code 482913')
  assert.strictEqual(ch.messageText({ imageMessage: {} }), '')
})

test('the code is read from the reply, and nothing is guessed', () => {
  assert.strictEqual(ch.extractCode('482913'), '482913')
  assert.strictEqual(ch.extractCode('482 913'), '482913')
  assert.strictEqual(ch.extractCode('482-913'), '482913')
  assert.strictEqual(ch.extractCode('code: 482913'), '482913')
  assert.strictEqual(ch.extractCode('the code is 482913, thanks'), '482913')
  assert.strictEqual(ch.extractCode('5X1D22yy'), '5X1D22yy', 'an email code with letters')
  assert.strictEqual(ch.extractCode('ok'), null)
  assert.strictEqual(ch.extractCode('hello there'), null, 'no digits: not a code')
  assert.strictEqual(ch.extractCode('482913 or 551204'), null, 'two codes: not guessed')
  assert.strictEqual(ch.extractCode('12'), null)
})

test('the message is written from the request only, in one line per part', () => {
  const t = ch.codeRequestText(Object.assign({}, tiktok, { title: 'Backend\nEngineer' }))
  assert.ok(t.startsWith('[Iris] TikTok — Backend Engineer: TikTok sent a 6-digit code to your phone.'))
  assert.ok(/within 15 minutes/.test(t))
  assert.ok(!/https?:/.test(t), 'no links in the message')
})

test('one request at a time, one per job, a few an hour', () => {
  const r1 = ch.newRequest(tiktok, T0, 'a')
  assert.ok(ch.canAsk([], tiktok, T0).ok)
  assert.ok(!ch.canAsk([r1], tiktok, T0 + MIN).ok, 'already waiting for this job')
  const other = { company: 'ByteDance', title: 'SWE Graduate', what: 'code to your phone' }
  assert.match(ch.canAsk([r1], other, T0 + MIN).reason, /one at a time/)
  // once the first one has timed out, the next job may ask
  assert.ok(ch.canAsk([r1], other, T0 + 16 * MIN).ok)
  const hour = []
  for (let i = 0; i < ch.PER_HOUR; i++) hour.push(Object.assign(ch.newRequest({ company: 'C' + i, title: 'T' }, T0 + i * MIN, String(i)), { state: 'answered' }))
  assert.match(ch.canAsk(hour, other, T0 + 30 * MIN).reason, /times this hour/)
  assert.ok(ch.canAsk(hour, other, T0 + 61 * MIN + ch.PER_HOUR * MIN).ok, 'a new hour')
})

test('a reply answers the open request; a late one is told so', () => {
  const r1 = ch.newRequest(tiktok, T0, 'a')
  const m = ch.matchReply([r1], '482913', T0 + 3 * MIN)
  assert.strictEqual(m.request, r1)
  assert.strictEqual(m.code, '482913')
  const noCode = ch.matchReply([r1], 'hi', T0 + 3 * MIN)
  assert.strictEqual(noCode.request, r1)
  assert.strictEqual(noCode.code, null)
  // timed out and told: a code now is late
  const expired = Object.assign({}, r1, { state: 'expired' })
  assert.strictEqual(ch.matchReply([expired], '482913', T0 + 20 * MIN).late, expired)
  assert.deepStrictEqual(ch.matchReply([], '482913', T0), {})
  assert.deepStrictEqual(ch.matchReply([Object.assign({}, r1, { state: 'answered' })], '482913', T0 + 5 * MIN), {}, 'already used')
})

test('requests time out after 15 minutes and old ones are dropped', () => {
  const r1 = ch.newRequest(tiktok, T0, 'a')
  assert.deepStrictEqual(ch.dueToExpire([r1], T0 + 14 * MIN), [])
  assert.deepStrictEqual(ch.dueToExpire([r1], T0 + 15 * MIN), [r1])
  const done = Object.assign({}, r1, { state: 'expired' })
  assert.strictEqual(ch.prune([done], T0 + 23 * 60 * MIN).length, 1)
  assert.strictEqual(ch.prune([done], T0 + 25 * 60 * MIN).length, 0)
})

test('what the model is told names the code and the tab to go to', () => {
  const r1 = ch.newRequest(tiktok, T0, 'a')
  const note = ch.codeArrivedNote(r1, '482913', 3)
  assert.ok(/482913/.test(note) && /switch_tab 3/.test(note) && /TikTok — Backend Engineer Graduate/.test(note))
  assert.ok(/open https:\/\/lifeattiktok\.com\/resume\/1\/apply again/.test(ch.codeArrivedNote(r1, '482913', 0)), 'tab closed: the link instead')
  assert.ok(/log that job needs_you/.test(ch.codeExpiredNote(r1, 3)) && /Close tab 3/.test(ch.codeExpiredNote(r1, 3)))
})
