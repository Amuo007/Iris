/* Settings → Jobs: career profile, applying, resume template, applications. Uses irisAction() and
 * irisEmptyLine() from settings.js. Everything is saved by the main process (iris-career.json). */

var irisCareer = null
var irisCareerLoadedAt = 0
var irisCareerSaveTimer = null
var irisCareerStatus = document.getElementById('iris-career-status')

function irisCareerScheduleSave () {
  irisCareerStatus.textContent = 'Saving…'
  clearTimeout(irisCareerSaveTimer)
  irisCareerSaveTimer = setTimeout(function () { irisAction('careerSave', { bank: irisCareer, loadedAt: irisCareerLoadedAt }) }, 600)
}

function irisEl (tag, cls, text) {
  var el = document.createElement(tag)
  if (cls) el.className = cls
  if (text !== undefined) el.textContent = text
  return el
}

/* a labelled input bound to obj[key] */
function irisField (obj, key, label, opts) {
  opts = opts || {}
  var wrap = irisEl('div', 'iris-setting' + (opts.wide ? ' iris-wide' : ''))
  var l = irisEl('label', '', label)
  var input = opts.multi ? document.createElement('textarea') : document.createElement('input')
  if (!opts.multi) input.type = 'text'
  else { input.rows = opts.rows || 3; input.className = 'iris-career-text' }
  input.spellcheck = !!opts.spell
  if (opts.placeholder) input.placeholder = opts.placeholder
  var value = obj[key]
  input.value = Array.isArray(value) ? value.join(opts.join || '\n') : (value || '')
  input.addEventListener('input', function () {
    obj[key] = opts.split ? opts.split(input.value) : input.value
    if (opts.multi) irisGrow(input)
    irisCareerScheduleSave()
  })
  wrap.appendChild(l)
  wrap.appendChild(input)
  if (opts.multi) setTimeout(function () { irisGrow(input) }, 0)
  return wrap
}

function irisGrow (ta) {
  ta.style.height = 'auto'
  ta.style.height = Math.min(420, ta.scrollHeight + 2) + 'px'
}

function irisLines (text) {
  return String(text || '').split('\n').map(function (s) { return s.replace(/^\s*[-•*·]\s*/, '').trim() }).filter(Boolean)
}

function irisCommaList (text) {
  return String(text || '').split(',').map(function (s) { return s.trim() }).filter(Boolean)
}

/* ---------- career profile ---------- */

function irisRenderBasics () {
  var box = document.getElementById('iris-career-basics')
  box.innerHTML = ''
  var b = irisCareer.basics
  box.appendChild(irisField(b, 'name', 'Name'))
  box.appendChild(irisField(b, 'email', 'Email'))
  box.appendChild(irisField(b, 'phone', 'Phone'))
  box.appendChild(irisField(b, 'location', 'Location', { placeholder: 'City, Province' }))
  var links = { text: (b.links || []).map(function (l) { return l.url || l.label }).join('\n') }
  var f = irisField(links, 'text', 'Links (one per line)', {
    wide: true,
    multi: true,
    rows: 2,
    placeholder: 'github.com/you\nlinkedin.com/in/you',
    split: function (v) {
      b.links = irisLines(v).map(function (u) { return { label: u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''), url: u } })
      return v
    }
  })
  box.appendChild(f)
}

function irisRenderSkills () {
  var box = document.getElementById('iris-career-skills')
  box.innerHTML = ''
  if (!irisCareer.skills.length) box.appendChild(irisEmptyLine('No skills yet. Example: Cloud — AWS, Terraform, Kubernetes.'))
  irisCareer.skills.forEach(function (g, i) {
    var row = irisEl('div', 'iris-row iris-skill-group')
    var name = document.createElement('input')
    name.type = 'text'
    name.className = 'iris-row-label'
    name.placeholder = 'Group (e.g. Cloud)'
    name.value = g.group || ''
    name.addEventListener('input', function () { g.group = name.value; irisCareerScheduleSave() })
    // a long list wraps instead of hiding past the edge
    var items = document.createElement('textarea')
    items.rows = 1
    items.className = 'iris-row-value iris-skill-items'
    items.placeholder = 'AWS, Terraform, Kubernetes'
    items.value = (g.items || []).join(', ')
    items.addEventListener('keydown', function (e) { if (e.key === 'Enter') e.preventDefault() })
    items.addEventListener('input', function () { g.items = irisCommaList(items.value.replace(/\n/g, ' ')); irisGrow(items); irisCareerScheduleSave() })
    setTimeout(function () { irisGrow(items) }, 0)
    row.appendChild(name)
    row.appendChild(items)
    row.appendChild(irisDeleteButton('Remove this group', function () { irisCareer.skills.splice(i, 1); irisRenderSkills(); irisCareerScheduleSave() }))
    box.appendChild(row)
  })
}

