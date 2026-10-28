'use strict'

const test = require('node:test')
const assert = require('node:assert')

test('a step on a site with a saved account says so in the observation', () => {
  const p = require('../iris/agent/prompts')
  const t = p.observationIntro({ url: 'https://hpe.wd5.myworkdayjobs.com/x', title: 'Sign In', width: 10, height: 10, siteAccount: 'Saved account for this site: me@x.com — sign in with it and {{account:hpe.wd5.myworkdayjobs.com}}; never make a new account here.' }, 3)
  assert.match(t, /Saved account for this site: me@x\.com/)
})
