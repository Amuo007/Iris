'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const career = require('../iris/agent/career')
const { parseObjectLoose } = require('../iris/agent/actionSchema')

const SAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'career-sample.json'), 'utf8'))
const JAKE = fs.readFileSync(path.join(__dirname, 'fixtures', 'resume-jake.tex'), 'utf8')

test('the bank keeps what the user wrote and fills in defaults', () => {
  const b = career.normalizeBank(SAMPLE)
  assert.strictEqual(b.experience.length, 3)
  assert.strictEqual(b.experience[0].bullets.length, 6)
  assert.strictEqual(b.prefs.fitCutoff, 60)
  assert.ok(b.answers.some(a => a.label === 'Work authorization' && a.value === 'Canadian citizen'))
  assert.ok(b.answers.some(a => a.label === 'Veteran status' && a.value === ''), 'every usual application question is there to fill in')
  const empty = career.normalizeBank(null)
  assert.ok(career.bankIsEmpty(empty))
  assert.deepStrictEqual(career.splitItems('Python, C++ (Qt, STL); Go'), ['Python', 'C++ (Qt, STL)', 'Go'])
})

test('text goes into LaTeX safely and comes back out', () => {
  assert.strictEqual(career.latexEscape('R&D 100% #1 C_x {a} **bold**'), 'R\\&D 100\\% \\#1 C\\_x \\{a\\} \\textbf{bold}')
  assert.strictEqual(career.latexEscape('61% → 78%'), '61\\% to 78\\%')
  assert.strictEqual(career.latexEscape('emoji 🚀 gone'), 'emoji  gone')
  assert.strictEqual(career.latexToPlain('Built \\textbf{fast} API with \\emph{Go} -- 2x \\href{https://x.y}{link} at A\\&M'), 'Built **fast** API with Go – 2x link at A&M')
})

test('templates repeat blocks, drop empty sections and optional lines', () => {
  const tpl = [
    '%%IRIS:if experience', 'EXP', '%%IRIS:each experience', 'T=<<title>>', 'L=<<link?>>',
    '%%IRIS:if bullets', '%%IRIS:each bullets', '* <<text>>', '%%IRIS:end bullets', '%%IRIS:endif bullets',
    '%%IRIS:end experience', '%%IRIS:endif experience',
    '%%IRIS:if projects', 'PROJ', '%%IRIS:endif projects',
    '%%IRIS:each skills join=\\\\', '<<group>>: <<items>>', '%%IRIS:end skills'
  ].join('\n')
  const out = career.renderTemplate(tpl, {
    experience: [{ title: 'A&B', bullets: ['one', 'two'] }, { title: 'C', link: 'x', bullets: [] }],
    projects: [],
    skills: [{ group: 'G1', items: ['a', 'b'] }, { group: 'G2', items: ['c'] }]
  }, { probe: false })
  assert.strictEqual(out, ['EXP', 'T=A\\&B', '* one', '* two', 'T=C', 'L=x', 'G1: a, b \\\\', 'G2: c'].join('\n'))
  assert.throws(() => career.renderTemplate('%%IRIS:each x\nno end', {}), /never closed/)
})

test('the built-in template knows every section', () => {
  assert.deepStrictEqual(career.templateSections(career.DEFAULT_TEMPLATE).sort(), ['education', 'experience', 'extras', 'projects', 'skills', 'summary'])
  const tex = career.renderTemplate(career.DEFAULT_TEMPLATE, career.layoutToDoc(career.normalizeBank(SAMPLE), career.initialLayout(career.normalizeBank(SAMPLE), career.keywordPick(career.normalizeBank(SAMPLE), { title: 'x' })), {}))
  assert.match(tex, /\\section\{Experience\}/)
  assert.match(tex, /IRIS-FILL/)
  assert.ok(!/^\s*%%IRIS:/m.test(tex), 'no markers are left in the output')
})

