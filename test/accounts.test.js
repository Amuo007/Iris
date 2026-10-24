'use strict'

const test = require('node:test')
const assert = require('node:assert')

const { saveAccount, confirmPassword, markAccount, findSite, passwords, accountRef, emailTaken, accountCreated, signInRefused, noSuchAccount, passwordChanged } = require('../iris/agent/accounts')

// stand-ins for the keychain: stored text never equals the password, and two saves of one password match
let clock = 1000
const opts = {
  encrypt: function (s) { return s ? 'enc:' + Buffer.from(s).toString('base64') : '' },
  decrypt: function (s) { return s && s.indexOf('enc:') === 0 ? Buffer.from(s.slice(4), 'base64').toString() : '' },
  now: function () { return ++clock }
}
const site = 'hp.wd5.myworkdayjobs.com'
const user = 'me@example.com'

function one (list) {
  assert.strictEqual(list.length, 1)
  return list[0]
}

function working () {
  // an account that has worked: A in use, P the one before
  return saveAccount(saveAccount([], { site, username: user, password: 'P' }, opts), { site, username: user, password: 'A' }, opts)
}

test('saving the password already in use keeps the earlier one', () => {
  const list = working()
  const before = one(list)
  assert.strictEqual(opts.decrypt(before.previous), 'P')
  const after = one(saveAccount(list, { site, username: user, password: 'A', url: 'https://x.test/signin' }, opts))
  assert.strictEqual(opts.decrypt(after.password), 'A')
  assert.strictEqual(opts.decrypt(after.previous), 'P')
  assert.strictEqual(after.previousCreated, before.previousCreated)
  assert.strictEqual(after.url, 'https://x.test/signin')
})

test('a new password made on Create Account stays pending: {{account:site}} still types the one that works', () => {
  // the real sequence: saved when {{New password}} is typed, then again by the sign-up watcher, then for "confirm password"
  let list = working()
  for (let i = 0; i < 3; i++) list = saveAccount(list, { site, username: user, password: 'B', unconfirmed: true }, opts)
  const a = one(list)
  assert.strictEqual(opts.decrypt(a.password), 'A')
  assert.strictEqual(opts.decrypt(a.pending), 'B')
  assert.strictEqual(opts.decrypt(a.previous), 'P')
  assert.deepStrictEqual(passwords(findSite(list, site), opts), ['A', 'B', 'P'])
})

test('the site shows the account was made: the pending password goes in use, the old one is kept', () => {
  let list = saveAccount(working(), { site, username: user, password: 'B', unconfirmed: true }, opts)
  const pendingCreated = one(list).pendingCreated
  const r = confirmPassword(list, 'www.' + site, 'B', opts)
  assert.ok(r.changed)
  list = r.list
  const a = one(list)
  assert.strictEqual(opts.decrypt(a.password), 'B')
  assert.strictEqual(opts.decrypt(a.previous), 'A')
  assert.strictEqual(a.created, pendingCreated)
  assert.strictEqual(a.pending, undefined)
  // confirming again changes nothing and loses nothing
  const again = confirmPassword(list, site, 'B', opts)
  assert.ok(!again.changed)
  assert.strictEqual(opts.decrypt(one(saveAccount(list, { site, username: user, password: 'B' }, opts)).previous), 'A')
})

test('save_account with the made password confirms it the same way', () => {
  const list = saveAccount(saveAccount(working(), { site, username: user, password: 'B', unconfirmed: true }, opts), { site, username: user, password: 'B' }, opts)
  const a = one(list)
  assert.strictEqual(opts.decrypt(a.password), 'B')
  assert.strictEqual(opts.decrypt(a.previous), 'A')
  // P, the one before A, is no longer dropped: it goes to history
  assert.deepStrictEqual(passwords(a, opts), ['B', 'A', 'P'])
})

test('a first account is saved at once, marked unconfirmed until the site accepts it', () => {
  let list = saveAccount([], { site, username: user, password: 'B', unconfirmed: true }, opts)
  list = saveAccount(list, { site, username: user, password: 'B', unconfirmed: true }, opts)
  let a = one(list)
  assert.strictEqual(opts.decrypt(a.password), 'B')
  assert.strictEqual(a.unconfirmed, true)
  assert.strictEqual(a.previous, undefined)
  assert.strictEqual(a.pending, undefined)
  a = one(confirmPassword(list, site, 'B', opts).list)
  assert.strictEqual(a.unconfirmed, undefined)
  assert.strictEqual(a.previous, undefined)
})

test('a different password put in use moves the current one to previous', () => {
  const a = one(saveAccount(working(), { site, username: user, password: 'C' }, opts))
  assert.strictEqual(opts.decrypt(a.password), 'C')
  assert.strictEqual(opts.decrypt(a.previous), 'A')
})

