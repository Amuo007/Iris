'use strict'

/*
 * The user's resume service, resuma: an MCP server (one JSON-RPC message per line over stdio) that rewrites the user's
 * one-page LaTeX resume for a job description with the local model, keeping its layout. A run takes 5-10 minutes and
 * runs one at a time on the server, so Iris starts one when it decides to apply and picks the PDF up when the form asks
 * for it. No dependencies: spawn and timers are passed in, so the tests run it against a fake server.
 */

/* the client: started on first use, kept running, started again if it exits */
function createResumaClient (opts) {
  const o = opts || {}
  const log = o.log || function () {}
  let child = null
  let buf = ''
  let nextId = 1
  let pending = {}
  let ready = null

  function failAll (why) {
    const all = pending
    pending = {}
    Object.keys(all).forEach(function (id) { all[id].reject(new Error(why)) })
  }

  function send (msg) {
    child.stdin.write(JSON.stringify(msg) + '\n')
  }

  function request (method, params, timeoutMs) {
    const id = nextId++
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        delete pending[id]
        reject(new Error('resuma did not answer ' + method + ' in ' + Math.round(timeoutMs / 1000) + ' s'))
      }, timeoutMs)
      pending[id] = {
        resolve: function (v) { clearTimeout(timer); resolve(v) },
        reject: function (e) { clearTimeout(timer); reject(e) }
      }
      try { send({ jsonrpc: '2.0', id: id, method: method, params: params || {} }) } catch (e) { delete pending[id]; clearTimeout(timer); reject(e) }
    })
  }

  function onLine (line) {
    if (!line.trim()) return
    let msg
    try { msg = JSON.parse(line) } catch (e) { return log('resuma: not JSON: ' + line.slice(0, 200)) }
    if (msg.id === undefined || msg.id === null || !pending[msg.id]) return // notifications (progress, logs)
    const p = pending[msg.id]
    delete pending[msg.id]
    if (msg.error) p.reject(new Error(String(msg.error.message || 'resuma error')))
    else p.resolve(msg.result)
  }

  function start () {
    if (ready) return ready
    child = o.spawn(o.command, o.args || [], { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] })
    buf = ''
    child.stdout.on('data', function (d) {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1) }
    })
    if (child.stderr) child.stderr.on('data', function (d) { log('resuma: ' + String(d).trim().slice(0, 300)) })
    const gone = function (why) {
      if (!child) return
      child = null
      ready = null
      failAll('resuma stopped (' + why + ')')
    }
    child.on('exit', function (code) { gone('exit ' + code) })
    child.on('error', function (e) { gone(e.message) })
    ready = request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'iris', version: '1' } }, o.startTimeoutMs || 60000)
      .then(function (r) {
        send({ jsonrpc: '2.0', method: 'notifications/initialized' })
        return r
      })
      .catch(function (e) { stop(); throw e })
    return ready
  }

  async function call (name, args, timeoutMs) {
    await start()
    const r = await request('tools/call', { name: name, arguments: args || {} }, timeoutMs || 60000)
    return toolResult(r)
  }

  function stop () {
    const c = child
    child = null
    ready = null
    failAll('resuma stopped')
    if (c) { try { c.kill() } catch (e) {} }
  }

  return { call: call, stop: stop, running: function () { return !!child } }
}

/* a tools/call result as data: the structured content, else the JSON in its text; an error result throws */
function toolResult (r) {
  const text = r && Array.isArray(r.content) ? r.content.filter(function (c) { return c && c.type === 'text' }).map(function (c) { return c.text }).join('\n') : ''
  if (r && r.isError) throw new Error(text || 'resuma tool error')
  if (r && r.structuredContent && typeof r.structuredContent === 'object') return r.structuredContent
  try { return JSON.parse(text) } catch (e) { return { text: text } }
}

/* resuma names its output folder after the company, and a second job at the same company would replace the first: one
   name per job (the name is only a folder name; it never goes into the resume) */
function resumaCompany (job, tag) {
  const clean = function (s, n) { return String(s || '').replace(/[^\w\s&+.-]+/g, ' ').replace(/\.{2,}/g, '.').replace(/\s+/g, ' ').trim().slice(0, n) }
  return clean((clean(job && job.company, 40) || 'Company') + ' - ' + (clean(job && job.title, 50) || 'Job') + (tag ? ' ' + clean(tag, 12) : ''), 110)
}

