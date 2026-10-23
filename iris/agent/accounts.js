'use strict'

/*
 * iris/agent/accounts.js — the accounts Iris made (iris-accounts.json), kept so no working password is lost.
 *
 * A record has the password in use (`password`), the one it replaced (`previous`), and a password made for a
 * sign-up the site has not accepted yet (`pending`). A password typed into a Create Account form for a site that
 * already has a record stays pending until the site shows the account was made (save_account, or the model
 * reading "account created"). A real night saved each new password the moment it was typed, then again from the
 * sign-up watcher — the second save copied it into `previous` too — so when the site said the email was taken,
 * {{account:site}} typed a password the site never had, and the one that worked was gone.
 *
 * Pure: the caller encrypts and decrypts stored passwords (opts.encrypt, opts.decrypt) and reads a password kept
 * in My info (opts.current(record) → the plain password in use).
 */

function siteKey (site) {
  return String(site || '').trim().toLowerCase().replace(/^www\./, '')
}

function currentOf (record, opts) {
  return (opts.current ? opts.current(record) : opts.decrypt(record.password)) || ''
}

/**
 * The list after saving rec ({ site, username, password, url, title, purpose, unconfirmed }).
 * password is plain text, or a {{Label}} from My info. unconfirmed: made for a sign-up the site has not accepted yet.
 */
function saveAccount (list, rec, opts) {
  const now = opts.now ? opts.now() : Date.now()
  const old = list.find(function (a) { return a.site === rec.site && a.username === rec.username })
  const rest = list.filter(function (a) { return a !== old })
  const pw = String(rec.password || '')
  const ref = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(pw)
  const fresh = !ref && !!rec.unconfirmed
  if (!old) {
    return rest.concat(Object.assign({
      site: rec.site,
      username: rec.username,
      url: rec.url || '',
      // a placeholder points at My info; anything else is kept encrypted like other secrets
      passwordRef: ref ? ref[1] : null,
      password: ref ? '' : opts.encrypt(pw),
      title: String(rec.title || '').slice(0, 120),
      purpose: String(rec.purpose || '').slice(0, 200),
      created: now
    }, fresh ? { unconfirmed: true } : {}))
  }
  const next = Object.assign({}, old, {
    url: rec.url || old.url || '',
    title: String(rec.title || old.title || '').slice(0, 120),
    purpose: String(rec.purpose || old.purpose || '').slice(0, 200)
  })
  const current = currentOf(old, opts)
  const pending = old.pending ? opts.decrypt(old.pending) : ''
  if (!ref && pw && pw === current) {
    // the same password again: nothing is replaced, and the earlier one stays in `previous`
    if (!fresh) delete next.unconfirmed
    if (pending === pw) { delete next.pending; delete next.pendingCreated }
    return rest.concat(next)
  }
  if (fresh) {
    // the password that works stays in use until the site takes the new one
    if (pw !== pending) { next.pending = opts.encrypt(pw); next.pendingCreated = now }
    return rest.concat(next)
  }
  // a new password in use: the one it replaces is kept
  if (old.password) { next.previous = old.password; next.previousCreated = old.created }
  next.passwordRef = ref ? ref[1] : null
  next.password = ref ? '' : opts.encrypt(pw)
  next.created = !ref && pending && pw === pending ? old.pendingCreated || now : now
  if (!ref && pending && pw === pending) { delete next.pending; delete next.pendingCreated }
  delete next.unconfirmed
  return rest.concat(next)
}

/**
 * The site showed the account was made with pw: every record there that has pw pending (or in use, not yet
 * confirmed) now uses it. { list, changed }
 */
function confirmPassword (list, site, pw, opts) {
  let out = list
  let changed = false
  list.filter(function (a) { return siteKey(a.site) === siteKey(site) }).forEach(function (a) {
    const pending = a.pending ? opts.decrypt(a.pending) : ''
    if (pw && (pending === pw || (a.unconfirmed && currentOf(a, opts) === pw))) {
      out = saveAccount(out, { site: a.site, username: a.username, password: pw }, opts)
      changed = true
    }
  })
  return { list: out, changed: changed }
}

/** The record {{account:site}} names. */
function findSite (list, site) {
  return list.find(function (a) { return siteKey(a.site) === siteKey(site) }) || null
}

/** Its passwords in the order a sign-in tries them: in use, made for a sign-up, the one before. */
function passwords (record, opts) {
  if (!record) return []
  const all = [currentOf(record, opts), record.pending ? opts.decrypt(record.pending) : '', record.previous ? opts.decrypt(record.previous) : '']
  return all.filter(function (p, i) { return p && all.indexOf(p) === i })
}

/** {{account:site}} or {{account:site#2}} → { site, n }; the first one in text. */
function accountRef (text) {
  const m = /\{\{\s*account:\s*([^}#]+?)\s*(?:#\s*(\d+)\s*)?\}\}/i.exec(String(text || ''))
  return m ? { site: siteKey(m[1]), n: Math.max(1, Number(m[2]) || 1) } : null
}

/* What the model read on the screen (Iris reads no page text): its thought is the only signal. */

/** The site says this email already has an account. */
function emailTaken (thought) {
  return /\balready (been )?(registered|in use|exists?|taken|associated|used|signed up|on file|ha(s|ve) an account)\b|\b(e-?mail|username|address|account) (address )?(is|was) (already )?taken\b|\baccount (with (this|that|the) (e-?mail|address) )?already exists\b/i.test(String(thought || ''))
}

/** The site shows the account was made (or sent its email check, which it does only for a new account). */
function accountCreated (thought) {
  const t = String(thought || '')
  if (emailTaken(t)) return false
  return /\baccount (has been |was |is )?(successfully )?(created|registered)\b|\b(successfully|just) (created|registered|signed up)\b|\b(verification|confirmation|activation) (e-?mail|link|code)\b[^.]{0,20}\b(sent|was sent|has been sent)\b|\bsent (me |you |us )?(a |an )?(verification|confirmation|activation) (e-?mail|link|code)\b/i.test(t)
}

/** A sign-in was refused: wrong password, or the account locked. */
function signInRefused (thought) {
  const t = String(thought || '')
  return /\b(password|credentials)\b[^.]{0,40}\b(incorrect|wrong|invalid|not (correct|right|valid|recogni[sz]ed|accepted)|is ?n['o]t (correct|right|valid)|does ?n['o]t match|did ?n['o]t work|refused|rejected|failed)\b/i.test(t) ||
    /\b(incorrect|wrong|invalid)\b[^.]{0,20}\b(password|credentials)\b/i.test(t) ||
    /\b(sign[ -]?in|log[ -]?in|login)( attempt)? (has |was )?(failed|refused|rejected|unsuccessful|did ?n['o]t work)\b/i.test(t) ||
    /\b(could ?n['o]t|unable to|failed to) (sign|log)[ -]?in\b/i.test(t) ||
    /\baccount (is |has been |was )?(now )?(temporarily )?locked\b/i.test(t)
}

module.exports = { saveAccount, confirmPassword, findSite, passwords, accountRef, emailTaken, accountCreated, signInRefused, siteKey }
