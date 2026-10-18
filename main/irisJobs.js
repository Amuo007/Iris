/*
 * main/irisJobs.js — Jobs: the career profile, the resume template, one tailored PDF per job,
 * and the list of applications. The thinking lives in iris/agent/career.js.
 *
 * Everything stays on this Mac: the profile is a user-only file next to My info, PDFs are built
 * by the LaTeX already installed here (no shell escape), and tailoring uses the user's own model.
 *
 * Concatenated into main.build.js after irisAgent.js (shared scope: settings, userDataPath, fs,
 * path, app, irisSettings, irisModelClient, irisActionSchema, irisProfileLoad, DBUG, …).
 */

const irisCareerLib = require('./iris/agent/career.js')
const irisChildProcess = require('child_process')

/* ---------- the career profile ---------- */

function irisCareerPath () {
  return path.join(userDataPath, 'iris-career.json')
}

function irisCareerLoad () {
  let raw = null
  try { raw = JSON.parse(fs.readFileSync(irisCareerPath(), 'utf8')) } catch (e) { /* not set up yet */ }
  const bank = irisCareerLib.normalizeBank(raw)
  // the header of the built-in template falls back to My info
  if (!bank.basics.name || !bank.basics.email || !bank.basics.phone) {
    const info = irisProfileLoad()
    const get = function (re) { const f = info.find(function (x) { return !x.secret && re.test(x.label) && x.value }); return f ? f.value : '' }
    bank.basics.name = bank.basics.name || get(/^(full )?name$/i)
    bank.basics.email = bank.basics.email || get(/^e-?mail$/i)
    bank.basics.phone = bank.basics.phone || get(/^phone/i)
  }
  return bank
}

function irisCareerSave (raw) {
  const bank = irisCareerLib.normalizeBank(raw)
  fs.writeFileSync(irisCareerPath(), JSON.stringify(bank, null, 1), { mode: 0o600 })
  return bank
}

/* ---------- the resume template ---------- */

function irisTemplateDir () {
  const dir = path.join(userDataPath, 'iris-resume-template')
  try { fs.mkdirSync(dir, { recursive: true }) } catch (e) { /* exists */ }
  return dir
}

function irisTemplateInfo () {
  const info = settings.get('irisResumeTemplate')
  return info && typeof info === 'object' ? info : { kind: 'builtin' }
}

function irisTemplateText () {
  const info = irisTemplateInfo()
  if (info.kind === 'custom') {
    try { return fs.readFileSync(path.join(irisTemplateDir(), 'template.tex'), 'utf8') } catch (e) { DBUG('template read: ' + e.message) }
  }
  return irisCareerLib.DEFAULT_TEMPLATE
}

/*
 * The user's own resume: Iris marks it up (iris/agent/career.js templatize), keeps the files it
 * needs (.cls, .sty, fonts, images in the same folder), and offers the content for the profile.
 */
function irisTemplateImport (file) {
  const src = fs.readFileSync(file, 'utf8')
  const result = irisCareerLib.templatize(src)
  if (!result.template) return { ok: false, error: result.error || 'Iris could not read this file.' }
  const dir = irisTemplateDir()
  fs.readdirSync(dir).forEach(function (n) { try { fs.rmSync(path.join(dir, n), { recursive: true, force: true }) } catch (e) { /* ignore */ } })
  fs.writeFileSync(path.join(dir, 'template.tex'), result.template)
  fs.writeFileSync(path.join(dir, 'original.tex'), src)
  // the resume's own files live in files/, so one called template.tex cannot replace Iris's copy
  const from = path.dirname(file)
  const filesDir = path.join(dir, 'files')
  // a resume picked from a busy folder (Documents) must not drag every PDF along: at most 80 files, 60 MB
  let assets = 0
  let bytes = 0
  // what the build needs first (class, styles, fonts), then other .tex files, images, PDFs last
  const rank = function (n) {
    if (/\.(cls|sty|bst|bib|ttf|otf)$/i.test(n) || /^fonts?$/i.test(n)) return 0
    if (/\.tex$/i.test(n)) return 1
    if (/\.(png|jpe?g|eps)$/i.test(n)) return 2
    return 3
  }
  const take = function (srcDir, dest, sub) {
    fs.readdirSync(srcDir).sort(function (a, b) { return rank(a) - rank(b) }).forEach(function (n) {
      const full = path.join(srcDir, n)
      let st = null
      try { st = fs.statSync(full) } catch (e) { return } // a broken link
      if (st.isDirectory()) {
        // Awesome-CV and others keep their fonts in a fonts/ folder next to the resume
        if (!sub && /^fonts?$/i.test(n)) take(full, path.join(dest, n), true)
        return
      }
      if (!/\.(cls|sty|bst|bib|ttf|otf|png|jpe?g|pdf|eps|tex)$/i.test(n) || (!sub && (n === path.basename(file) || n === 'resume.tex'))) return
      if (st.size > 15 * 1024 * 1024 || assets >= 80 || bytes + st.size > 60 * 1024 * 1024) return
      fs.mkdirSync(dest, { recursive: true })
      fs.copyFileSync(full, path.join(dest, n))
      assets++
      bytes += st.size
    })
  }
  try { take(from, filesDir, false) } catch (e) { DBUG('template assets: ' + e.message) }
  const info = { kind: 'custom', name: path.basename(file), imported: Date.now(), report: result.report, sections: result.sections, assets: assets, engine: irisTexEngineFor(src) }
  settings.set('irisResumeTemplate', info)
  return { ok: result.ok, info: info, bank: result.bank }
}

/* ---------- LaTeX ---------- */

function irisTexEngineFor (tex) {
  return /\\usepackage(\[[^\]]*\])?\{fontspec\}|\\setmainfont|\\usepackage(\[[^\]]*\])?\{unicode-math\}/.test(tex) ? 'xelatex' : 'pdflatex'
}

/* GUI apps on macOS do not get the shell's PATH: look where TeX distributions put their programs */
function irisTexBinary (engine) {
  const dirs = [settings.get('irisTexDir'), '/Library/TeX/texbin', '/usr/local/texlive/2026/bin/universal-darwin', '/usr/local/texlive/2025/bin/universal-darwin',
    '/usr/local/texlive/2024/bin/universal-darwin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/usr/texbin'].filter(Boolean)
  for (const d of dirs) {
    const full = path.join(d, engine)
    try { fs.accessSync(full, fs.constants.X_OK); return full } catch (e) { /* next */ }
  }
  return null
}

function irisTexStatus () {
  const p = irisTexBinary('pdflatex')
  return { found: !!p, path: p || '', xelatex: !!irisTexBinary('xelatex') }
}

