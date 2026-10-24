'use strict'

/*
 * iris/agent/accountsStore.js — iris-accounts.json on disk, written so a saved sign-in is never lost.
 *
 *  - Every write first copies the file as it was into iris-accounts-backups/ next to it (the newest 200 copies,
 *    and the last copy of every day, for good).
 *  - The new list goes to a temporary file that is then renamed over the old one: a crash halfway leaves the old
 *    file whole (a half-written file used to read as "no accounts", and the next save kept only the new one).
 *  - A write that would drop a saved sign-in is refused, unless that one is being deleted on purpose (Settings).
 *  - A file that cannot be read is not taken as "no accounts": the newest backup that reads is used instead.
 */

const fs = require('fs')
const path = require('path')

const KEEP_NEWEST = 200
const NAME = /^iris-accounts-(\d{8})-(\d{6})(-\d+)?\.json$/

function backupsDir (file) {
  return path.join(path.dirname(file), 'iris-accounts-backups')
}

function parse (text) {
  const d = JSON.parse(text)
  if (!d || !Array.isArray(d.accounts)) throw new Error('no accounts list in it')
  return d.accounts
}

/* the backup copies, oldest first */
function backups (file) {
  const dir = backupsDir(file)
  let names = []
  try { names = fs.readdirSync(dir).filter(function (n) { return NAME.test(n) }) } catch (e) { names = [] }
  // by time, then by the number a second copy in the same second gets ("…-000000.json" before "…-000000-2.json")
  const order = function (n) { const m = NAME.exec(n); return m[1] + m[2] + String(m[3] ? Number(m[3].slice(1)) : 1).padStart(4, '0') }
  names.sort(function (x, y) { return order(x) < order(y) ? -1 : order(x) > order(y) ? 1 : 0 })
  return names.map(function (n) { return path.join(dir, n) })
}

/* the newest backup that reads, or null */
function fromBackup (file) {
  const all = backups(file)
  for (let i = all.length - 1; i >= 0; i--) {
    try { return parse(fs.readFileSync(all[i], 'utf8')) } catch (e) { /* try an older one */ }
  }
  return null
}

/** The saved sign-ins. No file and no backup: none yet. */
function load (file) {
  let text = null
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
    return fromBackup(file) || []
  }
  try {
    return parse(text)
  } catch (e) {
    const saved = fromBackup(file)
    if (saved) return saved
    throw new Error(path.basename(file) + ' cannot be read, and no backup of it can either: ' + e.message)
  }
}

function stamp (ms) {
  const d = new Date(ms)
  const two = function (n) { return String(n).padStart(2, '0') }
  return d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) + '-' + two(d.getHours()) + two(d.getMinutes()) + two(d.getSeconds())
}

/* a copy of the file's bytes as they were, unless the newest copy already holds the same; then older copies thinned */
function backup (file, bytes, now) {
  const dir = backupsDir(file)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const all = backups(file)
  const newest = all[all.length - 1]
  if (newest) {
    try { if (fs.readFileSync(newest).equals(bytes)) return } catch (e) { /* copy it again */ }
  }
  let name = 'iris-accounts-' + stamp(now) + '.json'
  for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = 'iris-accounts-' + stamp(now) + '-' + n + '.json'
  fs.writeFileSync(path.join(dir, name), bytes, { mode: 0o600 })
  // kept: the newest copies, and the last one of each day
  const names = backups(file).map(function (p) { return path.basename(p) })
  const lastOfDay = {}
  names.forEach(function (n) { lastOfDay[NAME.exec(n)[1]] = n })
  const keep = new Set(names.slice(-KEEP_NEWEST).concat(Object.keys(lastOfDay).map(function (d) { return lastOfDay[d] })))
  names.forEach(function (n) {
    if (!keep.has(n)) { try { fs.unlinkSync(path.join(dir, n)) } catch (e) { /* kept, then */ } }
  })
}

/**
 * Write the list. opts.remove: [{ site, username }] deleted on purpose; any other saved sign-in missing from the list
 * stops the write (an Error). opts.now: the clock, for the backup's name.
 */
function write (file, list, opts) {
  const o = opts || {}
  const key = function (a) { return String(a.site) + '\n' + String(a.username) }
  let before = null
  try { before = fs.readFileSync(file) } catch (e) { if (e.code !== 'ENOENT') throw e }
  if (before) {
    let old = null
    try { old = parse(before.toString('utf8')) } catch (e) { old = null }
    if (old) {
      const now = new Set(list.map(key))
      const removing = new Set((o.remove || []).map(key))
      const lost = old.filter(function (a) { return !now.has(key(a)) && !removing.has(key(a)) })
      if (lost.length) throw new Error('not saved: it would drop ' + lost.length + ' saved sign-in(s) (' + lost.slice(0, 3).map(function (a) { return a.site }).join(', ') + ')')
    }
    backup(file, before, o.now || Date.now())
  }
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify({ accounts: list }, null, 1), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

module.exports = { load, write, backups, backupsDir }