test('the kept password that worked after a refusal ({{account:site#2}}) becomes the one in use', () => {
  const a = one(saveAccount(working(), { site, username: user, password: 'P' }, opts))
  assert.strictEqual(opts.decrypt(a.password), 'P')
  assert.strictEqual(opts.decrypt(a.previous), 'A')
})

test('a pending password is not replaced by the same one again, nor kept twice', () => {
  const once = one(saveAccount(working(), { site, username: user, password: 'B', unconfirmed: true }, opts))
  const twice = one(saveAccount([once], { site, username: user, password: 'B', unconfirmed: true }, opts))
  assert.strictEqual(twice.pendingCreated, once.pendingCreated)
  // made for a sign-up, but it is the one already in use
  const same = one(saveAccount(working(), { site, username: user, password: 'A', unconfirmed: true }, opts))
  assert.strictEqual(same.pending, undefined)
  assert.strictEqual(opts.decrypt(same.previous), 'P')
})

test('records hurt by the old double save (previous = password) offer the password once', () => {
  const a = { site, username: user, password: opts.encrypt('B'), previous: opts.encrypt('B'), created: 1 }
  assert.deepStrictEqual(passwords(a, opts), ['B'])
  assert.deepStrictEqual(passwords(null, opts), [])
})

test('a My info password ({{Password}}) is read through opts.current', () => {
  const withRef = Object.assign({}, opts, { current: function (r) { return r.passwordRef ? 'MINE' : opts.decrypt(r.password) } })
  let list = saveAccount([], { site, username: user, password: '{{Password}}' }, withRef)
  assert.strictEqual(one(list).passwordRef, 'Password')
  list = saveAccount(list, { site, username: user, password: 'B', unconfirmed: true }, withRef)
  assert.deepStrictEqual(passwords(one(list), withRef), ['MINE', 'B'])
})

test('other sites and users are left alone', () => {
  let list = saveAccount(working(), { site: 'other.test', username: user, password: 'Z' }, opts)
  list = saveAccount(list, { site, username: 'someone@else.test', password: 'Y', unconfirmed: true }, opts)
  assert.strictEqual(list.length, 3)
  const r = confirmPassword(list, site, 'Q', opts)
  assert.ok(!r.changed)
  assert.strictEqual(findSite(list, 'WWW.Other.Test').site, 'other.test')
})

test('{{account:site}} and {{account:site#2}} name a site and which kept password', () => {
  assert.deepStrictEqual(accountRef('{{account:www.HP.wd5.myworkdayjobs.com}}'), { site: 'hp.wd5.myworkdayjobs.com', n: 1 })
  assert.deepStrictEqual(accountRef('pw: {{ account: ea.com #2 }} then Enter'), { site: 'ea.com', n: 2 })
  assert.strictEqual(accountRef('{{Password}}'), null)
  assert.strictEqual(accountRef('{{New password}}'), null)
})

test('the site saying the email is taken', () => {
  for (const t of [
    'The page says "An account with this email already exists". I will sign in instead.',
    'Error: this email address is already registered.',
    'The email is already in use, so I should sign in.',
    'It says I already have an account.',
    'The email is taken.'
  ]) assert.ok(emailTaken(t), t)
  for (const t of [
    'An account for this site was already saved, so I will sign in with it.',
    'I already applied to this job.',
    'I need to create an account first.'
  ]) assert.ok(!emailTaken(t), t)
})

test('the site showing the account was made', () => {
  for (const t of [
    'Account created successfully. Now I need to sign in.',
    'The account has been created; Workday sent me to Sign In.',
    'A verification email has been sent to my address.',
    'The site sent a verification link.'
  ]) assert.ok(accountCreated(t), t)
  for (const t of [
    'I need to create an account first.',
    'The account was not created: the password needs a symbol.',
    'An account with this email already exists, and a verification email was sent.',
    'I will click Create Account.'
  ]) assert.ok(!accountCreated(t), t)
})

test('a refused sign-in', () => {
  for (const t of [
    'The sign in failed: "Incorrect email or password".',
    'The password is incorrect.',
    'Wrong password — the site shows an error.',
    'Invalid credentials.',
    'Login was unsuccessful.',
    'I could not sign in with the saved password.',
    'The account is temporarily locked.'
  ]) assert.ok(signInRefused(t), t)
  for (const t of [
    'I will sign in with the saved password.',
    'Clicking the Sign In button.',
    'The email field is invalid; fixing it.',
    'Signed in. Now the application form.'
  ]) assert.ok(!signInRefused(t), t)
})