function irisDeleteButton (title, fn) {
  var del = irisEl('button', 'iris-row-delete', '×')
  del.type = 'button'
  del.title = title
  del.addEventListener('click', fn)
  return del
}

var IRIS_CARD_KINDS = {
  experience: {
    empty: 'No jobs yet. Add every one, with all the bullets you might ever use.',
    title: function (e) { return [e.title, e.company].filter(Boolean).join(' · ') || 'New job' },
    fields: [['title', 'Title'], ['company', 'Company'], ['location', 'Location'], ['dates', 'Dates', 'e.g. May 2024 – Aug 2024']],
    list: ['bullets', 'What you did (Enter starts the next bullet)', 'Built … using … , which …\nCut … by …%']
  },
  projects: {
    empty: 'No projects yet.',
    title: function (p) { return p.name || 'New project' },
    fields: [['name', 'Name'], ['tech', 'Built with', 'e.g. Python, React'], ['link', 'Link'], ['dates', 'Date']],
    list: ['bullets', 'What it does and what you did (Enter starts the next bullet)', '']
  },
  education: {
    empty: 'No education yet.',
    title: function (e) { return [e.degree, e.school].filter(Boolean).join(' · ') || 'New education' },
    fields: [['school', 'School'], ['degree', 'Degree'], ['location', 'Location'], ['dates', 'Dates']],
    list: ['details', 'Details: GPA, awards, courses (Enter starts the next)', '']
  }
}

function irisRenderCards (kind) {
  var spec = IRIS_CARD_KINDS[kind]
  var box = document.getElementById('iris-career-' + kind)
  box.innerHTML = ''
  var items = irisCareer[kind]
  if (!items.length) box.appendChild(irisEmptyLine(spec.empty))
  items.forEach(function (item, i) {
    var card = irisEl('details', 'iris-card')
    if (item.__open) card.open = true
    card.addEventListener('toggle', function () { item.__open = card.open })
    var head = irisEl('summary', 'iris-card-head')
    var title = irisEl('span', 'iris-card-title', spec.title(item))
    var sub = irisEl('span', 'iris-card-sub', [item.dates, (item[spec.list[0]] || []).length ? (item[spec.list[0]] || []).length + (kind === 'education' ? ' details' : ' bullets') : ''].filter(Boolean).join(' · '))
    head.appendChild(title)
    head.appendChild(sub)
    var tools = irisEl('span', 'iris-card-tools')
    if (i > 0) {
      var up = irisEl('button', 'iris-row-delete', '↑')
      up.type = 'button'
      up.title = 'Move up'
      up.addEventListener('click', function (e) { e.preventDefault(); items.splice(i - 1, 0, items.splice(i, 1)[0]); irisRenderCards(kind); irisCareerScheduleSave() })
      tools.appendChild(up)
    }
    tools.appendChild(irisDeleteButton('Remove', function (e) {
      e.preventDefault()
      if (!confirm('Remove "' + spec.title(item) + '" from your profile?')) return
      items.splice(i, 1)
      irisRenderCards(kind)
      irisCareerScheduleSave()
    }))
    head.appendChild(tools)
    card.appendChild(head)
    var grid = irisEl('div', 'iris-grid iris-card-body')
    spec.fields.forEach(function (f) {
      var field = irisField(item, f[0], f[1], { placeholder: f[2] })
      field.querySelector('input').addEventListener('input', function () { title.textContent = spec.title(item) })
      grid.appendChild(field)
    })
    grid.appendChild(irisBulletEditor(item, spec.list[0], spec.list[1], function () { sub.textContent = [item.dates, (item[spec.list[0]] || []).length ? item[spec.list[0]].length + (kind === 'education' ? ' details' : ' bullets') : ''].filter(Boolean).join(' · ') }))
    card.appendChild(grid)
    box.appendChild(card)
  })
}

