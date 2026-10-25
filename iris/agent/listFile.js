'use strict'

/*
 * iris/agent/listFile.js — a list kept in one JSON file ({ "items": [...] }), written so that a crash never leaves it
 * half written and a broken file is never read as an empty list.
 *
 *   • A save writes a temporary file next to it, flushes it to disk and renames it over the old one: the file is
 *     always the old list or the new one, never a mix.
 *   • The list as it was before the save is copied to <name>.bak.json first.
 *   • A file that cannot be read is not taken as "no items" (the next save would then write a list of one): it is
 *     moved aside as <name>.unreadable-<time>.json, kept for the user, and the .bak copy is read instead.
 *
 * The applications list (1,111 jobs on 10-24) used to be rewritten in place with a plain write: a crash during it could
 * have left a broken file, read back as empty, and the next log_application would have saved a list of one job.
 *
 * Pure apart from the injected file system.
 */

function createListFile (opts) {
  const fs = opts.fs
  const file = opts.file
  const key = opts.key || 'items'
  const keep = opts.keep || 0
  const mode = opts.mode || 0o600
  const log = typeof opts.log === 'function' ? opts.log : function () {}
  const now = opts.now || Date.now
  const base = file.replace(/\.json$/, '')
  const bak = base + '.bak.json'

  function parse (text) {
    const data = JSON.parse(text)
    if (!data || !Array.isArray(data[key])) throw new Error('no "' + key + '" list in it')
    return data[key]
  }

  function fromBackup () {
    try { return parse(fs.readFileSync(bak, 'utf8')) } catch (e) { return [] }
  }

  /** The items: [] when there is no file yet; the backup's when the file cannot be read. */
  function load () {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (e) {
      if (e.code === 'ENOENT') return []
      log('list file: cannot read ' + file + ' (' + e.message + '): using the backup')
      return fromBackup()
    }
    try {
      return parse(text)
    } catch (e) {
      const aside = base + '.unreadable-' + new Date(now()).toISOString().replace(/[:.]/g, '-') + '.json'
      try { fs.renameSync(file, aside) } catch (err) { /* the backup is read either way */ }
      log('list file: ' + file + ' is broken (' + e.message + '): kept as ' + aside + ', using the backup')
      return fromBackup()
    }
  }

  /** Write the list (its newest `keep` items) safely; returns what was written. */
  function save (items) {
    const list = keep > 0 ? (items || []).slice(-keep) : (items || []).slice()
    const text = JSON.stringify({ [key]: list }, null, 1)
    try {
      fs.copyFileSync(file, bak)
      fs.chmodSync(bak, mode)
    } catch (e) { /* no list yet */ }
    const tmp = file + '.tmp-' + process.pid
    const fd = fs.openSync(tmp, 'w', mode)
    try {
      fs.writeSync(fd, text)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, file)
    return list
  }

  return { load, save, file, bak }
}

module.exports = { createListFile }