/* Keep the real company/role in the analysis text; company is also used as a unique output-folder label. */
function tailorArgs (job, tag) {
  return {
    jd_text: ['Company: ' + String(job.company || ''), 'Role: ' + String(job.title || ''), '',
      'Job posting:', String(job.requirements || '').trim()].join('\n').slice(0, 20000),
    company: resumaCompany(job, tag),
    mode: 'jd_aware',
    project_strategy: 'adaptive',
    coverage_target: 0.90,
    wait: false
  }
}

/* Employer requisition numbers bridge a public careers URL to its ATS URL.
   Only explicitly labelled IDs count, never dates, salaries or arbitrary numbers. */
function requisitionIds (text) {
  const ids = []
  const re = /\b(?:job\s*(?:req(?:uisition)?\s*(?:id|number|no\.?|#)?|id|number|no\.?)|req(?:uisition)?\s*(?:id|number|no\.?|#))\s*[:#-]?\s*([a-z]{0,8}[- ]?\d{4,}(?:[-_]\d{1,2})?)\b/gi
  let m
  while ((m = re.exec(String(text || '')))) {
    const id = m[1].toLowerCase().replace(/[^a-z0-9]/g, '')
    if (ids.indexOf(id) < 0) ids.push(id)
  }
  return ids
}

function appliedRequisition (job, records, idsForRecord) {
  const normalize = function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '') }
  const company = normalize(job.company)
  const ids = requisitionIds(job.requirements)
  if (!company || !ids.length) return null
  return records.slice().reverse().find(function (rec) {
    if (normalize(rec.company) !== company) return false
    return (rec.requisitionIds || []).concat(idsForRecord(rec)).some(function (id) { return ids.indexOf(normalize(id)) >= 0 })
  }) || null
}

/* Definite moves away from an application. Login/email tabs and form redirects are
   deliberately not treated as abandoning it. Other decisions use cancel_resume. */
function moveOnReason (job, action, target) {
  if (!job || !job.resume || job.resumeCancelled || job.uploaded) return ''
  const t = target || {}
  if (action.type === 'cancel_resume') return action.reason || 'the application was left'
  if (action.type === 'lookup' && action.kind === 'jobs') return 'searching for another job'
  if (action.type === 'tailor_resume' && !t.sameJob) return 'starting another job'
  if (action.type === 'close_tab' && t.active !== false && job.tabId && String(t.tabId) === String(job.tabId)) return 'closed the application tab'
  if (!['navigate', 'new_tab', 'switch_tab', 'back'].includes(action.type) || !t.url) return ''
  try {
    const u = new URL(t.url)
    const board = /\/(?:search-jobs|jobs\/(?:role|location)|jobs\/search)(?:\/|$)/i.test(u.pathname) ||
      (/\/(?:jobs|careers|positions|openings)\/?$/i.test(u.pathname) && !u.searchParams.has('gh_jid')) ||
      (/(^|\.)(google|bing)\.com$/i.test(u.hostname) && u.pathname === '/search' && /job|career|engineer/i.test(u.searchParams.get('q') || ''))
    if (board) return 'returned to searching job listings'
  } catch (e) { /* no destination */ }
  return ''
}

/* a run until it is done: { ok, result } or { ok: false, error }. onProgress gets each new phase */
async function waitForJob (client, jobId, opts) {
  const o = opts || {}
  const sleep = o.sleep || function (ms) { return new Promise(function (resolve) { setTimeout(resolve, ms) }) }
  const now = o.now || Date.now
  const until = now() + (o.timeoutMs || 15 * 60000)
  let phase = null
  let errors = 0
  while (now() < until) {
    let j
    try {
      j = await client.call('get_job', { job_id: jobId, log_tail: 0 }, 30000)
      errors = 0
    } catch (e) {
      // the server went away: the run went with it (jobs live in its memory)
      if (/stopped|unknown job_id/i.test(e.message) || ++errors >= 5) return { ok: false, error: e.message }
      await sleep(o.pollMs || 10000)
      continue
    }
    if (j.phase !== phase) { phase = j.phase; if (o.onProgress) o.onProgress(j) }
    if (j.status === 'done' && j.result) return { ok: true, result: j.result, job: j }
    if (j.status === 'failed' || j.status === 'cancelled') return { ok: false, error: 'resuma run ' + j.status + (j.error ? ': ' + j.error : '') }
    await sleep(o.pollMs || 10000)
  }
  return { ok: false, error: 'resuma run not done after ' + Math.round((o.timeoutMs || 15 * 60000) / 60000) + ' minutes', timedOut: true }
}

module.exports = { createResumaClient, toolResult, resumaCompany, tailorArgs, requisitionIds, appliedRequisition, moveOnReason, waitForJob }