test('a Jake-style resume becomes a template, and its content becomes the bank', () => {
  const r = career.templatize(JAKE)
  assert.ok(r.ok)
  assert.deepStrictEqual(r.report.map(s => s.kind + ':' + s.status), ['education:mapped', 'experience:mapped', 'projects:mapped', 'skills:mapped'])
  assert.strictEqual(r.bank.experience.length, 3)
  assert.strictEqual(r.bank.experience[0].title, 'Undergraduate Research Assistant')
  assert.strictEqual(r.bank.experience[0].company, 'Texas A&M University')
  assert.strictEqual(r.bank.experience[2].bullets.length, 5)
  assert.strictEqual(r.bank.projects[0].name, 'Gitlytics')
  assert.strictEqual(r.bank.projects[0].tech, 'Python, Flask, React, PostgreSQL, Docker')
  assert.strictEqual(r.bank.education[0].school, 'Southwestern University')
  assert.deepStrictEqual(r.bank.skills.map(g => g.group), ['Languages', 'Frameworks', 'Developer Tools', 'Libraries'])
  assert.match(r.template, /\\textbf\{Sam Rivera\}|Sam Rivera/, 'the header is kept as written')
  assert.match(r.template, /\\resumeItem\{<<text>>\}/)
  // filled with its own content, it says the same thing again
  const again = career.renderTemplate(r.template, career.normalizeBank(r.bank), { probe: false })
  assert.match(again, /Contributed 50K\+ lines of code/)
})

test('a section Iris cannot follow is left exactly as written', () => {
  const tex = '\\documentclass{article}\\begin{document}\n\\section{Experience}\nI worked at places.\n\\section{Projects}\n\\begin{itemize}\n\\item Thing one\n\\end{itemize}\n\\end{document}\n'
  const r = career.templatize(tex)
  assert.strictEqual(r.report[0].status, 'kept')
  assert.match(r.template, /I worked at places\./)
  assert.strictEqual(career.templatize('no document here').ok, false)
})

test('the model\'s picks are checked: only bank items, no new facts', () => {
  const bank = career.normalizeBank(SAMPLE)
  const reply = JSON.stringify({
    fit: 88,
    focus: 'Embedded firmware',
    summary: 'Engineer who writes STM32 firmware on FreeRTOS.',
    skills: [{ group: 'Embedded', items: ['STM32', 'Zephyr'] }, { group: 'Made Up', items: ['FreeRTOS'] }],
    experience: [{ id: 'E1', bullets: ['E1.3', 'E9.9', 'E2.1'] }],
    projects: [{ id: 'P2', bullets: ['P2.1'] }, { id: 'P99' }],
    extras: ['X1', 'X7'],
    rewrite: {
      'E1.3': 'Cut brown-out resets by 90% with STM32 firmware in C on FreeRTOS',
      'E1.1': 'Built a telemetry pipeline on AWS with Kafka ingesting 5M events per day',
      'P2.1': 'Ran person detection on an ESP32-S3 at 4 frames per second'
    }
  })
  const pick = career.parseTailorReply('Here you go: ' + reply, bank, { title: 'Firmware' }, parseObjectLoose)
  assert.strictEqual(pick.fit, 88)
  assert.deepStrictEqual(pick.experience[0], { id: 'E1', bullets: ['E1.3'] }, 'bullets of another job or unknown IDs are dropped')
  assert.deepStrictEqual(pick.experience.map(e => e.id), ['E1', 'E2', 'E3'], 'a short work history stays complete')
  assert.deepStrictEqual(pick.projects.map(p => p.id), ['P2'])
  assert.deepStrictEqual(pick.extras, ['X1'])
  assert.deepStrictEqual(pick.skills, [{ group: 'Embedded', items: ['STM32', 'FreeRTOS'] }], 'unknown skills dropped, real ones kept under their real group')
  assert.ok(pick.rewrite['E1.3'], 'a reworded bullet with the same facts is kept')
  assert.ok(!pick.rewrite['E1.1'], 'a rewrite that adds Kafka and changes 2M to 5M is undone')
  assert.ok(pick.undone.some(u => u.id === 'E1.1'))
  assert.strictEqual(pick.summary, 'Engineer who writes STM32 firmware on FreeRTOS.')
})

test('without a usable reply the picks come from shared words', () => {
  const bank = career.normalizeBank(SAMPLE)
  const pick = career.parseTailorReply('sorry, no JSON', bank, { title: 'Android Developer', requirements: 'Kotlin Jetpack Compose Room Firebase' }, parseObjectLoose)
  assert.strictEqual(pick.usedModel, false)
  assert.strictEqual(pick.projects[0].id, 'P1', 'the Android project comes first')
  assert.strictEqual(pick.skills[0].group, 'Mobile')
})

test('numbers in a summary are refused; capitalised sentence starts are not "new facts"', () => {
  const bank = career.normalizeBank(SAMPLE)
  const a = career.parseTailorReply(JSON.stringify({ summary: 'Cut crashes by 99.6% across apps.', experience: [{ id: 'E1', bullets: ['E1.1'] }] }), bank, {}, parseObjectLoose)
  assert.strictEqual(a.summary, '')
  assert.deepStrictEqual(career.checkRewrite('Built apps in Kotlin. Shipped to Play.', 'Shipped to Play. Built apps in Kotlin.', ''), [])
})

