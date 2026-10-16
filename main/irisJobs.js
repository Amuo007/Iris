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
  fs.readdirSync(dir).forEach(function (n) { try { fs.unlinkSync(path.join(dir, n)) } catch (e) { /* ignore */ } })
  fs.writeFileSync(path.join(dir, 'template.tex'), result.template)
  fs.writeFileSync(path.join(dir, 'original.tex'), src)
  const from = path.dirname(file)
  let assets = 0
  try {
    fs.readdirSync(from).forEach(function (n) {
      if (!/\.(cls|sty|bst|bib|ttf|otf|png|jpe?g|pdf|eps|tex)$/i.test(n) || n === path.basename(file)) return
      const full = path.join(from, n)
      if (!fs.statSync(full).isFile() || fs.statSync(full).size > 15 * 1024 * 1024) return
      fs.copyFileSync(full, path.join(dir, n))
      assets++
    })
  } catch (e) { DBUG('template assets: ' + e.message) }
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
          fs.readdirSync(tdir).forEach(function (n) { if (!/^(template|original)\.tex$/.test(n)) fs.copyFileSync(path.join(tdir, n), path.join(dir, n)) })
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
        DBUG('latex ' + (ok ? 'ok' : 'failed') + ' ' + (Date.now() - started) + 'ms pages=' + info.pages + ' fill=' + info.fill.toFixed(2) + (info.error ? ' ' + info.error : ''))
        resolve({ ok: ok, pages: info.pages, fill: info.fill, error: ok ? null : (info.error || 'LaTeX stopped (exit ' + code + ')'), pdf: pdf, log: ok ? '' : log.slice(-3000) })
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
  let text = ''
  let modelError = null
  if (!(process.env.IRIS_FAKE_MODEL || cfg.useFakeModel)) {
    try {
      const model = irisModelClient.createModelClient({ baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey, temperature: 0.2, thinking: tailorThinking, timeoutMs: cfg.modelTimeoutMs })
      const reply = await model.next({ messages: irisCareerLib.tailorMessages(bank, job), thinking: tailorThinking, signal: hooks && hooks.signal })
      text = typeof reply === 'string' ? reply : (reply && reply.content) || ''
      if (reply && reply.usage) irisUsageRecord('request', Object.assign({ ms: reply.ms }, reply.usage))
    } catch (err) {
      modelError = err.message
      DBUG('tailor model: ' + err.message)
    }
  }
  const pick = irisCareerLib.parseTailorReply(text, bank, job, irisActionSchema.parseObjectLoose)
  const template = irisTemplateText()
  const engine = irisTemplateInfo().kind === 'custom' ? (irisTemplateInfo().engine || 'pdflatex') : 'pdflatex'
  const fitted = await irisCareerLib.fitToPage({ bank: bank, pick: pick, template: template, compile: function (tex) { return irisCompileTex(tex, engine) } })
  if (!fitted.ok) return { ok: false, error: 'LaTeX could not build the resume: ' + fitted.error, log: fitted.log }

  const day = new Date()
  const stamp = day.getFullYear() + '-' + String(day.getMonth() + 1).padStart(2, '0') + '-' + String(day.getDate()).padStart(2, '0')
  const folder = path.join(irisResumeDir(), irisSafeName(stamp + ' ' + (job.company || 'Company') + ' - ' + (job.title || 'Job'), 90))
  fs.mkdirSync(folder, { recursive: true })
  // recruiters see the file name: the person's name, not "resume (3).pdf"
  const fileName = irisSafeName((bank.basics.name ? bank.basics.name + ' ' : '') + 'Resume', 60) + '.pdf'
  const file = path.join(folder, fileName)
  fs.copyFileSync(fitted.pdf, file)
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

/* ---------- what the agent is told in Jobs mode ---------- */

/* "apply to jobs", "find me an internship", "tailor my resume" — not "papers about job scheduling" */
const IRIS_JOB_TASK = [
  /\b(apply|applying|job applications?|resume|résumé|tailor)\b/i,
  /\b(find|search|look for|looking for|hunt|get)\b[^.\n]{0,40}\b(jobs?|internships?|positions?|roles?|openings?)\b/i
]

function irisJobsActive (task) {
  const t = String(task || '')
  return IRIS_JOB_TASK.some(function (re) { return re.test(t) }) && !irisCareerLib.bankIsEmpty(irisCareerLoad())
}