var irisTexQueue = Promise.resolve()

/* One build at a time, in a private folder; no shell escape, a time limit, and nothing kept but the PDF. */
function irisCompileTex (tex, engine) {
  const job = irisTexQueue.then(function () {
    return new Promise(function (resolve) {
      const bin = irisTexBinary(engine || 'pdflatex')
      if (!bin) return resolve({ ok: false, error: 'LaTeX is not installed on this Mac (Iris looked for ' + (engine || 'pdflatex') + '). Install MacTeX, or set its folder in Settings → Jobs.' })
      const dir = path.join(app.getPath('temp'), 'iris-resume-build')
      try { fs.mkdirSync(dir, { recursive: true }) } catch (e) { /* exists */ }
      // the template's own files (.cls, fonts, images) sit next to it
      try {
        if (irisTemplateInfo().kind === 'custom') {
          const tdir = irisTemplateDir()
          fs.readdirSync(tdir).forEach(function (n) { // templates imported before files/ existed
            const full = path.join(tdir, n)
            if (!/^(template|original)\.tex$/.test(n) && fs.statSync(full).isFile()) fs.copyFileSync(full, path.join(dir, n))
          })
          if (fs.existsSync(path.join(tdir, 'files'))) fs.cpSync(path.join(tdir, 'files'), dir, { recursive: true })
        }
      } catch (e) { DBUG('tex assets: ' + e.message) }
      fs.writeFileSync(path.join(dir, 'resume.tex'), tex)
      try { fs.unlinkSync(path.join(dir, 'resume.pdf')) } catch (e) { /* first build */ }
      const started = Date.now()
      const child = irisChildProcess.spawn(bin, ['-interaction=nonstopmode', '-halt-on-error', '-no-shell-escape', 'resume.tex'], {
        cwd: dir,
        env: Object.assign({}, process.env, { PATH: path.dirname(bin) + ':' + (process.env.PATH || '/usr/bin:/bin') })
      })
      const timer = setTimeout(function () { try { child.kill('SIGKILL') } catch (e) { /* gone */ } }, 45000)
      child.on('error', function (err) { clearTimeout(timer); resolve({ ok: false, error: 'LaTeX could not start: ' + err.message }) })
      child.on('close', function (code) {
        clearTimeout(timer)
        let log = ''
        try { log = fs.readFileSync(path.join(dir, 'resume.log'), 'utf8') } catch (e) { /* no log */ }
        const info = irisCareerLib.readLatexLog(log)
        const pdf = path.join(dir, 'resume.pdf')
        const ok = code === 0 && info.pages > 0 && fs.existsSync(pdf)
        // every build writes resume.pdf: keep this build's bytes with its result, since the page
        // fitter may keep an earlier build than the last, and another build may start right after
        let pdfData = null
        if (ok) try { pdfData = fs.readFileSync(pdf) } catch (e) { DBUG('latex pdf read: ' + e.message) }
        DBUG('latex ' + (ok ? 'ok' : 'failed') + ' ' + (Date.now() - started) + 'ms pages=' + info.pages + ' fill=' + info.fill.toFixed(2) + (info.error ? ' ' + info.error : ''))
        resolve({ ok: ok && !!pdfData, pages: info.pages, fill: info.fill, error: ok && pdfData ? null : (info.error || 'LaTeX stopped (exit ' + code + ')'), pdf: pdf, pdfData: pdfData, log: ok ? '' : log.slice(-3000) })
      })
    })
  })
  irisTexQueue = job.catch(function () {})
  return job
}

/* ---------- tailoring ---------- */

function irisResumeDir () {
  return settings.get('irisResumeDir') || path.join(app.getPath('documents'), 'Iris Resumes')
}