/*
 * One row per bullet, so a long bullet that wraps still reads as one. Enter starts the next bullet,
 * Backspace in an empty one removes it, and pasting several lines makes several bullets.
 */
function irisBulletEditor (obj, key, label, onChange) {
  var wrap = irisEl('div', 'iris-setting iris-wide')
  wrap.appendChild(irisEl('label', '', label))
  var box = irisEl('div', 'iris-bullets')
  wrap.appendChild(box)
  if (!Array.isArray(obj[key])) obj[key] = []
  var list = obj[key]
  var changed = function () { irisCareerScheduleSave(); if (onChange) onChange() }
  var render = function (focusIndex, caretEnd) {
    box.innerHTML = ''
    var rows = list.length ? list : ['']
    rows.forEach(function (text, i) {
      var row = irisEl('div', 'iris-bullet')
      row.appendChild(irisEl('span', 'iris-bullet-dot', '•'))
      var ta = document.createElement('textarea')
      ta.rows = 1
      ta.spellcheck = true
      ta.value = text
      ta.placeholder = i === 0 && !list.length ? 'What you did, with tools and results (Enter for the next one)' : ''
      ta.addEventListener('input', function () {
        if (!list.length) list.push('')
        list[i] = ta.value.replace(/\n+/g, ' ')
        irisGrow(ta)
        changed()
      })
      ta.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          if (!list.length) list.push(ta.value)
          var at = ta.selectionStart
          var before = ta.value.slice(0, at).trim()
          var after = ta.value.slice(at).trim()
          list[i] = before
          list.splice(i + 1, 0, after)
          changed()
          render(i + 1, false)
        } else if (e.key === 'Backspace' && !ta.value && list.length > 0) {
          e.preventDefault()
          list.splice(i, 1)
          changed()
          render(Math.max(0, i - 1), true)
        }
      })
      ta.addEventListener('paste', function (e) {
        var text = (e.clipboardData || window.clipboardData).getData('text')
        if (!/\n/.test(text)) return
        e.preventDefault()
        var parts = irisLines(text)
        if (!list.length) list.push('')
        var head = ta.value.slice(0, ta.selectionStart)
        list.splice(i, 1, (head + ' ' + (parts.shift() || '')).trim())
        Array.prototype.splice.apply(list, [i + 1, 0].concat(parts))
        changed()
        render(i + parts.length, true)
      })
      ta.addEventListener('blur', function () {
        // empty rows left behind are dropped
        var cleaned = list.filter(function (b) { return String(b).trim() })
        if (cleaned.length !== list.length) { list.length = 0; Array.prototype.push.apply(list, cleaned); changed(); setTimeout(function () { if (!box.contains(document.activeElement)) render() }, 0) }
      })
      var del = irisDeleteButton('Remove this bullet', function () { list.splice(i, 1); changed(); render() })
      row.appendChild(ta)
      row.appendChild(del)
      box.appendChild(row)
      setTimeout(function () { irisGrow(ta) }, 0)
      if (focusIndex === i) setTimeout(function () { ta.focus(); var n = caretEnd ? ta.value.length : 0; ta.setSelectionRange(n, n) }, 0)
    })
  }
  render()
  return wrap
}