function irisJobsPrompt (task) {
  const bank = irisCareerLoad()
  const p = bank.prefs
  const lines = ['JOBS — the user keeps a career profile in Iris (Settings → Jobs). Applying for one job:',
    '1. Find postings that match' + (p.roles ? ': ' + p.roles : ' the profile') + (p.locations ? '; places: ' + p.locations : '') + (p.workplace !== 'any' ? '; ' + p.workplace + ' only' : '') + '.',
    '   Company career pages and boards that need no account (boards.greenhouse.io, jobs.lever.co, jobs.ashbyhq.com) are quickest;',
    '   a look-up like "site:boards.greenhouse.io <role> <place>" lists many postings at once.',
    '2. Open the posting and read all of it (scroll). Remember its must-haves.',
    '3. tailor_resume {"company":str,"title":str,"requirements":str}: requirements = what the posting asks for, as exact',
    '   as you can (skills, tools, years, duties). Iris builds a one-page PDF from the profile and says how well it fits.',
    '   No need to judge the job yourself: the fit Iris reports is the decision.',
    '4. If Iris says the fit is below the cutoff: log_application {"status":"skipped",…} and go to the next job.',
    '5. Otherwise apply: fill the form from My info and the answers below. When it asks for a resume, upload the PDF',
    '   tailor_resume made. Answer every question truthfully from the profile and the answers; never claim a skill or',
    '   experience the profile does not show. A required question you cannot answer from them: ask_user.',
    '   Optional fields with no saved answer: leave them empty (no need to scroll back to them). Voluntary',
    '   self-identification (gender, race, veteran, disability): leave empty unless required; then "Decline to self-identify".',
    '   Cover letter optional: skip it; required: write a short honest one from the profile.',
    p.autoSubmit ? '6. Check the form once, then submit it.' : '6. Fill everything, then click Submit: Iris pauses so the user can check it first.',
    '7. log_application {"status":"applied"|"needs_you"|"failed","company":str,"title":str,"url":str,"note":str}',
    '   right after: applied once the site confirms it; needs_you when only the user can finish (a CAPTCHA, a login,',
    '   a question); failed when the site broke. Then the next job.',
    '   log_application {"status":…} takes company, title and url of the job you were on.'
  ]
  if (p.dailyLimit > 0) {
    const today = irisAppliedToday()
    lines.push('Daily limit: ' + p.dailyLimit + ' applications; ' + today + ' sent today.' + (today >= p.dailyLimit ? ' The limit is reached: do not submit more today; finish.' : ''))
  }
  const answers = bank.answers.filter(function (a) { return a.value })
  if (answers.length) lines.push('Answers for application questions (turn them into the form\'s own options, e.g. a citizen is "Yes" to "authorized to work"): ' + answers.map(function (a) { return a.label + ': ' + a.value }).join('; ') + '.')
  if (p.salary) lines.push('Salary expectation: ' + p.salary + '.')
  const summary = []
  if (bank.experience.length) summary.push('Jobs: ' + bank.experience.map(function (e) { return [e.title, e.company].filter(Boolean).join(' at ') + (e.dates ? ' (' + e.dates + ')' : '') }).join('; '))
  if (bank.education.length) summary.push('Education: ' + bank.education.map(function (e) { return [e.degree, e.school, e.dates].filter(Boolean).join(', ') }).join('; '))
  if (bank.skills.length) summary.push('Skills: ' + bank.skills.map(function (g) { return g.group + ' (' + g.items.slice(0, 8).join(', ') + ')' }).join('; '))
  if (summary.length) lines.push('Profile in short — ' + summary.join('. ') + '.')
  const done = irisApplicationsLoad().slice(-60)
  if (done.length) {
    lines.push('Already handled — never apply to these again: ' + done.map(function (a) {
      return (a.title || '?') + ' at ' + (a.company || '?') + ' (' + a.status + ')'
    }).join('; ') + '.')
  }
  return lines.join('\n')
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
  const job = { title: (args && args.title) || 'Software Engineer', company: (args && args.company) || 'Preview', requirements: (args && args.requirements) || '' }
  const r = await irisTailorResume(job)
  if (r.ok) irisLastPreview = r.file
  return r
}

function irisJobsSettingsAction (action, args) {
  switch (action) {
    case 'careerGet':
      return Promise.resolve(irisCareerForPage())
    case 'careerSave':
      irisCareerSave(args && args.bank)
      return Promise.resolve(Object.assign(irisCareerForPage(), { saved: true }))
    case 'templateImport':
      return dialog.showOpenDialog(windows.getCurrent(), { title: 'Choose your LaTeX resume', properties: ['openFile'], filters: [{ name: 'LaTeX', extensions: ['tex'] }] }).then(function (pick) {
        if (pick.canceled || !pick.filePaths[0]) return irisCareerForPage()
        const r = irisTemplateImport(pick.filePaths[0])
        return Object.assign(irisCareerForPage(), { imported: r })
      })
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
    case 'resumeDirChoose':
      return dialog.showOpenDialog(windows.getCurrent(), { properties: ['openDirectory', 'createDirectory'], defaultPath: irisResumeDir() }).then(function (pick) {
        if (!pick.canceled && pick.filePaths[0]) settings.set('irisResumeDir', pick.filePaths[0])
        return irisCareerForPage()
      })
    case 'jobsStart': {
      if (irisIsBusy()) return Promise.resolve({ started: false, error: 'Iris is busy with another task. Stop it first.' })
      if (irisCareerLib.bankIsEmpty(irisCareerLoad())) return Promise.resolve({ started: false, error: 'Fill in your career profile first.' })
      // the browser UI opens a fresh tab and starts it there, like a scheduled task
      broadcast('iris-agent-scheduled-run', { task: 'Find jobs that match my career profile and apply to them one by one, with a resume tailored to each. Keep going until I stop you.', mode: 'continuous' })
      return Promise.resolve({ started: true })
    }
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
