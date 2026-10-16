'use strict'

/*
 * iris/agent/modelLock.js — one model request at a time across every copy of Iris on this Mac.
 *
 * Two Iris windows asking the same local server at once made llama-server stop answering. Before
 * a request, Iris creates a small lock file for that server (exclusive create), holding its process
 * ID and a timestamp it refreshes while the request runs. Another Iris finds the file and waits its
 * turn. A lock whose owner quit, or that was not refreshed for `staleMs`, is taken over, so a crash
 * can never block Iris for good.
 *
 * Pure apart from the injected file system, clock and process check.
 */

function createModelLock (opts) {
  const fs = opts.fs
  const file = opts.file
  const now = opts.now || Date.now
  const sleep = opts.sleep || function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms) }) }
  const pid = opts.pid || process.pid
  const alive = opts.alive || function (p) { try { process.kill(p, 0); return true } catch (e) { return e.code === 'EPERM' } }
  const staleMs = opts.staleMs || 90000
  const beatMs = opts.beatMs || 30000
  const pollMs = opts.pollMs || 250

  function read () {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { return null }
  }

  /** Run fn() when it is this process's turn. onWait() is called once if it has to wait. */
  async function turn (fn, onWait) {
    const me = pid + '-' + Math.random().toString(36).slice(2)
    let waited = false
    for (;;) {
      try {
        fs.writeFileSync(file, JSON.stringify({ owner: me, pid: pid, at: now() }), { flag: 'wx' })
        break
      } catch (e) {
        if (e.code !== 'EEXIST') break // no lock possible on this file system: just go
        const held = read()
        if (held && (now() - held.at > staleMs || !alive(held.pid))) {
          try { fs.unlinkSync(file) } catch (err) { /* someone else took it over first */ }
          continue
        }
        if (!waited && onWait) { waited = true; onWait() }
        await sleep(pollMs)
      }
    }
    const beat = setInterval(function () {
      const held = read()
      if (held && held.owner === me) {
        try { fs.writeFileSync(file, JSON.stringify({ owner: me, pid: pid, at: now() })) } catch (e) { /* gone */ }
      }
    }, beatMs)
    if (beat.unref) beat.unref()
    try {
      return await fn()
    } finally {
      clearInterval(beat)
      const held = read()
      if (held && held.owner === me) { try { fs.unlinkSync(file) } catch (e) { /* already gone */ } }
    }
  }

  return { turn }
}

module.exports = { createModelLock }