function irisRenderAnswers () {
  var box = document.getElementById('iris-career-answers')
  box.innerHTML = ''
  irisCareer.answers.forEach(function (a, i) {
    var row = irisEl('div', 'iris-row')
    // long questions wrap instead of hiding
    var label = document.createElement('textarea')
    label.rows = 1
    label.className = 'iris-row-label iris-answer-q'
    label.value = a.label
    label.placeholder = 'Question'
    label.addEventListener('keydown', function (e) { if (e.key === 'Enter') e.preventDefault() })
    label.addEventListener('input', function () { a.label = label.value.replace(/\n/g, ' '); irisGrow(label); irisCareerScheduleSave() })
    setTimeout(function () { irisGrow(label) }, 0)
    var value = document.createElement('input')
    value.type = 'text'
    value.className = 'iris-row-value'
    value.value = a.value
    value.placeholder = /gender|race|veteran|disability/i.test(a.label) ? 'Empty = decline to answer' : 'Empty = Iris asks you'
    value.addEventListener('input', function () { a.value = value.value; irisCareerScheduleSave() })
    row.appendChild(label)
    row.appendChild(value)
    row.appendChild(irisDeleteButton('Remove', function () { irisCareer.answers.splice(i, 1); irisRenderAnswers(); irisCareerScheduleSave() }))
    box.appendChild(row)
  })
}

var IRIS_PREF_FIELDS = [
  ['iris-pref-roles', 'roles'], ['iris-pref-locations', 'locations'], ['iris-pref-workplace', 'workplace'],
  ['iris-pref-salary', 'salary'], ['iris-pref-cutoff', 'fitCutoff', 'int'], ['iris-pref-limit', 'dailyLimit', 'int']
]

function irisRenderPrefs () {
  var p = irisCareer.prefs
  IRIS_PREF_FIELDS.forEach(function (f) { document.getElementById(f[0]).value = p[f[1]] === undefined ? '' : p[f[1]] })
  document.getElementById('iris-pref-submit').value = p.autoSubmit === false ? 'ask' : 'auto'
}

IRIS_PREF_FIELDS.forEach(function (f) {
  var el = document.getElementById(f[0])
  el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', function () {
    if (!irisCareer) return
    irisCareer.prefs[f[1]] = f[2] === 'int' ? Math.max(0, parseInt(el.value, 10) || 0) : el.value
    irisCareerScheduleSave()
  })
})
document.getElementById('iris-pref-submit').addEventListener('change', function () {
  if (!irisCareer) return
  irisCareer.prefs.autoSubmit = this.value !== 'ask'
  irisCareerScheduleSave()
})

function irisRenderCareer () {
  irisRenderBasics()
  irisRenderSkills()
  irisRenderCards('experience')
  irisRenderCards('projects')
  irisRenderCards('education')
  irisRenderAnswers()
  irisRenderPrefs()
  var extras = document.getElementById('iris-career-extras')
  extras.value = irisCareer.extras.map(function (x) { return x.text }).join('\n')
  var about = document.getElementById('iris-career-about')
  about.value = irisCareer.about || ''
  ;[extras, about].forEach(function (t) { setTimeout(function () { irisGrow(t) }, 0) })
  document.getElementById('iris-career-import').hidden = !irisCareerEmpty()
}

function irisCareerEmpty () {
  return !irisCareer || (!irisCareer.experience.length && !irisCareer.projects.length && !irisCareer.skills.length)
}

document.getElementById('iris-career-extras').addEventListener('input', function () {
  irisCareer.extras = irisLines(this.value).map(function (t) { return { kind: '', text: t } })
  irisGrow(this)
  irisCareerScheduleSave()
})
document.getElementById('iris-career-about').addEventListener('input', function () {
  irisCareer.about = this.value
  irisGrow(this)
  irisCareerScheduleSave()
})

document.getElementById('iris-career-add-skills').addEventListener('click', function () {
  irisCareer.skills.push({ group: '', items: [] })
  irisRenderSkills()
  var inputs = document.querySelectorAll('#iris-career-skills .iris-row-label')
  if (inputs.length) inputs[inputs.length - 1].focus()
})
;['experience', 'projects', 'education'].forEach(function (kind) {
  document.getElementById('iris-career-add-' + kind).addEventListener('click', function () {
    var blank = kind === 'experience' ? { title: '', company: '', location: '', dates: '', bullets: [] }
      : kind === 'projects' ? { name: '', tech: '', link: '', dates: '', bullets: [] }
        : { school: '', degree: '', location: '', dates: '', details: [] }
    blank.__open = true
    irisCareer[kind].unshift(blank)
    irisRenderCards(kind)
    var first = document.querySelector('#iris-career-' + kind + ' .iris-card input')
    if (first) first.focus()
  })
})
document.getElementById('iris-career-add-answer').addEventListener('click', function () {
  irisCareer.answers.push({ label: '', value: '' })
  irisRenderAnswers()
  var inputs = document.querySelectorAll('#iris-career-answers .iris-row-label')
  if (inputs.length) inputs[inputs.length - 1].focus()
})