/* a fake LaTeX: one page holds 20 lines; every entry and bullet is a line */
function fakeCompile (tex) {
  const lines = tex.split('\n').filter(l => /\\point\{|\\entryhead|\\projecthead|\\textbf\{[^}]*\}\{:/.test(l)).length
  const pages = Math.max(1, Math.ceil(lines / 20))
  const fill = (lines - (pages - 1) * 20) / 20
  return Promise.resolve({ ok: true, pages, fill })
}

test('too much for one page: the least important things go until it fits', async () => {
  const bank = career.normalizeBank(SAMPLE)
  const pick = career.keywordPick(bank, { title: 'Software Engineer', requirements: 'AWS Python' })
  const r = await career.fitToPage({ bank, pick, template: career.DEFAULT_TEMPLATE, compile: fakeCompile })
  assert.ok(r.ok)
  assert.strictEqual(r.pages, 1)
  assert.ok(r.steps.some(s => /^cut/.test(s)))
  assert.ok(r.doc.experience.every(e => e.bullets.length >= 1), 'every job keeps at least one bullet')
})

test('room left on the page: more true things are added', async () => {
  const bank = career.normalizeBank(SAMPLE)
  const pick = career.parseTailorReply(JSON.stringify({ experience: [{ id: 'E1', bullets: ['E1.1'] }, { id: 'E2', bullets: ['E2.1'] }, { id: 'E3', bullets: ['E3.1'] }], projects: [], skills: [{ group: 'Languages', items: ['Python'] }] }), bank, {}, parseObjectLoose)
  const r = await career.fitToPage({ bank, pick, template: career.DEFAULT_TEMPLATE, compile: fakeCompile })
  assert.strictEqual(r.pages, 1)
  assert.ok(r.steps.some(s => /^added/.test(s)))
  assert.ok(r.fill >= 0.9)
})

test('the PDF kept is the one of the layout kept, not of a last try that ran onto page 2', async () => {
  const bank = career.normalizeBank(SAMPLE)
  const pick = career.parseTailorReply(JSON.stringify({ experience: [{ id: 'E1', bullets: ['E1.1'] }, { id: 'E2', bullets: ['E2.1'] }, { id: 'E3', bullets: ['E3.1'] }], projects: [], skills: [{ group: 'Languages', items: ['Python'] }] }), bank, {}, parseObjectLoose)
  let builds = 0
  let last = null
  // the page never counts as full enough, so adding goes on until tries run onto page 2
  const compile = tex => fakeCompile(tex).then(r => { last = Object.assign(r, { fill: r.pages === 1 ? Math.min(r.fill, 0.5) : r.fill, pdfData: 'build ' + (++builds) + ' pages ' + r.pages }); return last })
  const r = await career.fitToPage({ bank, pick, template: career.DEFAULT_TEMPLATE, compile })
  assert.strictEqual(last.pages, 2, 'the last build was a try that overflowed')
  assert.strictEqual(r.pages, 1)
  assert.match(r.pdfData, / pages 1$/)
})

test('a LaTeX log says how many pages and how full', () => {
  const info = career.readLatexLog('IRIS-FILL 600.0pt 650.0pt\nOutput written on resume.pdf (1 page, 123 bytes).')
  assert.strictEqual(info.pages, 1)
  assert.ok(Math.abs(info.fill - 600 / 650) < 1e-9)
  const bad = career.readLatexLog('! Undefined control sequence.\nl.42 \\foo')
  assert.strictEqual(bad.pages, 0)
  assert.match(bad.error, /Undefined control sequence.*line 42/)
})

test('a rewrite may change words, but not add a claim', () => {
  const o = 'Wrote STM32 firmware in C on FreeRTOS for a battery-monitoring board; reduced brown-out resets by 90%'
  assert.deepStrictEqual(career.checkRewrite(o, 'Developed STM32 firmware in C using FreeRTOS for a battery-monitoring board, reducing brown-out resets by 90%', ''), [])
  assert.ok(career.checkRewrite(o, 'Developed STM32 firmware in C using FreeRTOS, reducing brown-out resets by 90% through low-power design optimizations', '').some(b => /^adds:/.test(b)))
})

test('a cover letter keeps only sentences the profile supports', () => {
  const bank = career.normalizeBank(SAMPLE)
  const r = career.parseCoverLetter('Dear Hiring Team,\n\nI am applying for the Embedded Firmware Engineer role at Northbridge. I wrote STM32 firmware on FreeRTOS at Northwind Robotics.\n\nI cut brown-out resets by 90%. I also led a team of 12 engineers using Rust.\n\nI am based in Toronto. Thank you for your time.\n\nSincerely, Jordan', bank, { company: 'Northbridge', title: 'Embedded Firmware Engineer' })
  assert.strictEqual(r.paragraphs.length, 3)
  assert.ok(r.removed.some(x => /team of 12/.test(x.sentence)), 'an invented team size goes')
  assert.match(r.paragraphs[2], /based in Toronto/, 'the profile\'s own location stays')
  const tex = career.coverLetterTex(bank, { company: 'Northbridge', title: 'Embedded Firmware Engineer' }, r.paragraphs, 'October 16, 2026')
  assert.match(tex, /Dear Hiring Team/)
  assert.match(tex, /brown-out resets by 90\\%/)
})

test('pasted text is sorted in without anything added', () => {
  const source = 'Jordan Lee\nSoftware Engineer, Northwind Robotics, Jul 2025 - Present\n- Built a fleet telemetry pipeline on AWS ingesting 2M events per day\nSkills: Python, Go, Terraform'
  const reply = JSON.stringify({
    skills: [{ group: 'Languages', items: ['Python', 'Go', 'Haskell'] }],
    experience: [{ title: 'Software Engineer', company: 'Northwind Robotics', dates: 'Jul 2025 - Present', bullets: ['Built a fleet telemetry pipeline on AWS ingesting 2M events per day', 'Led a migration to Kubernetes saving 40% of costs'] }]
  })
  const r = career.parseProfileFromText(reply, source, parseObjectLoose)
  assert.ok(r.ok)
  assert.deepStrictEqual(r.bank.experience[0].bullets, ['Built a fleet telemetry pipeline on AWS ingesting 2M events per day'])
  assert.deepStrictEqual(r.bank.skills[0].items, ['Python', 'Go'])
  assert.strictEqual(r.dropped.length, 2)
})

test('a decimal is not the end of a sentence in a cover letter', () => {
  const bank = career.normalizeBank(SAMPLE)
  const r = career.parseCoverLetter('I fixed 30+ crash reports from Firebase Crashlytics, raising crash-free sessions to 99.6%. I used Kotlin.', bank, { company: 'X', title: 'Y' })
  assert.match(r.paragraphs[0], /to 99\.6%\. I used Kotlin\./)
  assert.strictEqual(r.removed.length, 0)
})

test('"C/C++" is checked as C and C++', () => {
  const bank = career.normalizeBank(SAMPLE)
  const r = career.parseTailorReply(JSON.stringify({ summary: 'Engineer with embedded C/C++ work on STM32 and ESP32.', experience: [{ id: 'E1', bullets: ['E1.3'] }] }), bank, {}, parseObjectLoose)
  assert.strictEqual(r.summary, 'Engineer with embedded C/C++ work on STM32 and ESP32.')
})

test('Awesome-CV and moderncv resumes are read too', () => {
  const awesome = career.templatize(fs.readFileSync(path.join(__dirname, 'fixtures', 'resume-awesome.tex'), 'utf8'))
  assert.deepStrictEqual(awesome.report.map(r => r.kind + ':' + r.status), ['experience:mapped', 'education:mapped', 'skills:mapped'])
  assert.deepStrictEqual(awesome.bank.experience[0], { title: 'Backend Engineer', company: 'Harbor Logistics', location: 'Vancouver, BC', dates: 'Jun. 2023 - Present', bullets: ['Built a shipment tracking API in Go serving 3M requests per day', 'Moved batch jobs to Kubernetes CronJobs and cut costs by 28%', 'Led the migration from MySQL 5.7 to PostgreSQL 15'] })
  assert.deepStrictEqual(awesome.bank.skills[1], { group: 'Infrastructure', items: ['Kubernetes', 'Docker', 'Terraform', 'AWS'] })
  const mcv = career.templatize(fs.readFileSync(path.join(__dirname, 'fixtures', 'resume-moderncv.tex'), 'utf8'))
  assert.deepStrictEqual(mcv.report.map(r => r.status), ['mapped', 'mapped', 'mapped'])
  assert.strictEqual(mcv.bank.experience[0].bullets.length, 2)
  assert.strictEqual(mcv.bank.experience[0].location, 'Ottawa', 'a lone city is still the place, not frozen into the template')
  assert.match(mcv.template, /\\cventry\{<<dates>>\}\{<<title>>\}\{<<company>>\}\{<<location>>\}/)
})

test('the header gives the name, email, phone and links', () => {
  const r = career.templatize(JAKE)
  assert.strictEqual(r.bank.basics.name, 'Sam Rivera')
  assert.strictEqual(r.bank.basics.email, 'sam@example.com')
  assert.strictEqual(r.bank.basics.phone, '555-123-4567')
  assert.deepStrictEqual(r.bank.basics.links.map(l => l.url), ['https://github.com/samrivera'])
  assert.strictEqual(career.templatize(fs.readFileSync(path.join(__dirname, 'fixtures', 'resume-moderncv.tex'), 'utf8')).bank.basics.name, 'Riley Chen')
})

test('job tasks are told apart from tasks that merely say "apply" or "resume"', () => {
  const yes = [
    'Find jobs that match my career profile and apply to them one by one, with a resume tailored to each. Keep going until I stop you.',
    'Find new jobs that match my career profile and apply to them one by one, with a resume tailored to each. Skip jobs already handled. Stop when there are no new ones today.',
    'Find jobs that fit my career profile and apply with a resume tailored to each',
    'Apply for software engineer roles in Toronto',
    'find me an internship in embedded systems',
    'Look for firmware positions at AMD',
    'Apply here: https://boards.greenhouse.io/acme/jobs/123',
    'tailor my résumé for this posting',
    'Tailor my resume for the Tenstorrent opening',
    'send my CV to the hiring manager for the role',
    'Write a cover letter for the Ramp posting',
    'Go through my job applications and finish the ones that need me',
    'Go through the openings at Lumen Labs (http://localhost:8765/gh/) and apply to the ones that fit my profile.',
    'Apply for this role: https://jobs.example.test/123',
    'Apply to 3 positions at Shopify',
    'Check the Ramp careers page and apply where I fit'
  ]
  const no = [
    'apply the coupon SAVE10 at checkout',
    'Apply a price filter under $50 on Amazon',
    'resume the download in the other tab',
    'Find papers about job scheduling on GPUs',
    'apply dark mode in the settings',
    'apply the admin role to Sam in the dashboard',
    'Book a table for two on Friday'
  ]
  for (const t of yes) assert.ok(career.isJobTask(t), 'should be a job task: ' + t)
  for (const t of no) assert.ok(!career.isJobTask(t), 'should not be a job task: ' + t)
})

test('years a posting asks for, and years the profile shows', () => {
  assert.strictEqual(career.yearsAsked('3+ years running production systems on AWS; Kubernetes'), 3)
  assert.strictEqual(career.yearsAsked('At least 5 years of Go. 2-4 years in a startup is a plus'), 5)
  assert.strictEqual(career.yearsAsked('3 years of professional experience with C'), 3)
  assert.strictEqual(career.yearsAsked('We have been building sensors for 10 years. Python, C.'), 0)
  const bank = career.normalizeBank({ experience: [
    { title: 'Software Engineer', company: 'A', dates: 'Jul 2025 -- Present', bullets: ['x'] },
    { title: 'Intern', company: 'B', dates: 'May 2024 -- Aug 2024', bullets: ['y'] },
    { title: 'Intern', company: 'C', dates: 'Jun 2024 -- Jul 2024', bullets: ['z'] } // overlaps B: counted once
  ] })
  const years = career.yearsWorked(bank, Date.UTC(2026, 9, 16))
  assert.ok(years > 1.5 && years < 1.75, 'about 1.6 years, got ' + years)
})

test('a job asking for more years than the profile shows cannot get a high fit', () => {
  const bank = career.normalizeBank(SAMPLE)
  const reply = JSON.stringify({ fit: 85, focus: 'Cloud', why: 'Strong AWS', missing: [], experience: [{ id: 'E1', bullets: ['E1.1'] }], projects: [], skills: [] })
  const now = Date.UTC(2026, 9, 16)
  const far = career.parseTailorReply(reply, bank, { title: 'Senior PM', requirements: '6+ years of product management' }, parseObjectLoose, now)
  assert.ok(far.fit <= 50)
  assert.match(far.missing[0], /6\+ years asked/)
  const near = career.parseTailorReply(reply, bank, { title: 'Platform Engineer', requirements: '3+ years running production systems on AWS' }, parseObjectLoose, now)
  assert.ok(near.fit <= 65 && near.fit > 50)
  const ok = career.parseTailorReply(reply, bank, { title: 'Embedded', requirements: '1+ years writing C' }, parseObjectLoose, now)
  assert.strictEqual(ok.fit, 85)
})
