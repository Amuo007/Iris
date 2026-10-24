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
 * Every password a record had before those three is kept in `history` (newest first), never dropped: a pending
 * password replaced by another may be the one a late email set, and a third password in use used to push the
 * first out of `previous`. What the site said last is kept too: `refused` (no kept password worked), `noAccount`
 * (the site knows no account for that email: a sign-up that never finished), `confirmed` (the site took it).
 *
 * Pure: the caller encrypts and decrypts stored passwords (opts.encrypt, opts.decrypt) and reads a password kept
 * in My info (opts.current(record) → the plain password in use).
 */

const HISTORY_MAX = 20

function siteKey (site) {
  return String(site || '').trim().toLowerCase().replace(/^www\./, '')
}

function currentOf (record, opts) {
  return (opts.current ? opts.current(record) : opts.decrypt(record.password)) || ''
}

/* next.history with enc (an encrypted password) added in front, unless the record already keeps that password */
function withHistory (next, enc, created, opts) {
  const plain = enc ? opts.decrypt(enc) : ''
  if (!plain) return next.history
  const held = [next.passwordRef ? '' : opts.decrypt(next.password), next.pending ? opts.decrypt(next.pending) : '', next.previous ? opts.decrypt(next.previous) : '']
    .concat((next.history || []).map(function (h) { return opts.decrypt(h.password) }))
  if (held.indexOf(plain) >= 0) return next.history
  return [{ password: enc, created: created || 0 }].concat(next.history || []).slice(0, HISTORY_MAX)
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
    // the password that works stays in use until the site takes the new one; a pending one it replaces is kept
    if (pw !== pending) {
      if (old.pending) next.history = withHistory(Object.assign({}, next, { pending: '' }), old.pending, old.pendingCreated, opts)
      next.pending = opts.encrypt(pw)
      next.pendingCreated = now
    }
    return rest.concat(next)
  }
  // a new password in use: the one it replaces is kept, and the one before that goes to history
  if (old.previous && opts.decrypt(old.previous) !== pw) next.history = withHistory(Object.assign({}, next, { previous: '' }), old.previous, old.previousCreated, opts)
  if (old.password) { next.previous = old.password; next.previousCreated = old.created }
  next.passwordRef = ref ? ref[1] : null
  next.password = ref ? '' : opts.encrypt(pw)
  next.created = !ref && pending && pw === pending ? old.pendingCreated || now : now
  if (!ref && pending && pw === pending) { delete next.pending; delete next.pendingCreated }
  if (!next.history || !next.history.length) delete next.history
  delete next.unconfirmed
  // a password put in use by hand or by the site: what the site said about the old one no longer holds
  delete next.refused
  delete next.noAccount
  return rest.concat(next)
}

/**
 * What the site said about the record for site + username: fields with a time (refused, noAccount, confirmed),
 * or null to clear one. The list unchanged when there is no such record.
 */
function markAccount (list, site, username, fields) {
  return list.map(function (a) {
    if (siteKey(a.site) !== siteKey(site) || (username && a.username !== username)) return a
    const next = Object.assign({}, a)
    Object.keys(fields).forEach(function (k) {
      if (fields[k] === null || fields[k] === undefined) delete next[k]
      else next[k] = fields[k]
    })
    return next
  })
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
      out = markAccount(out, a.site, a.username, { confirmed: opts.now ? opts.now() : Date.now(), refused: null, noAccount: null })
      changed = true
    }
  })
  return { list: out, changed: changed }
}

/** The record {{account:site}} names. */
function findSite (list, site) {
  return list.find(function (a) { return siteKey(a.site) === siteKey(site) }) || null
}

/** Its passwords in the order a sign-in tries them: in use, made for a sign-up, the one before, then older ones. */
function passwords (record, opts) {
  if (!record) return []
  const all = [currentOf(record, opts), record.pending ? opts.decrypt(record.pending) : '', record.previous ? opts.decrypt(record.previous) : '']
    .concat((record.history || []).map(function (h) { return h && h.password ? opts.decrypt(h.password) : '' }))
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

/**
 * The site knows no account for the email typed: a saved sign-up never finished there (a real night: Energy Transfer's
 * Taleo said the saved email "does not correspond to a registered user", and Iris gave up instead of signing up).
 * "Email or password not recognised" is a refused password, not this.
 */
function noSuchAccount (thought) {
  const t = String(thought || '')
  return /\bdo(es)? ?n['o]t correspond to (a|any) registered\b/i.test(t) ||
    /\bnot (a )?registered (user|e-?mail|account|member)\b/i.test(t) ||
    /\bno (such )?(account|user)\b[^.]{0,30}\b(found|exists?|matches|with (this|that|the|your))\b/i.test(t) ||
    /\bcould ?n['o]t find (an |any |your |that |the )?(account|user)\b/i.test(t) ||
    /\b(user|account|e-?mail( address)?|username)\b(?:(?!password)[^.]){0,25}\b(not found|does ?n['o]t exist|is ?n['o]t registered|not recogni[sz]ed)\b/i.test(t)
}

/** The site shows a new password was set (after "Forgot password"). */
function passwordChanged (thought) {
  const t = String(thought || '')
  return /\bpassword (has been|was|is now) (successfully )?(reset|changed|updated)\b/i.test(t) ||
    /\bpassword (reset|change|update) (was |is )?(successful|complete)\b/i.test(t) ||
    /\bsuccessfully (reset|changed|updated) (the |your |my )?password\b/i.test(t) ||
    /\bnew password (has been |was )(saved|set|accepted)\b/i.test(t)
}

module.exports = { saveAccount, confirmPassword, markAccount, findSite, passwords, accountRef, emailTaken, accountCreated, signInRefused, noSuchAccount, passwordChanged, siteKey }