/* content read from a LaTeX resume: fills an empty profile, or adds what is missing */
function irisMergeImported (bank) {
  if (!bank) return 0
  var added = 0
  var same = function (a, b) { return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase() }
  ;(bank.experience || []).forEach(function (e) {
    if (!irisCareer.experience.some(function (x) { return same(x.title, e.title) && same(x.company, e.company) })) { irisCareer.experience.push(e); added++ }
  })
  ;(bank.projects || []).forEach(function (p) {
    if (!irisCareer.projects.some(function (x) { return same(x.name, p.name) })) { irisCareer.projects.push(p); added++ }
  })
  ;(bank.education || []).forEach(function (e) {
    if (!irisCareer.education.some(function (x) { return same(x.school, e.school) && same(x.degree, e.degree) })) { irisCareer.education.push(e); added++ }
  })
  ;(bank.skills || []).forEach(function (g) {
    var target = irisCareer.skills.find(function (x) { return same(x.group, g.group) })
    if (!target) { irisCareer.skills.push(g); added++; return }
    g.items.forEach(function (it) { if (!target.items.some(function (x) { return same(x, it) })) { target.items.push(it); added++ } })
  })
  ;(bank.extras || []).forEach(function (x) {
    if (!irisCareer.extras.some(function (y) { return same(y.text, x.text) })) { irisCareer.extras.push(x); added++ }
  })
  if (bank.about && !irisCareer.about) { irisCareer.about = bank.about; added++ }
  // contact details fill only empty fields; links are added if new
  if (bank.basics) {
    ;['name', 'email', 'phone', 'location'].forEach(function (k) { if (bank.basics[k] && !irisCareer.basics[k]) { irisCareer.basics[k] = bank.basics[k]; added++ } })
    ;(bank.basics.links || []).forEach(function (l) {
      if (!irisCareer.basics.links.some(function (x) { return same(x.url, l.url) })) { irisCareer.basics.links.push(l); added++ }
    })
  }
  return added
}

/* ---------- resume template ---------- */

function irisRenderTemplate (data) {
  var t = data.template || { kind: 'builtin' }
  var custom = t.kind === 'custom'
  document.getElementById('iris-template-name').textContent = custom ? 'Your template: ' + t.name : 'Built-in: Classic'
  document.getElementById('iris-template-help').textContent = custom
    ? 'Imported ' + new Date(t.imported).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) + '. Iris keeps its look and header, and refills the sections below for each job.'
    : 'A clean one-page layout. Or use your own LaTeX resume: Iris keeps its look and refills it.'
  document.getElementById('iris-template-import').textContent = custom ? 'Use another LaTeX file…' : 'Use my LaTeX resume…'
  document.getElementById('iris-template-builtin').hidden = !custom
  document.getElementById('iris-template-show').hidden = !custom
  var report = document.getElementById('iris-template-report')
  report.innerHTML = ''
  report.hidden = !custom || !t.report
  ;(t.report || []).forEach(function (r) {
    var row = irisEl('div', 'iris-template-row ' + (r.status === 'mapped' ? 'is-mapped' : 'is-kept'))
    row.appendChild(irisEl('span', 'iris-template-mark', r.status === 'mapped' ? '✓' : '–'))
    row.appendChild(irisEl('span', 'iris-template-section', r.title))
    row.appendChild(irisEl('span', 'iris-list-sub', r.status === 'mapped'
      ? 'Filled in for each job (' + r.kind + ')'
      : (r.kind === 'other' ? 'Kept as you wrote it' : (r.note || 'Kept as you wrote it') + ' — add markers to the template file to fill it (see docs/RESUME-TEMPLATES.md)')))
    report.appendChild(row)
  })
  var tex = data.tex || {}
  document.getElementById('iris-tex-status').textContent = tex.found
    ? 'Found ' + tex.path.replace(/\/pdflatex$/, '') + (tex.xelatex ? ' (pdfLaTeX and XeLaTeX)' : '')
    : 'LaTeX is not installed. Install MacTeX (tug.org/mactex) so Iris can build PDFs.'
  document.getElementById('iris-resume-dir').textContent = (data.resumeDir || '').replace(/^\/Users\/[^/]+/, '~')
  document.getElementById('iris-tailor-thinking').value = data.tailorThinking || 'off'
}