test('no password is ever dropped: older ones go to history, newest first, and are still offered', () => {
  // P, then A, then C, then D in use: P and A used to be lost when previous moved on
  let list = saveAccount(working(), { site, username: user, password: 'C' }, opts)
  list = saveAccount(list, { site, username: user, password: 'D' }, opts)
  const a = one(list)
  assert.strictEqual(opts.decrypt(a.password), 'D')
  assert.strictEqual(opts.decrypt(a.previous), 'C')
  assert.deepStrictEqual(a.history.map(h => opts.decrypt(h.password)), ['A', 'P'])
  assert.deepStrictEqual(passwords(a, opts), ['D', 'C', 'A', 'P'])
  // going back to one in history keeps all of them
  const back = one(saveAccount(list, { site, username: user, password: 'P' }, opts))
  assert.deepStrictEqual(passwords(back, opts).slice().sort(), ['A', 'C', 'D', 'P'])
})

test('a pending password replaced by another pending one is kept (a late email may have set it)', () => {
  let list = saveAccount(working(), { site, username: user, password: 'B', unconfirmed: true }, opts)
  list = saveAccount(list, { site, username: user, password: 'E', unconfirmed: true }, opts)
  const a = one(list)
  assert.strictEqual(opts.decrypt(a.password), 'A')
  assert.strictEqual(opts.decrypt(a.pending), 'E')
  assert.deepStrictEqual(passwords(a, opts), ['A', 'E', 'P', 'B'])
})

test('the broken double-save records keep their one password, once', () => {
  const broken = [{ site, username: user, password: opts.encrypt('B'), previous: opts.encrypt('B'), created: 1, previousCreated: 1 }]
  const a = one(saveAccount(broken, { site, username: user, password: 'R' }, opts))
  assert.deepStrictEqual(passwords(a, opts), ['R', 'B'])
  assert.strictEqual(a.history, undefined)
})

test('what the site said is kept on the record, and cleared once a password is put in use', () => {
  let list = markAccount(working(), 'www.' + site, user, { refused: 5 })
  assert.strictEqual(one(list).refused, 5)
  // other sites untouched; a pending save does not clear it (the site has not taken that one yet)
  assert.strictEqual(markAccount(list, 'other.test', user, { refused: 9 })[0].refused, 5)
  list = saveAccount(list, { site, username: user, password: 'N', unconfirmed: true }, opts)
  assert.strictEqual(one(list).refused, 5)
  // the reset password put in use: refused and noAccount go, every old password stays
  list = saveAccount(markAccount(list, site, user, { noAccount: 6 }), { site, username: user, password: 'R' }, opts)
  const a = one(list)
  assert.strictEqual(a.refused, undefined)
  assert.strictEqual(a.noAccount, undefined)
  assert.deepStrictEqual(passwords(a, opts).slice().sort(), ['A', 'N', 'P', 'R'])
  // null clears a field
  assert.strictEqual(one(markAccount(markAccount(list, site, null, { confirmed: 7 }), site, user, { confirmed: null })).confirmed, undefined)
})

test('a sign-up the site accepts is marked confirmed', () => {
  const list = saveAccount(markAccount(working(), site, user, { noAccount: 3 }), { site, username: user, password: 'B', unconfirmed: true }, opts)
  const a = one(confirmPassword(list, site, 'B', opts).list)
  assert.ok(a.confirmed > 0)
  assert.strictEqual(a.noAccount, undefined)
  assert.strictEqual(opts.decrypt(a.password), 'B')
})

test('the site has no account for that email', () => {
  for (const t of [
    "Saved Energy Transfer account refused ('does not correspond to a registered user'); fields cleared.",
    'The site says this email is not a registered user.',
    'No account found with that email address.',
    'There is no account with this email.',
    'Error: user not found.',
    "We couldn't find an account with that email.",
    'The email address is not registered.'
  ]) assert.ok(noSuchAccount(t), t)
  for (const t of [
    'Invalid email or password.',
    'Email or password not recognized.',
    "Don't have an account? Sign up — I will sign in instead.",
    'No account yet? Create one. I have a saved account, so I sign in.',
    'The password is incorrect.'
  ]) assert.ok(!noSuchAccount(t), t)
})

test('the site shows a new password was set', () => {
  for (const t of [
    'Your password has been reset. Sign in now.',
    'The password was changed successfully.',
    'Password reset successful.',
    'I successfully reset the password; now signing in.',
    'The new password has been saved.'
  ]) assert.ok(passwordChanged(t), t)
  for (const t of [
    'I will click Forgot password to reset it.',
    'The password reset email has not arrived yet.',
    'The account was not created: the password needs a symbol.',
    'Open the password reset link from the email.',
    'I need to reset the password.'
  ]) assert.ok(!passwordChanged(t), t)
})