function irisSafeName (s, max) {
  return String(s || '').replace(/[/\\:*?"<>|\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 60)
}

/**
 * One resume for one job. Returns what the agent and the panel are told:
 * { ok, file, fit, focus, why, missing, undone, below, cutoff, pages, fill, ms, usedModel, error }
 */
async function irisTailorResume (job, hooks) {
  const started = Date.now()
  const bank = irisCareerLoad()
  if (irisCareerLib.bankIsEmpty(bank)) return { ok: false, error: 'The career profile is empty. Fill it in Settings → Jobs (skills, jobs, projects) first.' }
  const cfg = irisSettings()
  const tailorThinking = settings.get('irisTailorThinking') || 'off'
  // a coding agent may send its own picks (the same JSON the model would write): then no model runs
  let text = hooks && hooks.picks ? JSON.stringify(hooks.picks) : ''
  let modelError = null
  if (!text && !(hooks && hooks.noModel) && !(process.env.IRIS_FAKE_MODEL || cfg.useFakeModel)) {
    try {
      const model = irisLockedModel(irisModelClient.createModelClient({ baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey, temperature: 0.2, thinking: tailorThinking, timeoutMs: cfg.modelTimeoutMs }), cfg.baseUrl)
      const reply = await model.next({ messages: irisCareerLib.tailorMessages(bank, job), thinking: tailorThinking, signal: hooks && hooks.signal })
      text = typeof reply === 'string' ? reply : (reply && reply.content) || ''
      if (reply && reply.usage) irisUsageRecord('request', Object.assign({ ms: reply.ms }, reply.usage))
    } catch (err) {
      modelError = err.message
      DBUG('tailor model: ' + err.message)
    }
  }
  const pick = irisCareerLib.parseTailorReply(text, bank, job, irisActionSchema.parseObjectLoose)
  // below the cutoff the job is skipped: no PDF needed (unless asked for one, as in Settings → Try it)
  const cutoff0 = bank.prefs.fitCutoff
  if (!(hooks && hooks.alwaysBuild) && pick.fit !== null && cutoff0 > 0 && pick.fit < cutoff0) {
    return { ok: true, file: null, fit: pick.fit, focus: pick.focus, why: pick.why, missing: pick.missing, undone: pick.undone, cutoff: cutoff0, below: true, usedModel: pick.usedModel, modelError: modelError, ms: Date.now() - started }
  }
  const template = irisTemplateText()
  const engine = irisTemplateInfo().kind === 'custom' ? (irisTemplateInfo().engine || 'pdflatex') : 'pdflatex'
  const fitted = await irisCareerLib.fitToPage({ bank: bank, pick: pick, job: job, template: template, compile: function (tex) { return irisCompileTex(tex, engine) } })
  if (!fitted.ok) return { ok: false, error: 'LaTeX could not build the resume: ' + fitted.error, log: fitted.log }

  const folder = irisJobFolder(job, hooks && hooks.preview)
  // recruiters see the file name: the person's name, not "resume (3).pdf"
  const fileName = irisSafeName((bank.basics.name ? bank.basics.name + ' ' : '') + 'Resume', 60) + '.pdf'
  const file = path.join(folder, fileName)
  fs.writeFileSync(file, fitted.pdfData)
  fs.writeFileSync(path.join(folder, 'resume.tex'), fitted.tex.replace(/\\par\\typeout\{IRIS-FILL[^\n]*\n/, ''))
  fs.writeFileSync(path.join(folder, 'job.json'), JSON.stringify({
    job: job, made: Date.now(), fit: pick.fit, focus: pick.focus, why: pick.why, missing: pick.missing,
    picked: { experience: fitted.layout.experience, projects: fitted.layout.projects, skills: fitted.layout.skills }, rewrites: pick.rewrite, undone: pick.undone
  }, null, 1))
  const cutoff = bank.prefs.fitCutoff
  return {
    ok: true,
    file: file,
    folder: folder,
    fit: pick.fit,
    focus: pick.focus,
    why: pick.why,
    missing: pick.missing,
    undone: pick.undone,
    cutoff: cutoff,
    below: pick.fit !== null && cutoff > 0 && pick.fit < cutoff,
    pages: fitted.pages,
    fill: fitted.fill,
    usedModel: pick.usedModel,
    modelError: modelError,
    ms: Date.now() - started
  }
}

/*
 * The posting's own words, when its public page can be read without the browser (a plain request in
 * the empty look-up session; never LinkedIn and the like, never a site the user has an account on).
 * Iris sees one screenshot at a time, so by the time it calls tailor_resume the must-haves may have
 * scrolled away and its summary can miss or invent some. Pages that need JavaScript, or whose text does
 * not name the job, give nothing and the summary is used alone.
 */
async function irisPostingText (job) {
  if (!job || !job.url || !/^https?:/i.test(job.url)) return ''
  try {
    const r = await Promise.race([
      irisLookup().lookup({ kind: 'page', query: job.url, chars: 8000 }),
      new Promise(function (resolve) { setTimeout(function () { resolve(null) }, 9000) })
    ])
    if (!r || !r.ok) return ''
    const text = String(((r.items && r.items[0]) || {}).text || '')
    const lower = text.toLowerCase()
    const words = (String(job.title || '').toLowerCase().match(/[a-z0-9+#]{3,}/g) || []).filter(function (w) { return !/^(and|the|for|with|senior|junior|staff|new|grad)$/.test(w) })
    const named = words.filter(function (w) { return lower.indexOf(w) !== -1 }).length
    if (text.length < 600 || !words.length || named < Math.min(2, words.length)) return ''
    return text
  } catch (e) {
    DBUG('posting text: ' + e.message)
    return ''
  }
}

/* ---------- cover letters ---------- */

/* the folder for this job's papers (the resume's folder, same name) */
function irisJobFolder (job, preview) {
  const day = new Date()
  const stamp = day.getFullYear() + '-' + String(day.getMonth() + 1).padStart(2, '0') + '-' + String(day.getDate()).padStart(2, '0')
  // a Settings preview never replaces the resume that went out with a real application
  const folder = path.join(irisResumeDir(), preview ? 'Previews' : '', irisSafeName(stamp + ' ' + (job.company || 'Company') + ' - ' + (job.title || 'Job'), 90))
  fs.mkdirSync(folder, { recursive: true })
  return folder
}

/** A short cover letter PDF for one job: { ok, file, removed, words, ms, error }. With `text`, no model runs. */
async function irisWriteCoverLetter (job, text) {
  const started = Date.now()
  const bank = irisCareerLoad()
  if (irisCareerLib.bankIsEmpty(bank)) return { ok: false, error: 'The career profile is empty.' }
  const cfg = irisSettings()
  if (!text) try {
    const model = irisLockedModel(irisModelClient.createModelClient({ baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey, temperature: 0.3, thinking: 'off', timeoutMs: cfg.modelTimeoutMs }), cfg.baseUrl)
    const reply = await model.next({ messages: irisCareerLib.coverLetterMessages(bank, job), thinking: 'off' })
    text = typeof reply === 'string' ? reply : (reply && reply.content) || ''
    if (reply && reply.usage) irisUsageRecord('request', Object.assign({ ms: reply.ms }, reply.usage))
  } catch (err) {
    return { ok: false, error: 'the model did not answer: ' + err.message }
  }
  const letter = irisCareerLib.parseCoverLetter(text, bank, job)
  if (!letter.paragraphs.length) return { ok: false, error: 'nothing usable came back' }
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  const r = await irisCompileTex(irisCareerLib.coverLetterTex(bank, job, letter.paragraphs, date), 'pdflatex')
  if (!r.ok) return { ok: false, error: 'LaTeX could not build the letter: ' + r.error }
  const folder = irisJobFolder(job)
  const file = path.join(folder, irisSafeName((bank.basics.name ? bank.basics.name + ' ' : '') + 'Cover Letter', 60) + '.pdf')
  fs.writeFileSync(file, r.pdfData)
  fs.writeFileSync(path.join(folder, 'cover-letter.txt'), letter.paragraphs.join('\n\n') + '\n')
  return { ok: true, file: file, removed: letter.removed, words: letter.paragraphs.join(' ').split(/\s+/).length, ms: Date.now() - started }
}

/* ---------- applications ---------- */

function irisApplicationsPath () {
  return path.join(userDataPath, 'iris-applications.json')
}

function irisApplicationsLoad () {
  try { return JSON.parse(fs.readFileSync(irisApplicationsPath(), 'utf8')).items || [] } catch (e) { return [] }
}

function irisApplicationsSave (items) {
  fs.writeFileSync(irisApplicationsPath(), JSON.stringify({ items: items.slice(-5000) }, null, 1), { mode: 0o600 })
  broadcast('iris-applications-changed', { count: items.length })
}

/* the same posting, however it was reached: no tracking parameters, no trailing slash */
function irisJobKey (url) {
  try {
    const u = new URL(url)
    ;['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gh_src', 'source', 'ref', 'lever-origin', 'lever-source'].forEach(function (k) { u.searchParams.delete(k) })
    return (u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/(apply|application)\/?$/, '').replace(/\/+$/, '') + (u.search && u.search !== '?' ? u.search : '')).toLowerCase()
  } catch (e) { return '' }
}

function irisSameJob (a, b) {
  if (a.url && b.url && irisJobKey(a.url) && irisJobKey(a.url) === irisJobKey(b.url)) return true
  const norm = function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() }
  return !!(a.company && b.company && a.title && b.title && norm(a.company) === norm(b.company) && norm(a.title) === norm(b.title))
}

function irisApplicationFind (rec) {
  return irisApplicationsLoad().slice().reverse().find(function (a) { return irisSameJob(a, rec) }) || null
}

function irisApplicationAdd (rec) {
  const items = irisApplicationsLoad()
  const existing = items.findIndex(function (a) { return irisSameJob(a, rec) })
  const item = Object.assign({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: Date.now() }, existing === -1 ? {} : items[existing], rec, { updated: Date.now() })
  if (existing === -1) items.push(item)
  else items[existing] = item
  irisApplicationsSave(items)
  return item
}

function irisAppliedToday () {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  return irisApplicationsLoad().filter(function (a) { return a.status === 'applied' && (a.updated || a.at) >= start.getTime() }).length
}

/* "STOP — you already applied …" when Iris lands on a posting it has handled before */
function irisApplicationNote (url) {
  if (!url || !/^https?:/.test(url)) return null
  const hit = irisApplicationFind({ url: url })
  if (!hit) return null
  const when = new Date(hit.updated || hit.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const job = hit.title ? ' (' + hit.title + (hit.company ? ' at ' + hit.company : '') + ')' : ''
  if (hit.status === 'applied') return 'STOP — you already applied to this job on ' + when + job + '. Do not apply again; find another job.'
  // skipped or unfinished before: worth knowing, but the user may have asked for it on purpose
  const what = { skipped: 'You skipped this job on ' + when + (hit.note ? ' (' + String(hit.note).slice(0, 100) + ')' : ''), needs_you: 'This job was left for the user on ' + when, failed: 'Applying here failed on ' + when }[hit.status] || 'You saw this job on ' + when
  return what + job + '. Unless the user asked for this job by name, move on to another.'
}

/* A question Iris asked during an application, and the user's answer: kept for the next forms. */
function irisJobsLearnAnswer (question, answer) {
  const q = String(question || '').replace(/\s+/g, ' ').trim()
  const a = String(answer || '').trim()
  if (!q || !a || a.length > 300 || /^(skip|no idea|don'?t know|stop|cancel)\b/i.test(a)) return false
  const raw = irisCareerLoad()
  // the form's own question when Iris quoted it ("… asks: \"Do you have a driver's licence?\""), else a short one
  const label = irisCareerLib.answerLabel(q)
  if (raw.answers.some(function (x) { return x.label.toLowerCase() === label.toLowerCase() })) return false
  raw.answers.push({ label: label, value: a, learned: Date.now() })
  irisCareerSave(raw)
  broadcast('iris-agent-event', { type: 'remember', note: 'Saved your answer for next time (Settings → Jobs → Answers): ' + label, automatic: false })
  return true
}

/* ---------- what the agent is told in Jobs mode ---------- */

function irisJobsActive (task) {
  return irisCareerLib.isJobTask(task) && !irisCareerLib.bankIsEmpty(irisCareerLoad())
}

/*
 * The user's own resume PDF when tailoring is off (Settings → Jobs → Applying): its path, '' when tailoring
 * is off but no usable file is chosen, null when Iris tailors a resume for each job.
 */
function irisOwnResume (bank) {
  const p = (bank || irisCareerLoad()).prefs
  if (p.tailor) return null
  return p.resumeFile && fs.existsSync(p.resumeFile) ? p.resumeFile : ''
}

function irisJobsPrompt (task, mode) {
  const nonStop = mode === 'continuous'
  const bank = irisCareerLoad()
  const p = bank.prefs
  const own = irisOwnResume(bank)
  const tailoring = own === null
  const ownName = own ? path.basename(own) : ''
  const lines = ['JOBS — the user keeps a career profile in Iris (Settings → Jobs). Applying for one job:',
    'THE RULES BELOW ARE DEFAULTS, NOT WALLS. The goal is the application done, honestly. When the usual way does not',
    'work (a box refuses a value, an option is missing, LinkedIn has no notes left, a page will not load), do what a',
    'sensible person would: the next-best honest choice, another way (keyboard, typing then Enter, another option),',
    'skip what is optional, or move on to the next job. Never stop the whole run and never keep retrying one thing.',
    'A dropdown, list or date box that will not take your clicks: {"type":"choose","field":"<its label>","option":"<text>"}',
    'or {"type":"fill","field":"<its label>","text":"<value>"} — Iris finds the box by its label and does it itself.',
    '1. Find postings that match' + (p.roles ? ': ' + p.roles : ' the profile') + (p.locations ? '; places: ' + p.locations : '') + (p.workplace !== 'any' ? '; ' + p.workplace + ' only' : '') + '.',
    '   Fields count broadly: "computer science / computer engineering" covers software, web, mobile, data, ML/AI,',
    '   firmware and embedded, systems and infrastructure, FPGA and hardware-software, robotics and autonomy software,',
    '   test automation, IT and security. Purely mechanical, electrical-power, industrial, manufacturing or flight-test',
    '   roles do not count.',
    '   PLACES ARE A HARD LIMIT: apply only when the posting shows a location in ' + (p.locations || 'the United States') + ' (a city/state there, the country, or "Remote" within it). A posting elsewhere — or one with no location where the company is based abroad (check its careers page or a look-up) — is skipped: do not apply, do not log it, do not contact its people.',
    '   Company boards that need no account (boards.greenhouse.io, jobs.lever.co, jobs.ashbyhq.com) are quickest; Workday',
    '   boards (<company>.wd5.myworkdayjobs.com) usually need an account to apply but can be searched. FIND JOBS WITH',
    '   LOOK-UPS FIRST — they read as text, far faster than browsing: a web look-up ({"type":"lookup","kind":"web",',
    '   "query":"site:jobs.lever.co software engineer new grad 2027"}), a public new-grad list read as text (a page',
    '   look-up of its raw file), or one board\'s openings at once ({"kind":"jobs","query":"jobs.lever.co/<company> <role',
    '   words>"}). Open the browser to apply, or only when look-ups find nothing; never guess a company\'s board address.',
    '   When the user names boards or job links, work only on those: once every opening there is handled, finish',
    '   with done — do not go looking on other boards or sites you know.',
  ].concat(tailoring ? [
    '2. Open the posting and read all of it (scroll). Each screen you leave is gone (you see only the newest screenshot),',
    '   so save its must-haves with "remember", in the posting\'s own words, in the same reply as the scroll.',
    '3. tailor_resume {"company":str,"title":str,"requirements":str}: requirements = what the POSTING asks for, in its',
    '   own words (skills, tools, years, duties), from your notes and the screen — never what such jobs usually ask,',
    '   nothing about the user. Iris builds a one-page PDF from the profile',
    '   and says how well it fits.',
    '   No need to judge the job yourself: the fit Iris reports is the decision.',
    '4. If Iris says the fit is below the cutoff: log_application {"status":"skipped",…} and go to the next job.',
    '   Jobs you rule out from a list without opening them (wrong place, role or level): log each as skipped with the',
    '   reason, right away — several log_application in one "actions" list, in the same step as you decide.',
    '5. Otherwise apply: fill the form from My info and the answers below. When it asks for a resume, upload the PDF',
    '   tailor_resume made — even when one is already attached (sites that remember you show your last one, with the',
    '   same name): remove or replace it.'
  ] : [
    '2. Open the posting and go straight to its application form (below the posting, or behind an "Apply" button).',
    '3. No tailor_resume and no fit check: the user turned tailoring off, and their own resume goes out as it is.',
    '4. Jobs you rule out from a list without opening them (wrong place, role or level): log each as skipped with the',
    '   reason, right away — several log_application in one "actions" list, in the same step as you decide.',
    '5. Apply: fill the form from My info and the answers below. When it asks for a resume, ' + (own
      ? 'upload the user\'s own PDF with {"type":"upload","file":"resume"} (' + ownName + ')'
      : 'upload the user\'s resume PDF (no file is chosen in Settings → Jobs: pick the one with the user\'s name from the file picker\'s recent files; none there → needs_you)') +
      ' — even when one is already attached (sites that remember you show your last one, with the same name): remove or replace it.'
  ]).concat([
    '   Work authorization, visa, sponsorship, citizenship, criminal record or other legal questions: read every option',
    '   first and pick the one that matches the answers below word for word in meaning — never "the first option" — and',
    '   write the option\'s own words in your thought (e.g. picked "Yes, I am authorized but will need sponsorship").',
    '   A question that says which statuses count (e.g. "require sponsorship? (F-1 CPT/OPT, J-1, H1-B …)") is answered by',
    '   its own words: a status it lists is a Yes, whatever the saved answer says in general.',
    '   City / location boxes that suggest places: type only the city name (e.g. "Houston", no Enter), and in the list',
    '   that appears CLICK the suggestion with the right state and country (e.g. "Houston, Texas, United States") — the',
    '   first one is often another place (North Houston, Houston in Scotland). No list? Click the box and type it again.',
    '   The right one not in view (the list scrolled past it)? Do not scroll the list: type "City, State" (e.g. "Houston, Texas").',
    '   Enter (enter:true) only picks an option in a dropdown or search box — never press it in a plain text field of a',
    '   form: it sends the form half-filled. Red messages under fields can be left over from such an early send (sites',
    '   check again only on Submit): when a field shows the right value, move on; Submit at the end and fix what is',
    '   still red then.',
    '   AUTOFILL (every application site but LinkedIn): as soon as the application form is on the page, your first',
    '   action is {"type":"autofill"} — alone in its step. On a Greenhouse posting (…greenhouse.io/…/jobs/…) the form is',
    '   further down the same page: call autofill on your FIRST look, without scrolling or clicking Apply — it finds the',
    '   form itself. Elsewhere, open the form first (Apply), then autofill. Iris fills the standard fields (name, contact,',
    '   links, location, school, visa, self-ID, resume) from the profile and saved answers and lists what it set and',
    '   what is left. Then CHECK it like a person would: scroll through the WHOLE form from the top, compare every box',
    '   with that list, fix anything wrong or empty with normal clicks, answer what was left to you, then Submit.',
    '   A form in steps ("Step 2 of 4", Next / Continue / Save and continue): after the click brings a new page of',
    '   questions (the address may stay the same), your FIRST action there is {"type":"autofill"} again — before you',
    '   answer any of its questions by hand. If autofill says it cannot work here, fill by hand as below.',
    '   On many boards (Greenhouse among them) "Apply" only jumps down the same page to the form ("Apply for this job",',
    '   First Name, Email …): once that form is on screen, fill it — do not scroll back up to the button.',
    '   Never the SITE\'s own buttons "Autofill with MyGreenhouse" / "Autofill my application", "Apply with LinkedIn /',
    '   Indeed / Google" or any other that signs in (Iris\'s {"type":"autofill"} action is a different thing: use that).',
    '   A pop-up that only offers to fill the form from the resume ("Apply with resume — Upload Resume", no close or skip):',
    '   use it — click its upload button, upload the resume once the picker opens — then check every field it filled.',
    '   If it has "Skip" / "Apply manually" / an X, take that instead.',
    '   Otherwise fill the form on the page itself. A file field\'s button is "Attach" / "Upload" / "Choose file" — never Dropbox, Google',
    '   Drive or "Enter manually". Click that button first; send upload only once Iris says a file picker is open.',
    '   A dropdown whose list opens wide across the page: find the option in the NEW screenshot and click its text there',
    '   (positions from before the list opened are stale). Typed a short answer and the list says "No options": its options',
    '   are worded otherwise ("I have never worked at …") — click the box to open the full list and click the matching one.',
    '   A dropdown in the bottom fifth of the screen (or cut off by its edge): scroll down 3 first, so its list has room.',
    '   Open a dropdown by clicking its "Select..." line or its arrow — not its question text, and not the red "required"',
    '   line under the box (neither opens it). A click that opens a dropdown ends your step: put no other click after it',
    '   in the same actions list (its list covers what is below); pick the option on the next screen. A dropdown that has',
    '   the focus but shows no list after a click: press the Down arrow ({"type":"key","key":"down"}) — that opens it.',
    '   Answer every question truthfully from the profile and the answers; never claim a skill or',
    '   experience the profile does not show. "Do you have X?" for a professional credential (a security clearance, a',
    '   certification, a degree) the profile does not show: the true answer is No. Personal facts the profile cannot',
    '   know (a driver\'s licence, a car, willingness to travel or relocate, notice period) come from the answers below;',
    '   if they are not there, decide as said below. What follows from the profile is not a question for the user: living',
    '   in the job\'s city already ("I already live there"), years of experience counted from the jobs\' dates, years',
    '   with one skill or tool from the list below.',
    '   "Where would you like to work / which locations would you consider?" with a list of offices: a Texas one listed',
    '   (Houston, Austin, Dallas …) → that one. No Texas office → tick ALL the US locations (and Remote if listed) — the',
    '   user is willing to relocate; never pick one at random, never "None of the above". Only one choice allowed and no',
    '   Texas → Remote if listed, else the first US location.',
    '   Written answers (why us, a project, "anything else"): only facts in the profile\'s own bullet points — never',
    '   make up a class rank, award, number, reference, school or what an employer\'s product does. Never infer life',
    '   events the profile does not state (when the user moved, struggles, culture, family). An OPTIONAL question about',
    '   something "not on your resume" or personal: leave it empty unless the profile or saved answers say it plainly.',
    '   A question that asks you to confirm you are a human, or says it is there to filter automated or AI applications:',
    '   do not answer it — log_application {"status":"needs_you","note":"company filters automated applications: submit',
    '   it yourself"} and go on to the next job. A policy on how the user must behave in INTERVIEWS or assessments (e.g.',
    '   "no AI tools during the interview process — by submitting you agree") is not such a check: acknowledge it and go on.',
    '   But a company that asks applicants not to use AI for the APPLICATION itself ("please do not use AI assistants',
    '   during the application process", an "AI policy" you must agree to before applying): agreeing would be untrue',
    '   while you fill it in — do not answer it or write its essays; log_application {"status":"needs_you","note":',
    '   "asks applicants not to use AI: apply yourself"} and go on to the next job.',
    '   Never ask the user: they want the applications done. A required question the profile and answers do not cover:',
    '   decide as a sensible new-grad applicant would, truthfully — preferences and availability (relocation, commute,',
    '   travel, shifts, start date): the answer that keeps the application going; salary: the salary line below (a number',
    '   required and none given: the low end of the range the posting shows, else look it up — {"kind":"web","query":',
    '   "<title> entry level salary <city>"} — and take the low end; a salary box that refuses letters wants that number',
    '   alone); "why us / why you" text: two or three honest',
    '   sentences from the profile; personal data with "Prefer not to say" or "Decline": the saved answer, else that.',
    '   Say what you decided in log_application\'s note. Only what nobody but the user can supply (an access or referral',
    '   code, an invitation, a CAPTCHA that stays, a login with no account, an SMS code): log_application',
    '   {"status":"needs_you","note":"<what is missing>"} and go on to the next job. Do not wait.',
    '   Submit that does nothing although autofill finds no empty required box, on a page with a reCAPTCHA badge or',
    '   check: an invisible human check is holding it — treat it as one (below), do not keep clicking Submit.',
    '   A human check ("Verify you are human", a CAPTCHA) after Submit on a form you filled: log needs_you, then open',
    '   the next job with {"type":"new_tab","url":…} — not navigate — so that filled tab stays open for the user to',
    '   finish the check and submit it themselves.',
    '   Optional fields with no saved answer: leave them empty (no need to scroll back to them). Voluntary',
    '   self-identification (gender, race, Hispanic/Latino, veteran, disability): use the saved answer when there is one',
    '   (a race answer that names no Hispanic or Latino origin is No to "Are you Hispanic/Latino?"); with none, leave it',
    '   empty unless required, then "Decline to self-identify".',
    '   Work history / employment / education sections: an employer\'s or school\'s address is ITS city and state (from the',
    '   profile, e.g. Houston, TX) — never the user\'s home street address; leave a street box there empty if not known.',
    '   Entries a site made from the resume (Work History 1, 2, 3 …): keep EVERY job the profile lists; delete only an',
    '   entry the profile does not list as a job (a project). A "Delete" / "Remove" button sits at the END of its own',
    '   entry, above the next entry\'s heading — so the button just above "Work History 4" deletes Work History 3. To',
    '   delete an entry, use the button below its own fields; after each delete, look again before the next one.',
    '   SMS / WhatsApp / text-message opt-ins: No (the company still writes by email and calls). Cookie banners: "Reject" /',
    '   "Necessary only" / close it; accept all only when nothing else lets you go on. Consent checkboxes: tick only',
    '   the required ones (*, the application privacy notice); leave optional ones (talent community, future jobs,',
    '   marketing) empty — so never "Select all" when it would tick optional boxes too.',
    '   "How did you hear about us?": where you found the posting (the company\'s own site → Company Website; a job board →',
    '   that board, or Job Board); if none fits, Other.',
    '   Cover letter optional: skip it. Required as a file: cover_letter {"company":str,"title":str,"requirements":str} makes',
    '   a one-page PDF from the profile; upload it with {"type":"upload","file":"cover letter"} (replacing any old one the site',
    '   shows). Required as a text box: type',
    '   three short honest paragraphs from the profile.',
    p.autoSubmit ? '6. Check the form once, then submit it.' : '6. Fill everything, then click Submit: Iris pauses so the user can check it first.',
    '   Submit that changes nothing on screen, or says a required field is missing: call {"type":"autofill"} again — its',
    '   report lists every required box still empty, by name — then fill those (choose / fill / clicks), a required file',
    '   such as a cover letter too, and Submit again. Do not scroll up and down hunting for it. Never click the same',
    '   Submit more than twice in a row.',
    '   CONNECTING WITH PEOPLE AT A COMPANY (only when the task asks for it, after its application is sent): open that',
    '   company\'s OWN LinkedIn page (search it under Companies; check the logo, website and industry match the employer',
    '   of the job), then its People tab. Pick people whose CURRENT position is at that exact company and who are in the',
    '   United States — engineers, engineering managers or recruiters; never someone at a company with a similar name.',
    '   Two or three per company. A short honest note when LinkedIn allows one; when it says no personalized notes are',
    '   left, send the invitation without a note. Never more than 5 invitations for one company. Keep it quick — about',
    '   ten steps per company: someone whose Connect does not work after one try is skipped; when nobody connects',
    '   easily, move on to the next job (the applications matter more than the connections).',
    '7. log_application {"status":"applied"|"needs_you"|"failed","company":str,"title":str,"url":str,"note":str}',
    '   right after: applied once the site confirms it; needs_you when only the user can finish (a CAPTCHA, a login,',
    '   a question); failed when the site broke. Then the next job.',
    '   log_application {"status":…} takes company, title and url of the job you were on. When that was the last job to',
    '   handle, send log_application and done in one "actions" list.'
  ])
  // what changes while Iris works goes in the live part (sent last, so the cached start stays the same)
  const live = []
  if (p.dailyLimit > 0) {
    const today = irisAppliedToday()
    live.push('Daily limit: ' + p.dailyLimit + ' applications; ' + today + ' sent today.' + (today >= p.dailyLimit ? ' The limit is reached: do not submit more today; finish.' : ''))
  }
  // contact details for forms (My info has them too; these come from the career profile / the resume's header)
  const b = bank.basics
  const contact = [b.name && 'name ' + b.name, b.email && 'email ' + b.email, b.phone && 'phone ' + b.phone, b.location && 'location ' + b.location]
    .concat((b.links || []).map(function (l) { return 'link ' + l.url })).filter(Boolean)
  if (contact.length) lines.push('The user\'s details for forms (My info wins if it differs): ' + contact.join('; ') + '.')
  const answers = bank.answers.filter(function (a) { return a.value })
  if (answers.length) lines.push('Answers for application questions (turn them into the form\'s own options, e.g. a citizen is "Yes" to "authorized to work"): ' + answers.map(function (a) { return a.label + ': ' + a.value }).join('; ') + '.')
  if (p.salary) lines.push('Salary expectation: ' + p.salary + '.')
  const summary = []
  if (bank.experience.length) summary.push('Jobs: ' + bank.experience.map(function (e) { return [e.title, e.company].filter(Boolean).join(' at ') + (e.dates ? ' (' + e.dates + ')' : '') }).join('; '))
  if (bank.education.length) summary.push('Education: ' + bank.education.map(function (e) { return [e.degree, e.school, e.dates].filter(Boolean).join(', ') }).join('; '))
  if (bank.skills.length) summary.push('Skills: ' + bank.skills.map(function (g) { return g.group + ' (' + g.items.slice(0, 8).join(', ') + ')' }).join('; '))
  if (summary.length) lines.push('Profile in short — ' + summary.join('. ') + '.')
  // "How many years have you worked with X?": counted by code from the jobs that mention X
  const years = irisCareerLib.skillYears(bank).slice(0, 30)
  if (years.length) lines.push('Years with each skill (from the dates of the jobs that mention it — use these for "how many years with X"): ' + years.map(function (y) { return y.skill + ' ' + y.years }).join(', ') + '.')
  // only a job that was applied to is closed for good; one skipped or left for the user may be asked for again
  const done = irisApplicationsLoad().slice(-60)
  const name = function (a) { return (a.title || '?') + ' at ' + (a.company || '?') }
  const sent = done.filter(function (a) { return a.status === 'applied' })
  const open = done.filter(function (a) { return a.status !== 'applied' })
  if (sent.length) live.push('Already applied — never apply to these again: ' + sent.map(name).join('; ') + '.')
  if (open.length) {
    live.push('Handled before but not sent (skipped, needs the user, or failed) — leave them unless the user names them in this task: ' +
      open.map(function (a) { return name(a) + ' (' + a.status + ')' }).join('; ') + '.')
  }
  return { stable: lines.join('\n'), live: live.join('\n') }
}

/* ---------- settings page ---------- */

function irisCareerForPage () {
  const tex = irisTexStatus()
  return {
    bank: irisCareerLoad(),
    counts: irisCareerLib.bankCounts(irisCareerLoad()),
    template: irisTemplateInfo(),
    tex: tex,
    resumeDir: irisResumeDir(),
    tailorThinking: settings.get('irisTailorThinking') || 'off'
  }
}

function irisApplicationsForPage () {
  return irisApplicationsLoad().slice().reverse().slice(0, 400).map(function (a) {
    return Object.assign({}, a, { resumeExists: !!(a.resume && fs.existsSync(a.resume)) })
  })
}

var irisLastPreview = null

/* Preview: the profile tailored to a sample job, or (with no job) everything that fits, then opened. */
async function irisResumePreview (args) {
  const job = { title: (args && args.title) || '', company: (args && args.company) || 'Preview', requirements: (args && args.requirements) || '', url: (args && args.url) || '' }
  // a job link: read the public posting (a look-up outside the browser, no cookies)
  if (job.url && !job.requirements) {
    const r = await irisLookup().lookup({ kind: 'page', query: job.url })
    if (!r.ok) return { ok: false, error: 'Could not read that posting: ' + r.text.replace(/^Lookup \(page\) "[^"]*" failed: /, '') }
    const page = (r.items && r.items[0]) || {}
    job.requirements = String(page.text || r.text).slice(0, 5000)
    const named = irisCareerLib.jobFromPage(page.url || job.url, page.title)
    if (!job.title) job.title = named.title.slice(0, 100) || 'Job'
    if (job.company === 'Preview' && named.company) job.company = named.company.slice(0, 60)
  }
  if (!job.title) job.title = 'Software Engineer'
  const r = await irisTailorResume(job, { alwaysBuild: true, preview: true })
  if (r.ok) irisLastPreview = r.file
  return r
}

function irisJobsSettingsAction (action, args) {
  switch (action) {
    case 'careerGet':
      return Promise.resolve(irisCareerForPage())
    case 'careerSave': {
      // answers Iris learned after this page loaded are not in what the page sends: keep them
      const incoming = (args && args.bank) || {}
      const loadedAt = Number(args && args.loadedAt) || 0
      const labels = new Set((incoming.answers || []).map(function (a) { return String(a.label || '').toLowerCase() }))
      const learned = irisCareerLoad().answers.filter(function (a) { return a.learned && a.learned > loadedAt && !labels.has(a.label.toLowerCase()) })
      if (learned.length) incoming.answers = (incoming.answers || []).concat(learned)
      irisCareerSave(incoming)
      return Promise.resolve(Object.assign(irisCareerForPage(), { saved: true, learnedKept: learned.length }))
    }
    case 'templateImport':
      // IRIS_TEMPLATE_PICK (tests only): the file the dialog would return
      return (process.env.IRIS_TEMPLATE_PICK ? Promise.resolve({ canceled: false, filePaths: [process.env.IRIS_TEMPLATE_PICK] })
        : dialog.showOpenDialog(windows.getCurrent(), { title: 'Choose your LaTeX resume', properties: ['openFile'], filters: [{ name: 'LaTeX', extensions: ['tex'] }] })).then(function (pick) {
        if (pick.canceled || !pick.filePaths[0]) return irisCareerForPage()
        const r = irisTemplateImport(pick.filePaths[0])
        return Object.assign(irisCareerForPage(), { imported: r })
      })
    case 'careerFromText': {
      const text = String((args && args.text) || '').trim()
      if (text.length < 20) return Promise.resolve(Object.assign(irisCareerForPage(), { sorted: { ok: false, error: 'Paste a bit more text first.' } }))
      const cfg = irisSettings()
      const model = irisLockedModel(irisModelClient.createModelClient({ baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey, temperature: 0.1, thinking: 'off', timeoutMs: Math.max(cfg.modelTimeoutMs, 240000) }), cfg.baseUrl)
      return model.next({ messages: irisCareerLib.profileFromTextMessages(text), thinking: 'off' }).then(function (reply) {
        const out = typeof reply === 'string' ? reply : (reply && reply.content) || ''
        return Object.assign(irisCareerForPage(), { sorted: irisCareerLib.parseProfileFromText(out, text, irisActionSchema.parseObjectLoose) })
      }, function (err) {
        return Object.assign(irisCareerForPage(), { sorted: { ok: false, error: 'The model did not answer: ' + err.message } })
      })
    }
    case 'templateBuiltin':
      settings.set('irisResumeTemplate', { kind: 'builtin' })
      return Promise.resolve(irisCareerForPage())
    case 'templateShow': {
      const info = irisTemplateInfo()
      if (info.kind === 'custom') shell.showItemInFolder(path.join(irisTemplateDir(), 'template.tex'))
      return Promise.resolve(irisCareerForPage())
    }
    case 'resumePreview':
      return irisResumePreview(args || {}).then(function (r) { return Object.assign(irisCareerForPage(), { preview: r }) })
    case 'previewOpen':
    case 'previewShow':
      if (irisLastPreview && fs.existsSync(irisLastPreview)) {
        if (action === 'previewOpen') shell.openPath(irisLastPreview)
        else shell.showItemInFolder(irisLastPreview)
      }
      return Promise.resolve({ ok: true })
    case 'ownResumeChoose': {
      // the page keeps the path in the profile it saves (so a save in flight cannot undo it)
      const current = irisCareerLoad().prefs.resumeFile
      // IRIS_RESUME_PICK (tests only): the file the dialog would return
      return (process.env.IRIS_RESUME_PICK ? Promise.resolve({ canceled: false, filePaths: [process.env.IRIS_RESUME_PICK] }) : dialog.showOpenDialog(windows.getCurrent(), {
        title: 'Choose your resume (PDF)',
        properties: ['openFile'],
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
        defaultPath: current && fs.existsSync(current) ? current : app.getPath('desktop')
      })).then(function (pick) {
        return { picked: !pick.canceled && pick.filePaths[0] ? pick.filePaths[0] : '' }
      })
    }
    case 'ownResumeShow': {
      const file = irisCareerLoad().prefs.resumeFile
      if (file && fs.existsSync(file)) shell.showItemInFolder(file)
      return Promise.resolve({ shown: !!(file && fs.existsSync(file)) })
    }
    case 'resumeDirChoose':
      return dialog.showOpenDialog(windows.getCurrent(), { properties: ['openDirectory', 'createDirectory'], defaultPath: irisResumeDir() }).then(function (pick) {
        if (!pick.canceled && pick.filePaths[0]) settings.set('irisResumeDir', pick.filePaths[0])
        return irisCareerForPage()
      })
    case 'jobsStart': {
      if (irisIsBusy()) return Promise.resolve({ started: false, error: 'Iris is busy with another task. Stop it first.' })
      if (irisCareerLib.bankIsEmpty(irisCareerLoad())) return Promise.resolve({ started: false, error: 'Fill in your career profile first.' })
      // the browser UI opens a fresh tab and starts it there, like a scheduled task
      broadcast('iris-agent-scheduled-run', { task: 'Find jobs that match my career profile and apply to them one by one' + (irisOwnResume() === null ? ', with a resume tailored to each' : ', with my own resume') + '. Keep going until I stop you.', mode: 'continuous' })
      return Promise.resolve({ started: true })
    }
    case 'applicationsExport': {
      // a spreadsheet of every application, in the download folder, shown in Finder
      const cell = function (v) { const t = String(v === undefined || v === null ? '' : v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t }
      const rows = [['Date', 'Status', 'Job', 'Company', 'Fit', 'Link', 'Note', 'Resume']].concat(irisApplicationsLoad().map(function (a) {
        return [new Date(a.updated || a.at).toISOString().slice(0, 10), a.status, a.title, a.company, a.fit, a.url, a.note, a.resume]
      }))
      const file = path.join(irisDownloadDir(), 'Iris applications ' + new Date().toISOString().slice(0, 10) + '.csv')
      fs.writeFileSync(file, rows.map(function (r) { return r.map(cell).join(',') }).join('\n') + '\n')
      shell.showItemInFolder(file)
      return Promise.resolve({ items: irisApplicationsForPage(), today: irisAppliedToday(), exported: path.basename(file) })
    }
    case 'careerBackup': {
      const file = path.join(irisDownloadDir(), 'Iris career profile ' + new Date().toISOString().slice(0, 10) + '.json')
      fs.writeFileSync(file, JSON.stringify(irisCareerLoad(), null, 1))
      shell.showItemInFolder(file)
      return Promise.resolve(Object.assign(irisCareerForPage(), { backedUp: path.basename(file) }))
    }
    case 'careerRestore':
      return dialog.showOpenDialog(windows.getCurrent(), { title: 'Choose a saved career profile', properties: ['openFile'], filters: [{ name: 'Iris career profile', extensions: ['json'] }] }).then(function (pick) {
        if (pick.canceled || !pick.filePaths[0]) return irisCareerForPage()
        let raw = null
        try { raw = JSON.parse(fs.readFileSync(pick.filePaths[0], 'utf8')) } catch (e) { return Object.assign(irisCareerForPage(), { error: 'That file is not a career profile.' }) }
        irisCareerSave(raw)
        return Object.assign(irisCareerForPage(), { restored: true })
      })
    case 'applicationsList':
      return Promise.resolve({ items: irisApplicationsForPage(), today: irisAppliedToday() })
    case 'applicationShow': {
      const a = irisApplicationsLoad().find(function (x) { return x.id === (args && args.id) })
      if (a && a.resume && fs.existsSync(a.resume)) shell.showItemInFolder(a.resume)
      return Promise.resolve({ items: irisApplicationsForPage(), today: irisAppliedToday() })
    }
    case 'applicationDelete':
      irisApplicationsSave(irisApplicationsLoad().filter(function (x) { return x.id !== (args && args.id) }))
      return Promise.resolve({ items: irisApplicationsForPage(), today: irisAppliedToday() })
  }
  return null
}

/* the panel's "Open PDF" / "Show in Finder" on a resume card: only files Iris made */
ipc.on('iris-resume-open', function (event, data) {
  const file = path.resolve(String((data && data.file) || ''))
  const root = path.resolve(irisResumeDir())
  if (file.indexOf(root + path.sep) !== 0 || !/\.pdf$/i.test(file) || !fs.existsSync(file)) return
  if (data.reveal) shell.showItemInFolder(file)
  else shell.openPath(file)
})