document.getElementById('iris-career-paste-run').addEventListener('click', function () {
  var text = document.getElementById('iris-career-paste-text').value.trim()
  var status = document.getElementById('iris-career-paste-status')
  if (text.length < 20) { status.textContent = 'Paste a bit more text first.'; return }
  this.disabled = true
  status.textContent = 'Sorting… (about a minute for a page of text)'
  irisAction('careerFromText', { text: text })
})

document.getElementById('iris-template-import').addEventListener('click', function () { irisAction('templateImport') })
document.getElementById('iris-career-from-tex').addEventListener('click', function () { irisAction('templateImport') })
document.getElementById('iris-template-builtin').addEventListener('click', function () { irisAction('templateBuiltin') })
document.getElementById('iris-template-show').addEventListener('click', function () { irisAction('templateShow') })
document.getElementById('iris-resume-dir-change').addEventListener('click', function () { irisAction('resumeDirChoose') })
document.getElementById('iris-tailor-thinking').addEventListener('change', function () { settings.set('irisTailorThinking', this.value) })

document.getElementById('iris-preview-run').addEventListener('click', function () {
  var status = document.getElementById('iris-preview-status')
  if (irisCareerEmpty()) { status.textContent = 'Fill in your career profile first.'; return }
  this.disabled = true
  status.textContent = 'Picking what fits and building the PDF…'
  irisAction('resumePreview', { title: document.getElementById('iris-preview-title').value.trim(), requirements: document.getElementById('iris-preview-req').value.trim() })
})

document.getElementById('iris-preview-open').addEventListener('click', function () { irisAction('previewOpen') })
document.getElementById('iris-preview-show').addEventListener('click', function () { irisAction('previewShow') })

document.getElementById('iris-jobs-start').addEventListener('click', function () {
  if (irisCareerEmpty()) { document.getElementById('iris-jobs-start-help').textContent = 'Fill in your career profile first.'; return }
  irisAction('jobsStart')
})

/* ---------- applications ---------- */

var IRIS_STATUS_TEXT = { applied: 'Applied', skipped: 'Skipped', needs_you: 'Needs you', failed: 'Failed' }

function irisRenderApplications (r) {
  var items = r.items || []
  var list = document.getElementById('iris-applications-list')
  var counts = { applied: 0, skipped: 0, needs_you: 0, failed: 0 }
  items.forEach(function (a) { counts[a.status] = (counts[a.status] || 0) + 1 })
  document.getElementById('iris-applications-summary').textContent = items.length
    ? counts.applied + ' applied · ' + counts.skipped + ' skipped · ' + counts.needs_you + ' need you' + (counts.failed ? ' · ' + counts.failed + ' failed' : '') + ' — ' + (r.today || 0) + ' sent today.'
    : 'Every job Iris applied to, skipped, or left for you to finish.'
  list.innerHTML = ''
  if (!items.length) {
    list.appendChild(irisEmptyLine('No applications yet.'))
    return
  }
  items.forEach(function (a) {
    var row = irisEl('div', 'iris-list-row')
    row.appendChild(irisEl('span', 'iris-list-time', new Date(a.updated || a.at).toLocaleDateString([], { month: 'short', day: 'numeric' })))
    var main = irisEl(a.url ? 'a' : 'div', 'iris-list-main')
    if (a.url) { main.href = a.url; main.title = a.url }
    main.appendChild(irisEl('span', 'iris-list-title', (a.title || 'Job') + (a.company ? ' — ' + a.company : '')))
    main.appendChild(irisEl('span', 'iris-list-sub', [a.fit !== null && a.fit !== undefined ? 'fit ' + a.fit : '', a.note || ''].filter(Boolean).join(' · ') || (a.url || '').replace(/^https?:\/\/(www\.)?/, '')))
    row.appendChild(main)
    row.appendChild(irisEl('span', 'iris-status iris-status-' + a.status, IRIS_STATUS_TEXT[a.status] || a.status))
    if (a.resumeExists) {
      var show = irisEl('button', 'iris-button', 'Resume')
      show.type = 'button'
      show.title = 'Show the resume Iris sent'
      show.addEventListener('click', function () { irisAction('applicationShow', { id: a.id }) })
      row.appendChild(show)
    }
    row.appendChild(irisDeleteButton('Remove from the list (Iris may apply again)', function () { irisAction('applicationDelete', { id: a.id }) }))
    list.appendChild(row)
  })
}

/* ---------- replies from the main process ---------- */

window.addEventListener('message', function (e) {
  if (!e.data || e.data.message !== 'irisSettingsActionResult') return
  var d = e.data.data || {}
  var r = d.result || {}
  if (d.action === 'careerFromText') {
    document.getElementById('iris-career-paste-run').disabled = false
    var so = r.sorted || {}
    var st = document.getElementById('iris-career-paste-status')
    if (!so.ok) { st.textContent = so.error || 'Could not sort it.'; return }
    var added = irisMergeImported(so.bank)
    irisRenderCareer()
    irisCareerScheduleSave()
    document.getElementById('iris-career-paste-text').value = ''
    st.textContent = 'Added ' + added + (added === 1 ? ' thing' : ' things') + '. Check the cards below.' +
      (so.dropped && so.dropped.length ? ' Left out ' + so.dropped.length + ' line(s) that were not in your text: ' + so.dropped.slice(0, 3).join(' · ') : '')
    return
  }
  if (d.action === 'careerBackup') { irisCareerStatus.textContent = r.backedUp ? 'Saved a copy: ' + r.backedUp + ' (in your download folder)' : 'Could not save a copy.'; return }
  if (d.action === 'careerRestore') {
    if (r.error) { irisCareerStatus.textContent = r.error; return }
    if (r.restored) { irisCareer = r.bank; irisCareerLoadedAt = Date.now(); irisRenderCareer(); irisCareerStatus.textContent = 'Loaded · ' + irisCountsText(r.counts) }
    return
  }
  if (['careerGet', 'careerSave', 'templateImport', 'templateBuiltin', 'templateShow', 'resumePreview', 'resumeDirChoose'].indexOf(d.action) !== -1) {
    if (r.error && !r.bank) { irisCareerStatus.textContent = r.error; return }
    if (d.action === 'careerSave') {
      irisCareerStatus.textContent = 'Saved · ' + irisCountsText(r.counts)
      // answers Iris learned meanwhile were kept by the main process: show them too
      if (r.learnedKept && r.bank) {
        irisCareer.answers = r.bank.answers
        irisCareerLoadedAt = Date.now()
        if (!document.getElementById('iris-career-answers').contains(document.activeElement)) irisRenderAnswers()
      }
      return
    }
    if (d.action === 'careerGet' || !irisCareer) {
      irisCareerLoadedAt = Date.now()
      irisCareer = r.bank
      irisRenderCareer()
      irisCareerStatus.textContent = irisCountsText(r.counts)
    }
    irisRenderTemplate(r)
    if (d.action === 'templateImport' && r.imported) {
      var imp = r.imported
      if (imp.error) { document.getElementById('iris-template-help').textContent = imp.error; return }
      var n = (imp.bank && (imp.bank.experience.length + imp.bank.projects.length)) || 0
      if (n && (irisCareerEmpty() || confirm('Add what is in this resume that your career profile does not have yet?'))) {
        var added = irisMergeImported(imp.bank)
        irisRenderCareer()
        irisCareerScheduleSave()
        irisCareerStatus.textContent = 'Added ' + added + ' things from ' + imp.info.name + '. Now add everything else you have done.'
      }
    }
    if (d.action === 'resumePreview') {
      document.getElementById('iris-preview-run').disabled = false
      var p = r.preview || {}
      document.getElementById('iris-preview-open').hidden = !p.ok
      document.getElementById('iris-preview-show').hidden = !p.ok
      document.getElementById('iris-preview-status').textContent = p.ok
        ? 'Made ' + p.file.split('/').pop() + ' · ' + (p.fit === null || p.fit === undefined ? '' : 'fit ' + p.fit + ' · ') + Math.round((p.fill || 0) * 100) + '% of the page · ' + Math.round(p.ms / 1000) + ' s' +
          (p.modelError ? ' (the model did not answer, so Iris picked by keywords)' : '')
        : 'Could not make it: ' + (p.error || 'unknown error')
    }
  } else if (d.action === 'jobsStart') {
    document.getElementById('iris-jobs-start-help').textContent = r.started ? 'Started in a new tab. Press Stop in the Iris panel to end it.' : (r.error || 'Could not start.')
  } else if (['applicationsList', 'applicationShow', 'applicationDelete', 'applicationsExport'].indexOf(d.action) !== -1) {
    irisRenderApplications(r)
    if (r.exported) document.getElementById('iris-applications-summary').textContent += ' Exported ' + r.exported + '.'
  }
})

function irisCountsText (c) {
  if (!c) return ''
  return c.experience + (c.experience === 1 ? ' job · ' : ' jobs · ') + c.projects + (c.projects === 1 ? ' project · ' : ' projects · ') + c.skills + ' skills · ' + c.bullets + ' bullets'
}

irisAction('careerGet')
irisAction('applicationsList')
// applications change while Iris works: keep the list current while this page is open
setInterval(function () { if (!document.hidden) irisAction('applicationsList') }, 15000)

/* ---------- every day: a scheduled job hunt (Settings → Schedule shows it too) ---------- */

var IRIS_DAILY_ID = 'jobs-daily'
var IRIS_DAILY_TASK = 'Find new jobs that match my career profile and apply to them one by one, with a resume tailored to each. Skip jobs already handled. Stop when there are no new ones today.'
var irisDailyBox = document.getElementById('checkbox-iris-jobs-daily')
var irisDailyTime = document.getElementById('iris-jobs-daily-time')

settings.get('irisSchedules', function (list) {
  var s = (Array.isArray(list) ? list : []).find(function (x) { return x.id === IRIS_DAILY_ID })
  irisDailyBox.checked = !!(s && s.enabled !== false)
  if (s && s.at) irisDailyTime.value = s.at
})

function irisSaveDaily () {
  settings.get('irisSchedules', function (list) {
    list = (Array.isArray(list) ? list : []).filter(function (x) { return x.id !== IRIS_DAILY_ID })
    if (irisDailyBox.checked) {
      // lastRun = now: the first run is at the chosen time, not right away
      list.push({ id: IRIS_DAILY_ID, task: IRIS_DAILY_TASK, at: irisDailyTime.value || '09:00', everyMinutes: 0, mode: 'continuous', enabled: true, lastRun: Date.now() })
    }
    settings.set('irisSchedules', list)
  })
}
irisDailyBox.addEventListener('change', function () {
  if (irisDailyBox.checked && irisCareerEmpty()) { irisDailyBox.checked = false; document.getElementById('iris-jobs-start-help').textContent = 'Fill in your career profile first.'; return }
  irisSaveDaily()
})
irisDailyTime.addEventListener('change', function () { if (irisDailyBox.checked) irisSaveDaily() })

document.getElementById('iris-career-backup').addEventListener('click', function () { irisAction('careerBackup') })
document.getElementById('iris-career-restore').addEventListener('click', function () {
  if (!irisCareerEmpty() && !confirm('Replace your career profile with the copy you choose?')) return
  irisAction('careerRestore')
})
document.getElementById('iris-applications-export').addEventListener('click', function () { irisAction('applicationsExport') })
