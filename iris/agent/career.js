'use strict'

/*
 * iris/agent/career.js — the Jobs side of Iris.
 *
 *   • the career bank: everything the user has done (skills, jobs, projects, education, extras),
 *     far more than fits on one page
 *   • LaTeX templates: the user's own resume with a few comment markers, so Iris can refill it
 *   • tailoring: for one job, the model picks (and may reword) what proves the job's needs —
 *     only from the bank, checked by code — and Iris fits the result onto exactly one page
 *
 * Pure: no Electron, no files, no network. Compiling LaTeX and calling the model are injected.
 *
 * Template markers are LaTeX comments, so a marked-up template still compiles on its own:
 *   %%IRIS:if experience        … %%IRIS:endif experience     (dropped when there is nothing to show)
 *   %%IRIS:each experience      … %%IRIS:end experience       (repeated per entry)
 *   %%IRIS:each skills join=\\  … %%IRIS:end skills           (entries joined by a LaTeX line break)
 *   <<title>>   a value, escaped for LaTeX          <<link?>>  optional: the line goes if it is empty
 */

const SECTION_KINDS = ['summary', 'skills', 'experience', 'projects', 'education', 'extras']

/* ------------------------------------------------------------------ *
 * The career bank
 * ------------------------------------------------------------------ */

function str (v, max) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max || 400)
}

function list (v, max, itemMax) {
  const arr = Array.isArray(v) ? v : String(v == null ? '' : v).split('\n')
  return arr.map(function (x) { return str(x, itemMax || 600).replace(/^[-•*·]\s+/, '') }).filter(Boolean).slice(0, max || 60)
}

/* "Python, C++ (Qt, STL), Go" → ["Python", "C++ (Qt, STL)", "Go"]: commas inside brackets stay */
function splitItems (text) {
  const out = []
  let depth = 0
  let cur = ''
  for (const c of String(text || '')) {
    if (c === '(' || c === '[') depth++
    if (c === ')' || c === ']') depth = Math.max(0, depth - 1)
    if ((c === ',' || c === ';') && depth === 0) { out.push(cur); cur = ''; continue }
    cur += c
  }
  out.push(cur)
  return out.map(function (s) { return str(s, 80) }).filter(Boolean)
}

const DEFAULT_ANSWERS = [
  'Work authorization', 'Needs visa sponsorship', 'Earliest start date', 'Willing to relocate',
  'Years of experience', 'LinkedIn', 'GitHub', 'Portfolio / website', 'Gender', 'Race / ethnicity', 'Veteran status', 'Disability status'
]

const DEFAULT_PREFS = {
  roles: '', // what to look for, e.g. "Software Engineer, ML Engineer"
  locations: '',
  workplace: 'any', // any | remote | hybrid | onsite
  salary: '',
  fitCutoff: 60, // below this match score a job is skipped
  autoSubmit: true, // false: Iris asks before it submits each application
  dailyLimit: 0, // 0 = no limit
  summary: true, // write a short summary line at the top when the template has one
  tailor: true, // false: no new resume per job, no fit check; the user's own PDF goes out as it is
  resumeFile: '' // that PDF (used when tailor is false)
}

function normalizeBank (raw) {
  const b = raw && typeof raw === 'object' ? raw : {}
  const basics = b.basics && typeof b.basics === 'object' ? b.basics : {}
  const prefs = Object.assign({}, DEFAULT_PREFS, b.prefs && typeof b.prefs === 'object' ? b.prefs : {})
  prefs.fitCutoff = Math.max(0, Math.min(100, Math.round(Number(prefs.fitCutoff)))) || 0
  prefs.dailyLimit = Math.max(0, Math.round(Number(prefs.dailyLimit) || 0))
  prefs.autoSubmit = prefs.autoSubmit !== false
  prefs.summary = prefs.summary !== false
  prefs.tailor = prefs.tailor !== false
  prefs.resumeFile = typeof prefs.resumeFile === 'string' ? prefs.resumeFile.trim().slice(0, 1000) : ''
  if (['any', 'remote', 'hybrid', 'onsite'].indexOf(prefs.workplace) === -1) prefs.workplace = 'any'
  ;['roles', 'locations', 'salary'].forEach(function (k) { prefs[k] = str(prefs[k], 300) })

  const answers = (Array.isArray(b.answers) ? b.answers : []).map(function (a) {
    if (!a || typeof a !== 'object') return null
    const out = { label: str(a.label, 200), value: str(a.value, 400) }
    if (Number(a.learned) > 0) out.learned = Number(a.learned) // saved from a reply during an application
    return out
  }).filter(function (a) { return a && a.label })
  DEFAULT_ANSWERS.forEach(function (label) {
    if (!answers.some(function (a) { return a.label.toLowerCase() === label.toLowerCase() })) answers.push({ label: label, value: '' })
  })

  return {
    version: 1,
    basics: {
      name: str(basics.name, 120),
      email: str(basics.email, 120),
      phone: str(basics.phone, 60),
      location: str(basics.location, 120),
      links: (Array.isArray(basics.links) ? basics.links : []).map(function (l) {
        return l && typeof l === 'object' ? { label: str(l.label, 60), url: str(l.url, 300) } : null
      }).filter(function (l) { return l && (l.label || l.url) }).slice(0, 8)
    },
    about: String(b.about || '').trim().slice(0, 4000),
    skills: (Array.isArray(b.skills) ? b.skills : []).map(function (g) {
      if (!g || typeof g !== 'object') return null
      const items = Array.isArray(g.items) ? g.items.map(function (x) { return str(x, 80) }).filter(Boolean) : splitItems(g.items)
      return { group: str(g.group, 60) || 'Skills', items: items.slice(0, 80) }
    }).filter(function (g) { return g && g.items.length }).slice(0, 30),
    experience: (Array.isArray(b.experience) ? b.experience : []).map(function (e) {
      if (!e || typeof e !== 'object') return null
      return { title: str(e.title, 120), company: str(e.company, 120), location: str(e.location, 80), dates: str(e.dates, 60), bullets: list(e.bullets, 40) }
    }).filter(function (e) { return e && (e.title || e.company) }).slice(0, 40),
    projects: (Array.isArray(b.projects) ? b.projects : []).map(function (p) {
      if (!p || typeof p !== 'object') return null
      return { name: str(p.name, 120), tech: str(p.tech, 200), link: str(p.link, 300), dates: str(p.dates, 60), bullets: list(p.bullets, 30) }
    }).filter(function (p) { return p && p.name }).slice(0, 80),
    education: (Array.isArray(b.education) ? b.education : []).map(function (e) {
      if (!e || typeof e !== 'object') return null
      return { school: str(e.school, 160), degree: str(e.degree, 160), location: str(e.location, 80), dates: str(e.dates, 60), details: list(e.details, 12) }
    }).filter(function (e) { return e && (e.school || e.degree) }).slice(0, 12),
    extras: (Array.isArray(b.extras) ? b.extras : []).map(function (x) {
      if (typeof x === 'string') return { kind: '', text: str(x, 300) }
      return x && typeof x === 'object' ? { kind: str(x.kind, 40), text: str(x.text, 300) } : null
    }).filter(function (x) { return x && x.text }).slice(0, 60),
    prefs: prefs,
    answers: answers.slice(0, 60)
  }
}

function bankIsEmpty (bank) {
  return !bank || (!bank.experience.length && !bank.projects.length && !bank.skills.length)
}

function bankCounts (bank) {
  return {
    skills: bank.skills.reduce(function (n, g) { return n + g.items.length }, 0),
    experience: bank.experience.length,
    bullets: bank.experience.reduce(function (n, e) { return n + e.bullets.length }, 0) + bank.projects.reduce(function (n, p) { return n + p.bullets.length }, 0),
    projects: bank.projects.length,
    education: bank.education.length,
    extras: bank.extras.length
  }
}

/* ------------------------------------------------------------------ *
 * LaTeX text
 * ------------------------------------------------------------------ */

/* pdfLaTeX stops on characters it has no glyph for (emoji, most symbols): keep what it can print */
function printable (s) {
  return String(s).replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/\u2022/g, '\u00B7')
    .replace(/\s*[\u2192\u27F6\u21D2]\s*/g, ' to ').replace(/\u2264/g, '<=').replace(/\u2265/g, '>=').replace(/\u2248/g, '~')
    .replace(/[^\u0009\u000A\u000D\u0020-\u017F\u2013\u2014\u2026\u20AC\u00B7]/g, '')
}

/** Plain text → LaTeX. **bold** becomes \textbf{bold}. */
function latexEscape (text) {
  const s = printable(text)
    .replace(/\\/g, '\u0000')
    .replace(/([&%$#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/</g, '\\textless{}')
    .replace(/>/g, '\\textgreater{}')
    .replace(/\u0000/g, '\\textbackslash{}')
    .replace(/"([^"\n]+)"/g, '``$1\'\'')
  return s.replace(/\*\*([^*\n]+)\*\*/g, '\\textbf{$1}')
}

/** Read one {…} group starting at s[i] === '{'. Escaped braces do not count. */
function readGroup (s, i) {
  if (s[i] !== '{') return null
  let depth = 0
  for (let j = i; j < s.length; j++) {
    const c = s[j]
    if (c === '\\') { j++; continue }
    if (c === '%') { const nl = s.indexOf('\n', j); if (nl === -1) return null; j = nl; continue }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return { start: i, end: j + 1, content: s.slice(i + 1, j) }
    }
  }
  return null
}

/** LaTeX → plain text (formatting dropped, bold kept as **x**, links as their text). */
function latexToPlain (tex) {
  let s = String(tex || '')
  s = s.replace(/(^|[^\\])%.*$/gm, '$1') // comments
  // \href{url}{text} → text
  for (let guard = 0; guard < 50 && s.indexOf('\\href') !== -1; guard++) {
    const i = s.indexOf('\\href')
    const a = readGroup(s, s.indexOf('{', i))
    const b = a ? readGroup(s, a.end) : null
    if (!a || !b) break
    s = s.slice(0, i) + b.content + s.slice(b.end)
  }
  s = s.replace(/\\textbf\s*\{/g, '\u0001{') // keep bold, as **x**
  // formatting commands that wrap text: keep the text
  for (let guard = 0; guard < 200; guard++) {
    const m = /\\(?:textit|emph|underline|textsc|texttt|textsf|textrm|uline|mbox|text|small|footnotesize|scriptsize|large|Large|normalsize)\s*\{/.exec(s)
    if (!m) break
    const g = readGroup(s, m.index + m[0].length - 1)
    if (!g) break
    s = s.slice(0, m.index) + g.content + s.slice(g.end)
  }
  for (let guard = 0; guard < 200; guard++) {
    const i = s.indexOf('\u0001{')
    if (i === -1) break
    const g = readGroup(s, i + 1)
    if (!g) { s = s.slice(0, i) + s.slice(i + 1); continue }
    const inner = g.content.trim()
    s = s.slice(0, i) + (inner ? '**' + inner + '**' : '') + s.slice(g.end)
  }
  s = s.replace(/\\(vspace|hspace)\*?\s*\{[^}]*\}/g, ' ')
  s = s.replace(/\$\\cdot\$|\$\\bullet\$/g, '·').replace(/\$\s*\|\s*\$/g, '|').replace(/\$([^$]*)\$/g, '$1')
  s = s.replace(/\\textasciitilde\{\}/g, '~').replace(/\\textasciicircum\{\}/g, '^').replace(/\\textbackslash\{\}/g, '\\')
    .replace(/\\textless\{\}/g, '<').replace(/\\textgreater\{\}/g, '>')
  s = s.replace(/\\([&%$#_{}])/g, '$1')
  s = s.replace(/---/g, '—').replace(/--/g, '–').replace(/``/g, '"').replace(/''/g, '"')
  s = s.replace(/\\\\(\[[^\]]*\])?/g, ' ').replace(/\\(?:newline|par|noindent|centering|raggedright|bfseries|itshape|scshape|hfill|quad|qquad)\b/g, ' ')
  s = s.replace(/~/g, ' ')
  s = s.replace(/\\[a-zA-Z]+\*?/g, ' ').replace(/[{}]/g, '')
  return s.replace(/\*\*\s*\*\*/g, '').replace(/\s+/g, ' ').trim()
}

/* ------------------------------------------------------------------ *
 * Templates
 * ------------------------------------------------------------------ */

const MARK = /^\s*%%IRIS:(if|endif|each|end)\s+([a-z]+)(?:\s+join=(\S+))?\s*$/

function parseTemplate (tex) {
  const root = { type: 'root', children: [] }
  const stack = [root]
  const errors = []
  String(tex || '').split('\n').forEach(function (line, n) {
    const m = MARK.exec(line)
    const top = stack[stack.length - 1]
    if (!m) { top.children.push({ type: 'text', line: line }); return }
    if (m[1] === 'if' || m[1] === 'each') {
      const node = { type: m[1], name: m[2], join: m[3] || '', children: [] }
      top.children.push(node)
      stack.push(node)
    } else {
      const want = m[1] === 'endif' ? 'if' : 'each'
      if (top.type !== want || top.name !== m[2]) errors.push('line ' + (n + 1) + ': %%IRIS:' + m[1] + ' ' + m[2] + ' does not close an open "' + want + ' ' + m[2] + '"')
      else stack.pop()
    }
  })
  stack.slice(1).forEach(function (node) { errors.push('%%IRIS:' + node.type + ' ' + node.name + ' is never closed') })
  return { root: root, errors: errors }
}

/** Which parts of a CV a template fills in. */
function templateSections (tex) {
  const parsed = parseTemplate(tex)
  const found = new Set()
  const walk = function (nodes) {
    nodes.forEach(function (n) {
      if ((n.type === 'each' || n.type === 'if') && SECTION_KINDS.indexOf(n.name) !== -1) found.add(n.name)
      if (n.children) walk(n.children)
    })
  }
  walk(parsed.root.children)
  const top = parsed.root.children.filter(function (n) { return n.type === 'text' }).map(function (n) { return n.line }).join('\n')
  if (/<<summary\??>>/.test(top)) found.add('summary')
  return Array.from(found)
}

const RAW_FIELDS = new Set(['contact'])

function lookup (scopes, name) {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const s = scopes[i]
    if (s && Object.prototype.hasOwnProperty.call(s, name)) return s[name]
  }
  return undefined
}

function present (v) {
  if (Array.isArray(v)) return v.length > 0
  return v !== undefined && v !== null && String(v).trim() !== ''
}

function renderNodes (nodes, scopes, out) {
  nodes.forEach(function (node) {
    if (node.type === 'text') {
      let drop = false
      const line = node.line.replace(/<<([a-zA-Z]+)(\?)?>>/g, function (all, name, optional) {
        const v = lookup(scopes, name)
        if (!present(v)) { if (optional) drop = true; return '' }
        if (RAW_FIELDS.has(name)) return String(v)
        return latexEscape(Array.isArray(v) ? v.join(', ') : v)
      })
      if (!drop) out.push(line)
    } else if (node.type === 'if') {
      if (present(lookup(scopes, node.name))) renderNodes(node.children, scopes, out)
    } else if (node.type === 'each') {
      const items = lookup(scopes, node.name)
      if (!Array.isArray(items)) return
      items.forEach(function (item, i) {
        const before = out.length
        renderNodes(node.children, scopes.concat([typeof item === 'object' && item ? item : { text: item }]), out)
        if (node.join && i < items.length - 1) {
          for (let k = out.length - 1; k >= before; k--) {
            if (out[k].trim()) { out[k] = out[k].replace(/\s*$/, ' ' + node.join); break }
          }
        }
      })
    }
  })
}

/** The page-fill probe: how much of the last page the content uses. */
const FILL_PROBE = '\\par\\typeout{IRIS-FILL \\the\\pagetotal\\space \\the\\pagegoal}'

function renderTemplate (tex, doc, options) {
  const parsed = parseTemplate(tex)
  if (parsed.errors.length) throw new Error('The resume template has a marker problem: ' + parsed.errors[0])
  const out = []
  renderNodes(parsed.root.children, [doc || {}], out)
  let text = out.join('\n')
  if (!options || options.probe !== false) {
    const end = text.lastIndexOf('\\end{document}')
    if (end !== -1) text = text.slice(0, end) + FILL_PROBE + '\n' + text.slice(end)
  }
  return text
}

/* The built-in template: a clean, classic one-page layout (letter paper, 11 pt). */
const DEFAULT_TEMPLATE = String.raw`%% Iris Classic resume template.
%% Lines starting with %%IRIS: mark what Iris fills in for each job; <<field>> is a value.
\documentclass[letterpaper,11pt]{article}
\usepackage[empty]{fullpage}
\usepackage{titlesec}
\usepackage[usenames,dvipsnames]{color}
\usepackage{enumitem}
\usepackage[hidelinks]{hyperref}
\usepackage[english]{babel}
\usepackage{tabularx}
\input{glyphtounicode}
\pdfgentounicode=1

\addtolength{\oddsidemargin}{-0.5in}
\addtolength{\evensidemargin}{-0.5in}
\addtolength{\textwidth}{1in}
\addtolength{\topmargin}{-0.5in}
\addtolength{\textheight}{1.0in}
\urlstyle{same}
\raggedbottom
\raggedright
\setlength{\tabcolsep}{0in}
\titleformat{\section}{\vspace{-4pt}\scshape\raggedright\large}{}{0em}{}[\color{black}\titlerule\vspace{-5pt}]

\newcommand{\entryhead}[4]{\vspace{-2pt}\item
  \begin{tabular*}{\textwidth}[t]{l@{\extracolsep{\fill}}r}
    \textbf{#1} & #2 \\
    \textit{\small #3} & \textit{\small #4} \\
  \end{tabular*}\vspace{-7pt}}
\newcommand{\projecthead}[2]{\item
  \begin{tabular*}{\textwidth}{l@{\extracolsep{\fill}}r}
    \small #1 & #2 \\
  \end{tabular*}\vspace{-7pt}}
\newcommand{\point}[1]{\item\small{#1 \vspace{-2pt}}}
\newcommand{\entriesbegin}{\begin{itemize}[leftmargin=0.15in, label={}]}
\newcommand{\entriesend}{\end{itemize}}
\newcommand{\pointsbegin}{\begin{itemize}}
\newcommand{\pointsend}{\end{itemize}\vspace{-5pt}}
\renewcommand\labelitemii{$\vcenter{\hbox{\tiny$\bullet$}}$}

\begin{document}

\begin{center}
  {\Huge \scshape <<name>>} \\ \vspace{2pt}
  \small <<contact>>
\end{center}

%%IRIS:if summary
\section{Summary}
\small <<summary>>
%%IRIS:endif summary

%%IRIS:if education
\section{Education}
\entriesbegin
%%IRIS:each education
\entryhead{<<school>>}{<<location>>}{<<degree>>}{<<dates>>}
%%IRIS:if details
\pointsbegin
%%IRIS:each details
\point{<<text>>}
%%IRIS:end details
\pointsend
%%IRIS:endif details
%%IRIS:end education
\entriesend
%%IRIS:endif education

%%IRIS:if experience
\section{Experience}
\entriesbegin
%%IRIS:each experience
\entryhead{<<title>>}{<<dates>>}{<<company>>}{<<location>>}
%%IRIS:if bullets
\pointsbegin
%%IRIS:each bullets
\point{<<text>>}
%%IRIS:end bullets
\pointsend
%%IRIS:endif bullets
%%IRIS:end experience
\entriesend
%%IRIS:endif experience

%%IRIS:if projects
\section{Projects}
\entriesbegin
%%IRIS:each projects
\projecthead{\textbf{<<name>>} $|$ \emph{<<tech>>}}{<<dates>>}
%%IRIS:if bullets
\pointsbegin
%%IRIS:each bullets
\point{<<text>>}
%%IRIS:end bullets
\pointsend
%%IRIS:endif bullets
%%IRIS:end projects
\entriesend
%%IRIS:endif projects

%%IRIS:if skills
\section{Technical Skills}
\begin{itemize}[leftmargin=0.15in, label={}]
\small{\item{
%%IRIS:each skills join=\\
\textbf{<<group>>}{: <<items>>}
%%IRIS:end skills
}}
\end{itemize}
%%IRIS:endif skills

%%IRIS:if extras
\section{Certifications \& Awards}
\entriesbegin
%%IRIS:each extras
\point{<<text>>}
%%IRIS:end extras
\entriesend
%%IRIS:endif extras

\end{document}
`

/** Header line for the built-in template: email | phone | location | links. */
function contactLine (basics) {
  const parts = []
  if (basics.phone) parts.push(latexEscape(basics.phone))
  if (basics.email) parts.push('\\href{mailto:' + latexEscape(basics.email) + '}{\\underline{' + latexEscape(basics.email) + '}}')
  if (basics.location) parts.push(latexEscape(basics.location))
  ;(basics.links || []).forEach(function (l) {
    if (!l.url) return
    const url = /^https?:\/\//.test(l.url) ? l.url : 'https://' + l.url
    parts.push('\\href{' + url.replace(/([%#&_])/g, '\\$1') + '}{\\underline{' + latexEscape(l.label || l.url.replace(/^https?:\/\/(www\.)?/, '')) + '}}')
  })
  return parts.join(' $|$ ')
}

/* ------------------------------------------------------------------ *
 * Turning the user's own LaTeX resume into a template (and their content into a bank)
 * ------------------------------------------------------------------ */

const DATE_RE = /\b(19|20)\d{2}\b|\bpresent\b|\bcurrent\b|\bnow\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\b/i
const LOCATION_RE = /\bremote\b|\bhybrid\b|^[A-Z][A-Za-z .'-]+,\s*[A-Z]{2}\b|^[A-Z][A-Za-z .'-]+,\s*[A-Z][a-z]+|\b(usa|canada|india|uk|germany|ontario|california|texas|new york)\b/i
const ROLE_RE = /\b(engineer|developer|intern|internship|manager|analyst|scientist|researcher|assistant|lead|designer|consultant|specialist|architect|technician|administrator|director|officer|associate|fellow|tutor|teaching|founder|co-founder|programmer|head|coordinator|representative|contractor|freelance)/i
const SCHOOL_RE = /\b(university|college|institute|school|academy|polytechnic|universit)/i
const DEGREE_RE = /\b(bachelor|master|b\.?\s?s\.?c?\b|m\.?\s?s\.?c?\b|ph\.?\s?d|associate|diploma|b\.?\s?tech|m\.?\s?tech|b\.?\s?e\.?\b|m\.?\s?e\.?\b|b\.?\s?a\.?\b|m\.?\s?b\.?\s?a|degree|major|minor|honou?rs|certificate|gpa)/i

function classifySection (title) {
  const t = String(title || '').toLowerCase()
  if (/project/.test(t)) return 'projects'
  if (/experience|employment|work history|professional|internship/.test(t) && !/volunteer|leadership/.test(t)) return 'experience'
  if (/skill|technolog|tool/.test(t)) return 'skills'
  if (/education|academic/.test(t)) return 'education'
  if (/summary|profile|objective|about/.test(t)) return 'summary'
  if (/certif|award|honou?r|achievement|publication|course/.test(t)) return 'extras'
  return null
}

/** Macro calls that start a line: \name[opt]{a}{b}… with their argument groups. */
function lineCalls (text) {
  const calls = []
  const re = /(^|\n)([ \t]*)\\([A-Za-z]+)\*?/g
  let m
  while ((m = re.exec(text)) !== null) {
    const lineStart = m.index + m[1].length
    let i = m.index + m[0].length
    const args = []
    for (;;) {
      // arguments may sit on the following lines (\resumeSubheading⏎ {Title}{Dates}⏎ {Company}{City})
      let j = i
      for (;;) {
        while (j < text.length && /\s/.test(text[j]) && !(text[j] === '\n' && text[j + 1] === '\n')) j++
        // a comment between arguments ("{Backend Engineer} % Job title")
        if (text[j] === '%') { const nl = text.indexOf('\n', j); if (nl === -1) break; j = nl + 1; continue }
        break
      }
      if (text[j] === '[') { const close = text.indexOf(']', j); if (close === -1) break; j = close + 1; while (/\s/.test(text[j] || '')) j++ }
      if (text[j] !== '{') break
      const g = readGroup(text, j)
      if (!g) break
      args.push(g)
      i = g.end
    }
    let lineEnd = text.indexOf('\n', i)
    if (lineEnd === -1) lineEnd = text.length
    calls.push({ name: m[3], lineStart: lineStart, start: lineStart + m[2].length, end: i, lineEnd: lineEnd, args: args })
  }
  return calls
}

const NOT_HEADINGS = new Set(['href', 'textbf', 'textit', 'emph', 'underline', 'begin', 'end', 'item', 'vspace', 'hspace', 'small', 'section', 'subsection', 'textsc', 'large', 'Large', 'huge', 'Huge', 'centering', 'noindent', 'par', 'hfill', 'newline'])

function mostCommon (names) {
  const count = {}
  names.forEach(function (n) { count[n] = (count[n] || 0) + 1 })
  let best = null
  names.forEach(function (n) { if (!best || count[n] > count[best]) best = n })
  return best
}

/* the line that closes a list opened by `opener` (\begin{x} → \end{x}, \fooStart → \fooEnd) */
function closerFor (opener) {
  const t = String(opener || '').trim()
  let m = /^\\begin\{([^}]+)\}/.exec(t)
  if (m) return '\\end{' + m[1] + '}'
  m = /^\\([A-Za-z]*?)(Start|Begin|begin|start)\b/.exec(t)
  if (m) return '\\' + m[1] + (m[2][0] === 'S' ? 'End' : m[2][0] === 'B' ? 'End' : 'end')
  return null
}

function lastLine (text) {
  const lines = String(text).split('\n').map(function (l) { return l.trim() }).filter(Boolean)
  return lines[lines.length - 1] || ''
}

/* Bullets of one entry: a one-argument macro per line (\resumeItem{…}) or \item lines. */
function findBullets (entryText, bulletMacro, skipFirst) {
  const out = []
  if (bulletMacro) {
    lineCalls(entryText).forEach(function (c) {
      if (c.name === bulletMacro && c.args.length >= 1) out.push({ lineStart: c.lineStart, lineEnd: c.lineEnd, arg: c.args[c.args.length - 1], call: c })
    })
  } else {
    const re = /(^|\n)([ \t]*)\\item\b[ \t]*/g
    let m
    while ((m = re.exec(entryText)) !== null) {
      const lineStart = m.index + m[1].length
      if (skipFirst && lineStart < skipFirst) continue
      const textStart = m.index + m[0].length
      let lineEnd = entryText.indexOf('\n', textStart)
      if (lineEnd === -1) lineEnd = entryText.length
      // "\item {text}" keeps its braces in the template; "\item text}" (last item inside an argument) keeps the brace after it
      const line = entryText.slice(textStart, lineEnd)
      if (line[0] === '{') {
        const g = readGroup(entryText, textStart)
        if (g && g.end <= lineEnd) { out.push({ lineStart: lineStart, lineEnd: lineEnd, arg: g, call: { braced: true } }); continue }
      }
      const tail = /(\}+\s*)$/.exec(line)
      const textEnd = tail && !/\{/.test(line) ? lineEnd - tail[1].length : lineEnd
      out.push({ lineStart: lineStart, lineEnd: lineEnd, arg: { start: textStart - 1, end: textEnd + 1, content: entryText.slice(textStart, textEnd) }, plainLine: true, tail: entryText.slice(textEnd, lineEnd) })
    }
  }
  return out
}

/* Which heading argument holds which field, judged over all entries of a section. */
function mapColumns (kind, entries) {
  const n = entries[0].args.length
  const fields = new Array(n).fill(null)
  const col = function (j) { return entries.map(function (e) { return e.args[j] ? latexToPlain(e.args[j].content) : '' }) }
  const share = function (vals, re) { return vals.filter(function (v) { return re.test(v) }).length / Math.max(1, vals.filter(Boolean).length) }
  const taken = new Set()
  const pick = function (field, j) { fields[j] = field; taken.add(field) }
  for (let j = 0; j < n; j++) if (share(col(j), DATE_RE) >= 0.6 && !/[a-z]{4,}\s+[a-z]{4,}\s+[a-z]{4,}/i.test(col(j)[0])) { if (!taken.has('dates')) pick('dates', j) }
  for (let j = 0; j < n; j++) if (!fields[j] && share(col(j), LOCATION_RE) >= 0.6 && !taken.has('location')) pick('location', j)
  const rest = []
  for (let j = 0; j < n; j++) if (!fields[j]) rest.push(j)
  if (kind === 'experience') {
    const role = rest.filter(function (j) { return share(col(j), ROLE_RE) >= 0.5 })
    const titleCol = role.length ? role[0] : rest[0]
    if (titleCol !== undefined) pick('title', titleCol)
    const other = rest.filter(function (j) { return j !== titleCol })
    if (other.length) pick('company', other[0])
  } else if (kind === 'education') {
    const school = rest.filter(function (j) { return share(col(j), SCHOOL_RE) >= 0.5 })
    const degree = rest.filter(function (j) { return share(col(j), DEGREE_RE) >= 0.5 && school.indexOf(j) === -1 })
    const schoolCol = school.length ? school[0] : rest.filter(function (j) { return degree.indexOf(j) === -1 })[0]
    if (schoolCol !== undefined) pick('school', schoolCol)
    const other = rest.filter(function (j) { return j !== schoolCol })
    const degreeCol = degree.length && degree[0] !== schoolCol ? degree[0] : other[0]
    if (degreeCol !== undefined) pick('degree', degreeCol)
  } else if (kind === 'projects') {
    if (rest.length) pick('name', rest[0])
    if (rest.length > 1) pick('tech', rest[1])
  }
  // a short text column left over ("Ottawa") is the place, when no column was recognised as one
  if (!taken.has('location') && kind !== 'projects') {
    for (let j = 0; j < n; j++) {
      const vals = col(j).filter(Boolean)
      if (!fields[j] && vals.length && vals.every(function (v) { return v.split(/\s+/).length <= 4 && !/\d/.test(v) && !/\*\*|\\/.test(v) })) { pick('location', j); break }
    }
  }
  return fields
}

/*
 * A projects heading often packs two fields into one argument: \textbf{Name} $|$ \emph{Tech}.
 * Returns the argument as a template and the values it held.
 */
function splitComposite (content) {
  const bold = /\\textbf\s*\{/.exec(content)
  const em = /\\(emph|textit)\s*\{/.exec(content)
  if (bold && em) {
    const b = readGroup(content, bold.index + bold[0].length - 1)
    const e = readGroup(content, em.index + em[0].length - 1)
    if (b && e && b.end <= e.start) {
      return {
        template: content.slice(0, b.start + 1) + '<<name>>' + content.slice(b.end - 1, e.start + 1) + '<<tech>>' + content.slice(e.end - 1),
        values: { name: latexToPlain(b.content).replace(/\*\*/g, ''), tech: latexToPlain(e.content) }
      }
    }
  }
  if (bold) {
    const b = readGroup(content, bold.index + bold[0].length - 1)
    if (b) return { template: content.slice(0, b.start + 1) + '<<name>>' + content.slice(b.end - 1), values: { name: latexToPlain(b.content).replace(/\*\*/g, '') } }
  }
  return null
}

function replaceRanges (text, ranges) {
  let out = text
  ranges.slice().sort(function (a, b) { return b.start - a.start }).forEach(function (r) { out = out.slice(0, r.start) + r.text + out.slice(r.end) })
  return out
}

/* An entries section (experience, projects, education): one entry becomes the repeated block. */
function templatizeEntries (kind, body) {
  const calls = lineCalls(body)
  const heads = calls.filter(function (c) { return c.args.length >= 2 && !NOT_HEADINGS.has(c.name) })
  if (!heads.length) return null
  const headName = mostCommon(heads.map(function (c) { return c.name }))
  const headCalls = heads.filter(function (c) { return c.name === headName })

  const prefix = body.slice(0, headCalls[0].lineStart)
  const closer = closerFor(lastLine(prefix))
  let entriesEnd = body.length
  if (closer) {
    const at = body.lastIndexOf(closer)
    if (at > headCalls[headCalls.length - 1].start) entriesEnd = body.lastIndexOf('\n', at) + 1 || at
  }
  const entries = headCalls.map(function (h, i) {
    const end = i + 1 < headCalls.length ? headCalls[i + 1].lineStart : entriesEnd
    return { start: h.lineStart, end: end, text: body.slice(h.lineStart, end), head: h, args: h.args }
  })
  if (entries.some(function (e) { return e.args.length !== entries[0].args.length })) return null

  // bullets: the most common one-argument line macro inside the entries, or \item
  const inner = []
  entries.forEach(function (e) {
    lineCalls(e.text).forEach(function (c) { if (c.args.length === 1 && c.name !== headName && !NOT_HEADINGS.has(c.name)) inner.push(c.name) })
  })
  const bulletMacro = inner.length ? mostCommon(inner) : null

  // bullets may live inside one of the heading's own arguments (Awesome-CV, moderncv)
  const bulletArg = entries[0].args.findIndex(function (a, j) {
    return entries.some(function (e) { return e.args[j] && /\\item\b/.test(e.args[j].content) })
  })
  if (bulletArg !== -1) entries.forEach(function (e) { e.argsForFields = e.args.map(function (a, j) { return j === bulletArg ? { content: '' } : a }) })
  const fields = mapColumns(kind, entries.map(function (e) { return { args: e.argsForFields || e.args } }))
  if (bulletArg !== -1) fields[bulletArg] = null
  const bulletsFrom = function (e) { return bulletArg !== -1 && e.args[bulletArg] ? e.args[bulletArg].start - e.start : e.head.end - e.start }
  const values = entries.map(function (e) {
    const v = {}
    e.args.forEach(function (a, j) {
      if (kind === 'projects' && j === fields.indexOf('name')) {
        const comp = splitComposite(a.content)
        if (comp) { Object.assign(v, comp.values); return }
      }
      if (fields[j]) v[fields[j]] = latexToPlain(a.content).replace(/^\*\*(.*)\*\*$/, '$1')
    })
    v.bullets = findBullets(e.text, bulletArg !== -1 ? null : bulletMacro, bulletsFrom(e)).map(function (b) { return latexToPlain(b.arg.content) }).filter(Boolean)
    return v
  })

  // the entry with bullets (if any) is the model for every entry
  const modelIndex = Math.max(0, values.findIndex(function (v) { return v.bullets.length > 0 }))
  const model = entries[modelIndex]
  const bullets = findBullets(model.text, bulletArg !== -1 ? null : bulletMacro, bulletsFrom(model))
  const ranges = []
  model.args.forEach(function (a, j) {
    const s = a.start - model.start + 1
    const t = a.end - model.start - 1
    if (kind === 'projects' && j === fields.indexOf('name')) {
      const comp = splitComposite(a.content)
      if (comp) { ranges.push({ start: s, end: t, text: comp.template }); return }
    }
    if (fields[j]) ranges.push({ start: s, end: t, text: '<<' + fields[j] + '>>' })
  })
  const listName = kind === 'education' ? 'details' : 'bullets'
  if (bullets.length) {
    const first = bullets[0]
    const lastB = bullets[bullets.length - 1]
    let lineTpl = model.text.slice(first.lineStart, first.lineEnd)
    const argS = first.arg.start - first.lineStart + 1
    const argE = first.plainLine ? lineTpl.length : first.arg.end - first.lineStart - 1
    lineTpl = lineTpl.slice(0, argS) + '<<text>>' + lineTpl.slice(argE)
    if (first.plainLine) lineTpl = model.text.slice(first.lineStart, first.arg.start + 1) + '<<text>>'
    // the last item may carry the argument's closing brace: it belongs after the list, not on every item
    const lastTail = lastB.tail || ''
    // the list's own opening and closing lines are kept only when there are bullets
    const before = model.text.slice(0, first.lineStart)
    const opener = lastLine(before)
    const close = closerFor(opener)
    let blockStart = first.lineStart
    let blockEnd = lastB.lineEnd
    if (close) {
      const openAt = before.lastIndexOf(opener)
      const closeAt = model.text.indexOf(close, lastB.lineEnd)
      if (openAt !== -1 && closeAt !== -1) {
        blockStart = model.text.lastIndexOf('\n', openAt) + 1
        const nl = model.text.indexOf('\n', closeAt)
        blockEnd = nl === -1 ? model.text.length : nl
      }
    }
    const inside = model.text.slice(blockStart, first.lineStart) + '%%IRIS:each ' + listName + '\n' + lineTpl + '\n%%IRIS:end ' + listName + (lastTail ? '\n' + lastTail.trim() : '') + model.text.slice(lastB.lineEnd, blockEnd)
    ranges.push({ start: blockStart, end: blockEnd, text: '%%IRIS:if ' + listName + '\n' + inside + '\n%%IRIS:endif ' + listName })
  }
  let entryTpl = replaceRanges(model.text, ranges)
  if (!/\n$/.test(entryTpl)) entryTpl += '\n'
  const template = prefix + '%%IRIS:each ' + kind + '\n' + entryTpl + '%%IRIS:end ' + kind + '\n' + body.slice(entriesEnd)
  const items = values.map(function (v) {
    if (kind === 'education') return { school: v.school || '', degree: v.degree || '', location: v.location || '', dates: v.dates || '', details: v.bullets }
    if (kind === 'projects') return { name: v.name || '', tech: v.tech || '', link: '', dates: v.dates || '', bullets: v.bullets }
    return { title: v.title || '', company: v.company || '', location: v.location || '', dates: v.dates || '', bullets: v.bullets }
  })
  return { template: template, items: items, fields: fields.filter(Boolean) }
}

/* \textbf{Languages}{: Python, Go} \\   or   \textbf{Languages:} Python, Go \\ */
function templatizeSkills (body) {
  const re = /(^|\n)([ \t]*)\\textbf\s*\{/g
  const rows = []
  let m
  while ((m = re.exec(body)) !== null) {
    const lineStart = m.index + m[1].length
    const g = readGroup(body, m.index + m[0].length - 1)
    if (!g) continue
    let lineEnd = body.indexOf('\n', g.end)
    if (lineEnd === -1) lineEnd = body.length
    const rest = body.slice(g.end, lineEnd)
    let itemsTpl, itemsText
    const braced = /^\s*\{/.exec(rest)
    if (braced) {
      const ig = readGroup(body, g.end + braced[0].length - 1)
      if (!ig) continue
      const lead = /^\s*:?\s*/.exec(ig.content)[0]
      itemsText = ig.content.slice(lead.length)
      itemsTpl = body.slice(g.end, ig.start + 1) + lead + '<<items>>}' + body.slice(ig.end, lineEnd).replace(/\s*\\\\\s*$/, '')
    } else {
      const lead = /^\s*:?\s*/.exec(rest)[0]
      itemsText = rest.slice(lead.length).replace(/\s*\\\\\s*$/, '')
      itemsTpl = lead + '<<items>>'
    }
    const group = latexToPlain(g.content).replace(/\*\*/g, '').replace(/:\s*$/, '')
    const groupTpl = /:\s*$/.test(g.content) ? '<<group>>:' : '<<group>>'
    rows.push({ lineStart: lineStart, lineEnd: lineEnd, group: group, items: splitItems(latexToPlain(itemsText).replace(/\*\*/g, '')), tpl: body.slice(lineStart, g.start + 1) + groupTpl + '}' + itemsTpl })
  }
  if (!rows.length) {
    // \cvskill{Languages}{Go, Python} (Awesome-CV), \cvitem{Tools}{Docker, dbt} (moderncv): one per group
    const calls = lineCalls(body).filter(function (c) { return c.args.length === 2 && !NOT_HEADINGS.has(c.name) })
    const name = calls.length ? mostCommon(calls.map(function (c) { return c.name })) : null
    const groupCalls = calls.filter(function (c) { return c.name === name })
    if (!groupCalls.length) return null
    const f = groupCalls[0]
    const l = groupCalls[groupCalls.length - 1]
    const a0 = f.args[0]
    const a1 = f.args[1]
    const tpl = body.slice(f.lineStart, a0.start + 1) + '<<group>>' + body.slice(a0.end - 1, a1.start + 1) + '<<items>>' + body.slice(a1.end - 1, f.lineEnd)
    return {
      template: body.slice(0, f.lineStart) + '%%IRIS:each skills\n' + tpl + '\n%%IRIS:end skills' + body.slice(l.lineEnd),
      items: groupCalls.map(function (c) { return { group: latexToPlain(c.args[0].content).replace(/\*\*/g, ''), items: splitItems(latexToPlain(c.args[1].content).replace(/\*\*/g, '')) } })
    }
  }
  const first = rows[0]
  const lastR = rows[rows.length - 1]
  const template = body.slice(0, first.lineStart) + '%%IRIS:each skills join=\\\\\n' + first.tpl + '\n%%IRIS:end skills' + body.slice(lastR.lineEnd)
  return { template: template, items: rows.map(function (r) { return { group: r.group, items: r.items } }) }
}

/* A short paragraph section: its text becomes <<summary>>. */
function templatizeSummary (body) {
  const m = /[A-Za-z][^\\{}%\n]{20,}/.exec(body)
  if (!m) return null
  let start = m.index
  let end = body.length
  // the text runs to the closing brace of its group, or the end of the section
  let depth = 0
  for (let j = start; j < body.length; j++) {
    const c = body[j]
    if (c === '\\') { j++; continue }
    if (c === '{') depth++
    if (c === '}') { if (depth === 0) { end = j; break } depth-- }
  }
  while (end > start && /\s/.test(body[end - 1])) end--
  const text = latexToPlain(body.slice(start, end))
  if (text.length < 20) return null
  while (start > 0 && /[ \t]/.test(body[start - 1])) start--
  return { template: body.slice(0, start) + ' <<summary>>' + body.slice(end), text: text }
}

/* Certifications / awards: one line each (\item … or a one-argument macro). */
function templatizeExtras (body) {
  const calls = lineCalls(body).filter(function (c) { return c.args.length === 1 && !NOT_HEADINGS.has(c.name) })
  const macro = calls.length ? mostCommon(calls.map(function (c) { return c.name })) : null
  const items = findBullets(body, macro, 0)
  if (!items.length) return null
  const first = items[0]
  const lastI = items[items.length - 1]
  let lineTpl
  if (first.plainLine) lineTpl = body.slice(first.lineStart, first.arg.start + 1) + '<<text>>'
  else lineTpl = body.slice(first.lineStart, first.arg.start + 1) + '<<text>>' + body.slice(first.arg.end - 1, first.lineEnd)
  return {
    template: body.slice(0, first.lineStart) + '%%IRIS:each extras\n' + lineTpl + '\n%%IRIS:end extras' + body.slice(lastI.lineEnd),
    items: items.map(function (b) { return { kind: '', text: latexToPlain(b.arg.content) } }).filter(function (x) { return x.text })
  }
}

function plainWords (tex) {
  return latexToPlain(tex).replace(/\*\*/g, '').toLowerCase().replace(/[^a-z0-9+#%]+/g, ' ').trim()
}

/* Name, email, phone and links from a resume's header (everything before the first section). */
function readHeader (src, body, firstSection) {
  const head = body.slice(0, firstSection === undefined ? body.length : firstSection)
  const basics = { name: '', email: '', phone: '', location: '', links: [] }
  const nm = /\\name\s*\{([^}]*)\}\s*\{([^}]*)\}/.exec(src) // moderncv, Awesome-CV
  if (nm) basics.name = (nm[1] + ' ' + nm[2]).trim()
  if (!basics.name) {
    const big = /\\(Huge|huge|LARGE|Large)\b/.exec(head)
    if (big) {
      // the smallest {…} around the big text, or the rest of that line
      const open = head.lastIndexOf('{', big.index)
      const g = open !== -1 ? readGroup(head, open) : null
      const text = g && g.end > big.index ? g.content : head.slice(big.index, head.indexOf('\n', big.index) === -1 ? head.length : head.indexOf('\n', big.index))
      basics.name = latexToPlain(text).replace(/\*\*/g, '').trim().slice(0, 80)
    }
  }
  const em = /mailto:([^}\s]+)/.exec(head) || /\\email\s*\{([^}]+)\}/.exec(src)
  if (em) basics.email = em[1].trim()
  const plain = latexToPlain(head)
  const ph = /(\+?\d[\d\s().-]{7,}\d)/.exec(plain)
  if (ph) basics.phone = ph[1].trim()
  const re = /\\href\s*\{([^}]+)\}\s*\{/g
  let m
  while ((m = re.exec(head)) !== null) {
    const url = m[1].trim()
    if (/^mailto:|^tel:/.test(url)) continue
    basics.links.push({ label: url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''), url: url })
  }
  return basics
}

/**
 * Turn a finished LaTeX resume into an Iris template plus the content it held.
 * Every section it rewrites is checked: refilled with its own content it must read the same.
 * Sections it cannot follow are left exactly as they were (and listed in the report).
 */
function templatize (tex) {
  const src = String(tex || '').replace(/\r\n/g, '\n')
  const begin = src.indexOf('\\begin{document}')
  const finish = src.lastIndexOf('\\end{document}')
  if (begin === -1 || finish === -1) return { ok: false, error: 'This does not look like a complete LaTeX document (no \\begin{document} … \\end{document}).' }
  const body = src.slice(begin, finish)
  const heads = []
  // \section (most templates), \cvsection (Awesome-CV), \resumeSection / \sectionTitle (others)
  const re = /\\(?:section|cvsection|cvSection|resumeSection|resumesection|sectionTitle|sectiontitle)\*?\s*\{/g
  let m
  while ((m = re.exec(body)) !== null) {
    const g = readGroup(body, m.index + m[0].length - 1)
    if (!g) continue
    heads.push({ start: m.index, end: g.end, title: latexToPlain(g.content).replace(/\*\*/g, '') })
  }
  const bank = { skills: [], experience: [], projects: [], education: [], extras: [], about: '' }
  const report = []
  const ranges = []
  heads.forEach(function (h, i) {
    const secEnd = i + 1 < heads.length ? heads[i + 1].start : body.length
    const kind = classifySection(h.title)
    const content = body.slice(h.end, secEnd)
    const entry = { title: h.title, kind: kind || 'other', status: 'kept', entries: 0 }
    report.push(entry)
    if (!kind) return
    let res = null
    try {
      if (kind === 'experience' || kind === 'projects' || kind === 'education') res = templatizeEntries(kind, content)
      else if (kind === 'skills') res = templatizeSkills(content)
      else if (kind === 'summary') res = templatizeSummary(content)
      else if (kind === 'extras') res = templatizeExtras(content)
    } catch (e) { res = null }
    if (!res) { entry.note = 'Iris could not find a repeating pattern here'; return }
    // the check: the template, filled with what it held, must say the same thing
    const scope = {}
    if (kind === 'summary') scope.summary = res.text
    else scope[kind] = res.items
    let again = ''
    try { again = renderTemplate(res.template, scope, { probe: false }) } catch (e) { again = '' }
    if (plainWords(again) !== plainWords(content)) {
      entry.note = 'Iris could not refill this section exactly, so it is left as you wrote it'
      return
    }
    entry.status = 'mapped'
    if (kind === 'summary') { bank.about = res.text; entry.entries = 1 } else { bank[kind] = res.items; entry.entries = res.items.length }
    // the whole section disappears when a job needs none of it
    const wrapped = (kind === 'summary' ? '%%IRIS:if summary\n' : '%%IRIS:if ' + kind + '\n') + body.slice(h.start, h.end) + res.template.replace(/\s*$/, '') + '\n%%IRIS:endif ' + kind + '\n'
    ranges.push({ start: h.start, end: secEnd, text: wrapped + (/\n\s*$/.test(content) ? '\n' : '') })
  })
  const newBody = replaceRanges(body, ranges)
  const template = src.slice(0, begin) + newBody + src.slice(finish)
  bank.basics = readHeader(src, body, heads.length ? heads[0].start : undefined)
  return { ok: report.some(function (r) { return r.status === 'mapped' }), template: template, bank: bank, report: report, sections: templateSections(template) }
}

/* ------------------------------------------------------------------ *
 * Tailoring: the model picks, code checks, the page decides how much fits
 * ------------------------------------------------------------------ */

function bankIds (bank) {
  const ids = {}
  bank.experience.forEach(function (e, i) {
    ids['E' + (i + 1)] = { kind: 'experience', index: i }
    e.bullets.forEach(function (b, j) { ids['E' + (i + 1) + '.' + (j + 1)] = { kind: 'bullet', entry: 'E' + (i + 1), index: j, text: b } })
  })
  bank.projects.forEach(function (p, i) {
    ids['P' + (i + 1)] = { kind: 'project', index: i }
    p.bullets.forEach(function (b, j) { ids['P' + (i + 1) + '.' + (j + 1)] = { kind: 'bullet', entry: 'P' + (i + 1), index: j, text: b } })
  })
  bank.extras.forEach(function (x, i) { ids['X' + (i + 1)] = { kind: 'extra', index: i } })
  return ids
}

/** The bank as the model sees it: short lines with IDs. */
function bankText (bank, maxChars) {
  const out = []
  if (bank.skills.length) {
    out.push('SKILLS')
    bank.skills.forEach(function (g) { out.push('  ' + g.group + ': ' + g.items.join(', ')) })
  }
  if (bank.experience.length) {
    out.push('EXPERIENCE')
    bank.experience.forEach(function (e, i) {
      out.push('  E' + (i + 1) + ' ' + [e.title, e.company].filter(Boolean).join(' — ') + (e.dates ? ' (' + e.dates + ')' : ''))
      e.bullets.forEach(function (b, j) { out.push('    E' + (i + 1) + '.' + (j + 1) + ' ' + b) })
    })
  }
  if (bank.projects.length) {
    out.push('PROJECTS')
    bank.projects.forEach(function (p, i) {
      out.push('  P' + (i + 1) + ' ' + p.name + (p.tech ? ' [' + p.tech + ']' : '') + (p.dates ? ' (' + p.dates + ')' : ''))
      p.bullets.forEach(function (b, j) { out.push('    P' + (i + 1) + '.' + (j + 1) + ' ' + b) })
    })
  }
  if (bank.education.length) {
    out.push('EDUCATION')
    bank.education.forEach(function (e) { out.push('  ' + [e.degree, e.school, e.dates].filter(Boolean).join(', ') + (e.details.length ? ' — ' + e.details.join('; ') : '')) })
  }
  if (bank.extras.length) {
    out.push('EXTRAS')
    bank.extras.forEach(function (x, i) { out.push('  X' + (i + 1) + ' ' + (x.kind ? x.kind + ': ' : '') + x.text) })
  }
  if (bank.about) out.push('ABOUT (facts the person gave)\n  ' + bank.about.replace(/\n+/g, '\n  '))
  const text = out.join('\n')
  return maxChars && text.length > maxChars ? text.slice(0, maxChars) + '\n…' : text
}

function tailorMessages (bank, job) {
  const system = [
    'You choose what goes on a one-page resume for ONE job, from the person\'s career bank.',
    'Rules:',
    '- Use only what is in the bank, by its IDs and its exact skill names. Never add a skill, tool, employer,',
    '  title, number or result the bank does not have. Picking what fits is the job; inventing is not allowed.',
    '- You may reword a bullet to lead with the words this job cares about, using only facts from that same bullet',
    '  (same tools, same numbers, nothing new). Keep it about as long. Most bullets need no rewrite.',
    '- Best first. Choose what proves the job\'s main requirements. List up to 6 bullets per job and up to 4',
    '  projects; Iris trims the list to fit one page, so the order matters more than the count.',
    '- Keep every job in "experience" unless it has nothing relevant and there are 3 or more others.',
    '- skills: the groups and skills that matter for this job, most relevant first; leave out unrelated ones.',
    '- fit: 0-100, how well the bank covers the job\'s must-haves (100 = every must-have is clearly there). Each',
    '  must-have the bank does not show lowers it a lot; nice-to-haves barely matter.',
    '- summary: one or two sentences aimed at this job, built only from bank facts, no numbers and no job title',
    '  the person has not held; or "" if nothing fits.',
    'Reply with one JSON object and nothing else:',
    '{"fit":int,"focus":"<2-5 words: what this job is mostly about>","why":"<one sentence>",',
    ' "missing":["<a must-have the bank does not show>"],"summary":"<…>",',
    ' "skills":[{"group":"<bank group>","items":["<bank skill>"]}],',
    ' "experience":[{"id":"E1","bullets":["E1.3","E1.1"]}],',
    ' "projects":[{"id":"P2","bullets":["P2.1"]}],',
    ' "extras":["X1"],',
    ' "rewrite":{"E1.3":"<reworded bullet>"}}'
  ].join('\n')
  const user = [
    'JOB: ' + [job.title, job.company].filter(Boolean).join(' at ') + (job.url ? '\n' + job.url : ''),
    'WHAT THE POSTING ASKS FOR:',
    String(job.requirements || '(not given: judge from the title)').slice(0, 9000),
    '',
    'CAREER BANK:',
    bankText(bank, 24000)
  ].join('\n')
  return [{ role: 'system', content: system }, { role: 'user', content: user }]
}

const STOP = new Set('the a an and or of to in for on with at by from as is are be this that it its into using use used via per over under across our your their we you they i my me who will can must should would able strong experience years year work working team teams role job plus'.split(' '))

function words (text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ').split(' ').map(function (w) { return w.replace(/\.+$/, '') }).filter(function (w) { return w.length > 1 && !STOP.has(w) })
}

/* every number in a text, normalised ("2M" → "2m", "1,200" → "1200", "2.1x" → "2.1x") */
function numberSet (text) {
  const set = new Set()
  ;(String(text || '').match(/(?<![A-Za-z0-9])\d[\d,.]*\s*(%|x\b|k\b|m\b|\+)?/gi) || []).forEach(function (n) {
    const t = n.replace(/[\s,]/g, '').replace(/\.$/, '').toLowerCase()
    set.add(t)
    set.add(t.replace(/[^0-9.]/g, ''))
  })
  return set
}

/* Numbers and technical-looking words: the facts a rewrite must not change. */
function factTokens (text) {
  const out = []
  const s = String(text || '').replace(/\*\*/g, '')
  // numbers on their own (40%, 2.1x, 10k) — not the digits inside names like ESP32 or S3
  ;(s.match(/(?<![A-Za-z0-9])\d[\d,.]*\s*(%|x\b|k\b|m\b|\+)?/gi) || []).forEach(function (n) { out.push(n.replace(/[\s,]/g, '').replace(/\.$/, '').toLowerCase()) })
  let sentenceStart = true
  s.split(/[\s,;:()"]+/).forEach(function (w) {
    const t = w.replace(/^[^A-Za-z0-9]+|[.!?]+$/g, '')
    const starts = sentenceStart
    sentenceStart = /[.!?]$/.test(w)
    if (!t || /^\d/.test(t)) return
    const tech = /[A-Z].*[A-Z]/.test(t) || /[+#]/.test(t) || /\w\.\w/.test(t) || /\d/.test(t) || (!starts && /^[A-Z]/.test(t))
    // "C/C++" or "I2C/SPI": each part is its own fact
    if (tech) t.toLowerCase().split('/').filter(Boolean).forEach(function (part) { out.push(part) })
  })
  return out
}

function supported (token, context) {
  if (context.indexOf(token) !== -1) return true
  // a different form of the same word ("APIs" / "API", "RESTful" / "REST", "Kubernetes-based")
  const stem = token.replace(/[^a-z0-9+#]/g, '')
  if (stem.length >= 3 && context.replace(/[^a-z0-9+# ]/g, ' ').split(/\s+/).some(function (w) { return w.length >= 3 && (stem.indexOf(w) === 0 || w.indexOf(stem) === 0) })) return true
  return false
}

/* Words a rewrite may bring in without adding a claim: resume verbs and joining words. */
const REWORD_OK = new Set(('built developed designed implemented created engineered led improved reduced increased delivered established optimized ' +
  'achieved enabled using leveraging utilizing utilized resulting drove launched shipped automated streamlined owned architected deployed ' +
  'migrated scaled cutting boosting raising while across within including through which that them these those such also both each ' +
  'successfully efficiently directly hands-on end-to-end project projects system systems solution solutions application applications ' +
  'apps tool tools service services work worked working wrote written making made added adding producing delivering supporting support ' +
  'resulting achieving enabling allowing allowed helping helped performed performing contributed contributing responsible spearheaded ' +
  'orchestrated executed collaborated partnered managed maintaining maintained').split(' '))

/* "reducing" ~ "reduced", "optimizations" ~ "optimized" */
function stem (w) {
  return String(w).toLowerCase().replace(/(ations|ation|ings|ing|ments|ment|ers|er|ies|ied|ed|es|s|ly|ive|ion|ions|al)$/, '').slice(0, 7)
}

/* content words in `text` that appear nowhere in `context` (after stemming) */
function newWords (text, context) {
  const have = new Set(words(context).map(stem))
  return words(text).filter(function (w) {
    return w.length >= 4 && !/^\d/.test(w) && !REWORD_OK.has(w) && !have.has(stem(w))
  })
}

/** Does `rewritten` stay within the facts of `original` (+ its entry)? Returns the unsupported bits. */
function checkRewrite (original, rewritten, entryContext) {
  const ctx = (String(original) + ' ' + String(entryContext || '')).toLowerCase().replace(/\*\*/g, '')
  const bad = []
  // more than a couple of new content words means a new claim ("… through low-power design")
  const added = newWords(rewritten, ctx)
  if (added.length > 2) bad.push('adds: ' + added.slice(0, 4).join(' '))
  const nums = numberSet(original)
  factTokens(rewritten).forEach(function (t) {
    if (/^\d/.test(t)) {
      if (!nums.has(t) && !nums.has(t.replace(/[^0-9.]/g, ''))) bad.push(t)
    } else if (!supported(t, ctx)) bad.push(t)
  })
  // a rewrite that grew a lot is adding claims
  if (String(rewritten).length > Math.max(60, String(original).length * 1.6)) bad.push('(much longer than the original)')
  return bad
}

function entryContext (bank, entryId) {
  const kind = entryId[0]
  const i = Number(entryId.slice(1)) - 1
  const e = kind === 'E' ? bank.experience[i] : bank.projects[i]
  if (!e) return ''
  return [e.title, e.company, e.name, e.tech].concat(e.bullets).filter(Boolean).join(' ')
}

/* Without (usable) model output: rank by shared words with the posting. */
function keywordPick (bank, job) {
  const want = new Set(words([job.title, job.requirements].join(' ')))
  const score = function (text) { return words(text).filter(function (w) { return want.has(w) }).length }
  const rankBullets = function (prefix, bullets) {
    return bullets.map(function (b, j) { return { id: prefix + '.' + (j + 1), s: score(b) } }).sort(function (a, b) { return b.s - a.s }).map(function (x) { return x.id })
  }
  return {
    fit: null,
    experience: bank.experience.map(function (e, i) { return { id: 'E' + (i + 1), bullets: rankBullets('E' + (i + 1), e.bullets).slice(0, 5) } }),
    projects: bank.projects.map(function (p, i) { return { id: 'P' + (i + 1), s: score(p.name + ' ' + p.tech + ' ' + p.bullets.join(' ')), bullets: rankBullets('P' + (i + 1), p.bullets).slice(0, 3) } })
      .sort(function (a, b) { return b.s - a.s }).slice(0, 4).map(function (p) { return { id: p.id, bullets: p.bullets } }),
    skills: bank.skills.map(function (g) {
      return { group: g.group, items: g.items.slice().sort(function (a, b) { return score(b) - score(a) }) }
    }).sort(function (a, b) { return score(b.items.join(' ')) - score(a.items.join(' ')) }),
    extras: bank.extras.map(function (x, i) { return 'X' + (i + 1) }),
    summary: '',
    rewrite: {},
    missing: [],
    focus: '',
    why: ''
  }
}

/**
 * The model's reply → a checked selection. Unknown IDs and skills are dropped, rewrites that add
 * facts are undone (listed in `undone`), and anything the reply left out falls back to keyword ranking.
 */
/* "3+ years", "at least 5 years", "2-4 years", "3 years of experience": the most a posting asks for (0: none) */
function yearsAsked (text) {
  const t = String(text || '')
  let most = 0
  const take = function (n) { n = Number(n); if (n > 0 && n <= 15 && n > most) most = n }
  const patterns = [
    /(\d{1,2})\s*\+\s*(?:years?|yrs?)\b/gi,
    /\b(?:at least|minimum(?: of)?|min\.?)\s+(\d{1,2})\s*(?:years?|yrs?)\b/gi,
    /\b(\d{1,2})\s*(?:-|–|to)\s*\d{1,2}\s*(?:years?|yrs?)\b/gi,
    /\b(\d{1,2})\s*(?:years?|yrs?)\s+(?:of\s+)?(?:professional\s+|relevant\s+|industry\s+|hands-on\s+|work\s+|related\s+)?experience\b/gi
  ]
  patterns.forEach(function (re) { let m; while ((m = re.exec(t))) take(m[1]) })
  return most
}

const MONTH_INDEX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }

/* Years of work in the bank, from each job's dates ("Jul 2025 -- Present", "2019 - 2021"), overlaps counted once. */
function yearsWorked (bank, now) {
  const today = new Date(now || Date.now())
  const spans = []
  ;(bank.experience || []).forEach(function (e) {
    const d = String(e.dates || '').toLowerCase()
    const points = []
    const re = /\b(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+)?((?:19|20)\d{2})\b|\b(present|current|now|today)\b/g
    let m
    while ((m = re.exec(d))) {
      if (m[3]) points.push(today.getFullYear() + today.getMonth() / 12)
      else points.push(Number(m[2]) + (m[1] ? MONTH_INDEX[m[1]] / 12 : 0))
    }
    if (points.length >= 2 && points[1] > points[0]) spans.push([points[0], points[1] + (/present|current|now|today/.test(d) ? 0 : 1 / 12)])
  })
  spans.sort(function (a, b) { return a[0] - b[0] })
  let total = 0
  let end = -Infinity
  spans.forEach(function (sp) {
    const from = Math.max(sp[0], end)
    if (sp[1] > from) total += sp[1] - from
    end = Math.max(end, sp[1])
  })
  return total
}

/*
 * Years with each skill: the dates of the jobs whose title or bullets mention it, overlaps once.
 * Forms ask "How many years have you used X?"; the model cannot count this from titles alone.
 * → [{ skill, years }] with years > 0, most first.
 */
function skillYears (bank, now) {
  const out = []
  const seen = new Set()
  ;(bank.skills || []).forEach(function (g) {
    g.items.forEach(function (item) {
      const name = String(item).replace(/\s*\(.*\)\s*$/, '').trim() // "AWS (Lambda, ECS)" → AWS
      const key = name.toLowerCase()
      if (!name || seen.has(key)) return
      seen.add(key)
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp('(^|[^A-Za-z0-9+#])' + esc + '(?![A-Za-z0-9+#])', 'i')
      const jobs = (bank.experience || []).filter(function (e) { return re.test([e.title].concat(e.bullets || []).join(' \n ')) })
      if (!jobs.length) return
      const years = yearsWorked({ experience: jobs }, now)
      if (years > 0) out.push({ skill: name, years: Math.round(years * 10) / 10 })
    })
  })
  return out.sort(function (a, b) { return b.years - a.years })
}

function parseTailorReply (text, bank, job, parseObject, now) {
  let obj = null
  if (parseObject) {
    const raw = String(text || '')
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start !== -1 && end > start) obj = parseObject(raw.slice(start, end + 1))
  }
  const fallback = keywordPick(bank, job)
  const usedModel = !!(obj && (Array.isArray(obj.experience) || Array.isArray(obj.projects)))
  if (!obj) obj = {}
  const ids = bankIds(bank)
  const undone = []

  const pickEntries = function (arr, prefix, kind) {
    if (!Array.isArray(arr)) return null
    const seen = new Set()
    const out = []
    arr.forEach(function (e) {
      const id = String(e && (e.id || e) || '').trim().toUpperCase()
      if (!ids[id] || ids[id].kind !== kind || seen.has(id)) return
      seen.add(id)
      const bullets = (Array.isArray(e.bullets) ? e.bullets : []).map(function (b) { return String(b).trim().toUpperCase() })
        .filter(function (b, k, all) { return ids[b] && ids[b].kind === 'bullet' && ids[b].entry === id && all.indexOf(b) === k })
      out.push({ id: id, bullets: bullets })
    })
    return out
  }
  let experience = pickEntries(obj.experience, 'E', 'experience')
  let projects = pickEntries(obj.projects, 'P', 'project')
  if (!experience || (!experience.length && bank.experience.length)) experience = fallback.experience
  if (!projects) projects = fallback.projects
  // a short work history stays complete: a missing job reads as a gap
  if (bank.experience.length <= 4) {
    bank.experience.forEach(function (e, i) {
      const id = 'E' + (i + 1)
      if (!experience.some(function (x) { return x.id === id })) experience.push({ id: id, bullets: [] })
    })
  }
  // a job with no bullets picked still shows its strongest one
  experience.forEach(function (e) {
    if (!e.bullets.length) {
      const fb = fallback.experience.find(function (f) { return f.id === e.id })
      if (fb) e.bullets = fb.bullets.slice(0, 2)
    }
  })

  const allSkills = {}
  bank.skills.forEach(function (g) { g.items.forEach(function (it) { allSkills[it.toLowerCase()] = { group: g.group, item: it } }) })
  let skills = null
  if (Array.isArray(obj.skills)) {
    const groups = []
    obj.skills.forEach(function (g) {
      if (!g || typeof g !== 'object') return
      const items = (Array.isArray(g.items) ? g.items : splitItems(g.items)).map(function (it) { return allSkills[String(it).trim().toLowerCase()] }).filter(Boolean)
      if (!items.length) return
      const name = bank.skills.some(function (b) { return b.group.toLowerCase() === String(g.group || '').toLowerCase() }) ? bank.skills.find(function (b) { return b.group.toLowerCase() === String(g.group).toLowerCase() }).group : items[0].group
      let target = groups.find(function (x) { return x.group === name })
      if (!target) { target = { group: name, items: [] }; groups.push(target) }
      items.forEach(function (it) { if (target.items.indexOf(it.item) === -1) target.items.push(it.item) })
    })
    if (groups.length) skills = groups
  }
  if (!skills) skills = fallback.skills

  const rewrite = {}
  if (obj.rewrite && typeof obj.rewrite === 'object') {
    Object.keys(obj.rewrite).forEach(function (k) {
      const id = k.trim().toUpperCase()
      const info = ids[id]
      const text = str(obj.rewrite[k], 600)
      if (!info || info.kind !== 'bullet' || !text || text === info.text) return
      const bad = checkRewrite(info.text, text, entryContext(bank, info.entry))
      if (bad.length) undone.push({ id: id, text: text, why: bad.slice(0, 4).join(', ') })
      else rewrite[id] = text
    })
  }

  let summary = str(obj.summary, 500)
  // numbers in a summary are easy to twist ("reduced crashes by 99.6%"): the bullets carry them
  if (summary && /(?<![A-Za-z0-9])\d/.test(summary)) { undone.push({ id: 'summary', text: summary, why: 'numbers belong in the bullets' }); summary = '' }
  if (summary) {
    const bad = checkRewrite(bankText(bank), summary, '')
      .filter(function (t) { return t !== '(much longer than the original)' && !/^adds: /.test(t) })
    if (bad.length) { undone.push({ id: 'summary', text: summary, why: bad.slice(0, 4).join(', ') }); summary = '' }
  }

  const extras = Array.isArray(obj.extras)
    ? obj.extras.map(function (x) { return String(x).trim().toUpperCase() }).filter(function (x, k, all) { return ids[x] && ids[x].kind === 'extra' && all.indexOf(x) === k })
    : fallback.extras

  // projects the model left out, best match first: used only if the page has room
  const moreProjects = fallback.projects.concat(bank.projects.map(function (p, i) { return { id: 'P' + (i + 1), bullets: p.bullets.map(function (b, j) { return 'P' + (i + 1) + '.' + (j + 1) }).slice(0, 2) } }))
    .filter(function (p, k, all) { return !projects.some(function (x) { return x.id === p.id }) && all.findIndex(function (y) { return y.id === p.id }) === k })

  let fit = Number.isFinite(Number(obj.fit)) ? Math.max(0, Math.min(100, Math.round(Number(obj.fit)))) : null
  const missing = (Array.isArray(obj.missing) ? obj.missing : []).map(function (x) { return str(x, 80) }).filter(Boolean).slice(0, 8)
  // the model tends to rate a job it could fill well even when the person is years short of what it asks
  const asked = yearsAsked(job && job.requirements)
  const have = yearsWorked(bank, now)
  if (fit !== null && asked > 0 && asked - have >= 1) {
    fit = Math.min(fit, asked - have >= 2 ? 50 : 65)
    if (!missing.some(function (x) { return /\byears?\b/i.test(x) })) missing.unshift(asked + '+ years asked; the profile shows about ' + (Math.round(have * 10) / 10) + '')
  }
  return {
    usedModel: usedModel,
    fit: fit,
    focus: str(obj.focus, 80),
    why: str(obj.why, 300),
    missing: missing,
    summary: summary,
    skills: skills,
    experience: experience,
    projects: projects,
    moreProjects: moreProjects,
    extras: extras,
    rewrite: rewrite,
    undone: undone
  }
}

/* ------------------------------------------------------------------ *
 * Sorting pasted text (an old resume, notes, an export) into the bank
 * ------------------------------------------------------------------ */

function profileFromTextMessages (text) {
  const system = [
    'You sort what a person pasted about their career into a structured profile. Copy their words: keep every',
    'bullet as written (fix only obvious typos), never add, merge or embellish anything, never guess dates or places.',
    'Reply with one JSON object and nothing else:',
    '{"basics":{"name":"…","email":"…","phone":"…","location":"…","links":[{"label":"…","url":"…"}]},',
    ' "skills":[{"group":"<e.g. Languages, Cloud>","items":["…"]}],',
    ' "experience":[{"title":"…","company":"…","location":"…","dates":"…","bullets":["…"]}],',
    ' "projects":[{"name":"…","tech":"…","link":"…","dates":"…","bullets":["…"]}],',
    ' "education":[{"school":"…","degree":"…","location":"…","dates":"…","details":["…"]}],',
    ' "extras":[{"kind":"Certification|Award|Publication|Language|Other","text":"…"}],',
    ' "about":"<other true facts they gave (not name or contact details), in their words, or empty>"}',
    'Leave out what is not there. Newest jobs first, as they appear.'
  ].join('\n')
  return [{ role: 'system', content: system }, { role: 'user', content: String(text || '').slice(0, 30000) }]
}

/* share of a line's content words that appear in the source (stemmed) */
function overlap (line, sourceStems) {
  const w = words(line).filter(function (x) { return x.length >= 3 })
  if (!w.length) return 1
  return w.filter(function (x) { return sourceStems.has(stem(x)) }).length / w.length
}

/**
 * The model's sorting → a bank to merge. Anything that is not really in the pasted text (a bullet
 * whose words are mostly new, a number that is not there) is dropped and listed in `dropped`.
 */
function parseProfileFromText (reply, source, parseObject) {
  let obj = null
  if (parseObject) {
    const raw = String(reply || '')
    const a = raw.indexOf('{')
    const b = raw.lastIndexOf('}')
    if (a !== -1 && b > a) obj = parseObject(raw.slice(a, b + 1))
  }
  if (!obj) return { ok: false, error: 'the model did not return a profile', bank: null, dropped: [] }
  const stems = new Set(words(source).map(stem))
  const nums = numberSet(source)
  const dropped = []
  const keep = function (line, where) {
    const t = str(line, 600)
    if (!t) return false
    const badNum = factTokens(t).filter(function (x) { return /^\d/.test(x) && !nums.has(x) && !nums.has(x.replace(/[^0-9.]/g, '')) })
    if (overlap(t, stems) < 0.7 || badNum.length) { dropped.push(where + ': ' + t); return false }
    return true
  }
  const bank = normalizeBank(obj)
  bank.experience.forEach(function (e) { e.bullets = e.bullets.filter(function (b) { return keep(b, e.title || e.company) }) })
  bank.projects.forEach(function (p) { p.bullets = p.bullets.filter(function (b) { return keep(b, p.name) }) })
  bank.education.forEach(function (e) { e.details = e.details.filter(function (b) { return keep(b, e.school) }) })
  bank.extras = bank.extras.filter(function (x) { return keep(x.text, 'extra') })
  bank.skills.forEach(function (g) { g.items = g.items.filter(function (it) { return overlap(it, stems) >= 0.5 || (dropped.push('skill: ' + it) && false) }) })
  bank.skills = bank.skills.filter(function (g) { return g.items.length })
  if (bank.about && overlap(bank.about, stems) < 0.7) { dropped.push('about: ' + bank.about.slice(0, 80)); bank.about = '' }
  // contact details must appear in the text as they are
  ;['name', 'email', 'phone', 'location'].forEach(function (k) {
    const v = bank.basics[k]
    if (v && String(source).toLowerCase().indexOf(v.toLowerCase()) === -1 && overlap(v, stems) < 1) bank.basics[k] = ''
  })
  return { ok: true, bank: bank, dropped: dropped }
}

/* ------------------------------------------------------------------ *
 * Cover letters: short, honest, only from the bank
 * ------------------------------------------------------------------ */

function coverLetterMessages (bank, job) {
  const system = [
    'You write a short cover letter for ONE job, using only facts from the person\'s career bank.',
    'Rules:',
    '- 3 short paragraphs, 170-230 words in all. Plain, specific, no clichés ("I am thrilled", "passionate", "synergy").',
    '- Paragraph 1: the role and the one or two strongest reasons the person fits it.',
    '- Paragraph 2: two concrete things from the bank that match the job\'s main requirements (what they did and the result).',
    '- Paragraph 3: availability and location only as the ANSWERS below say (nothing about availability if they',
    '  do not), and a one-line close.',
    '- Every skill, tool, number, employer and result must be in the bank. Do not invent anything, and do not claim',
    '  experience with what the bank does not show.',
    '- No address block, no date, no greeting and no sign-off: Iris adds those.',
    'Reply with the three paragraphs only, separated by blank lines.'
  ].join('\n')
  const user = [
    'JOB: ' + [job.title, job.company].filter(Boolean).join(' at '),
    'WHAT THE POSTING ASKS FOR:',
    String(job.requirements || '(not given: judge from the title)').slice(0, 4000),
    '',
    'CAREER BANK:',
    bankText(bank, 20000),
    '',
    'ANSWERS (the person\'s own words):',
    (bank.answers.filter(function (a) { return a.value }).map(function (a) { return '  ' + a.label + ': ' + a.value }).join('\n') || '  (none)') +
      (bank.basics.location ? '\n  Location: ' + bank.basics.location : '')
  ].join('\n')
  return [{ role: 'system', content: system }, { role: 'user', content: user }]
}

/* capitalised words a letter needs that are not facts about the person */
const LETTER_WORDS = /^(i|i'm|i've|i'd|i'll|my|the|this|your|thank|thanks|please|team|role|company|dear|hiring)$/

/**
 * The model's letter → paragraphs. A sentence that brings in a number, a tool or a name the bank
 * does not have is taken out (listed in `removed`); the job's own company and title are allowed.
 */
function parseCoverLetter (text, bank, job) {
  const places = [bank.basics.location].concat(bank.experience.map(function (e) { return e.location }), bank.education.map(function (e) { return e.location + ' ' + e.school }),
    bank.answers.map(function (a) { return a.value })).join(' ')
  const all = bankText(bank) + ' ' + places + ' ' + ((job && job.company) || '') + ' ' + ((job && job.title) || '')
  const ctx = all.toLowerCase()
  const nums = numberSet(all)
  const removed = []
  const paras = String(text || '').replace(/\r/g, '').split(/\n\s*\n/).map(function (p) { return p.replace(/\s+/g, ' ').trim() })
    .filter(function (p) { return p && !/^(dear|hi |hello|sincerely|best regards|regards|kind regards)/i.test(p) })
    .map(function (p) {
      // "99.6%" and "v2.1" are not sentence ends
      const safe = p.replace(/(\d)\.(\d)/g, '$1\u0002$2')
      const sentences = (safe.match(/[^.!?]+[.!?]+["')]*\s*|[^.!?]+$/g) || [safe]).map(function (x) { return x.replace(/\u0002/g, '.') })
      return sentences.filter(function (sent) {
        const bad = factTokens(sent).filter(function (t) {
          if (/^\d/.test(t)) return !nums.has(t) && !nums.has(t.replace(/[^0-9.]/g, ''))
          return !LETTER_WORDS.test(t) && !supported(t, ctx)
        })
        if (bad.length) { removed.push({ sentence: sent.trim(), why: bad.slice(0, 3).join(', ') }); return false }
        return true
      }).join('').trim()
    }).filter(Boolean)
  return { paragraphs: paras.slice(0, 4), removed: removed }
}

const COVER_TEMPLATE = String.raw`\documentclass[11pt,letterpaper]{article}
\usepackage[margin=1in]{geometry}
\usepackage[hidelinks]{hyperref}
\usepackage{parskip}
\input{glyphtounicode}
\pdfgentounicode=1
\pagestyle{empty}
\begin{document}
{\Large \textbf{<<name>>}}\\
\small <<contact>>

\normalsize
\vspace{14pt}
<<date>>

\vspace{6pt}
<<company>>\\
Re: <<title>>

\vspace{6pt}
Dear Hiring Team,

%%IRIS:each paragraphs
<<text>>

%%IRIS:end paragraphs
Sincerely,\\
<<name>>
\end{document}
`

function coverLetterTex (bank, job, paragraphs, date) {
  return renderTemplate(COVER_TEMPLATE, {
    name: bank.basics.name || '',
    contact: contactLine(bank.basics),
    date: date || '',
    company: job.company || '',
    title: job.title || '',
    paragraphs: paragraphs.map(function (t) { return { text: t } })
  }, { probe: false })
}

/* ------------------------------------------------------------------ *
 * One page, filled: render, compile, measure, trim or add, repeat
 * ------------------------------------------------------------------ */

function bulletText (bank, id, rewrite) {
  if (rewrite && rewrite[id]) return rewrite[id]
  const m = /^([EP])(\d+)\.(\d+)$/.exec(id)
  if (!m) return ''
  const e = m[1] === 'E' ? bank.experience[Number(m[2]) - 1] : bank.projects[Number(m[2]) - 1]
  return e ? e.bullets[Number(m[3]) - 1] || '' : ''
}

/** The working layout: which entries and bullets are on the page, in order. */
function initialLayout (bank, pick) {
  const exp = pick.experience.slice().sort(function (a, b) { return Number(a.id.slice(1)) - Number(b.id.slice(1)) }) // jobs stay in the user's order
  return {
    summary: pick.summary || '',
    experience: exp.map(function (e) { return { id: e.id, bullets: e.bullets.slice() } }),
    projects: pick.projects.map(function (p) { return { id: p.id, bullets: p.bullets.slice() } }),
    skills: pick.skills.map(function (g) { return { group: g.group, items: g.items.slice() } }),
    extras: pick.extras.slice(),
    educationDetails: true
  }
}

function layoutToDoc (bank, layout, rewrite) {
  return {
    name: bank.basics.name,
    contact: contactLine(bank.basics),
    email: bank.basics.email,
    phone: bank.basics.phone,
    location: bank.basics.location,
    summary: bank.prefs.summary ? layout.summary : '',
    skills: layout.skills.filter(function (g) { return g.items.length }),
    experience: layout.experience.map(function (e) {
      const src = bank.experience[Number(e.id.slice(1)) - 1]
      return { title: src.title, company: src.company, location: src.location, dates: src.dates, bullets: e.bullets.map(function (b) { return bulletText(bank, b, rewrite) }).filter(Boolean) }
    }),
    projects: layout.projects.map(function (p) {
      const src = bank.projects[Number(p.id.slice(1)) - 1]
      return { name: src.name, tech: src.tech, link: src.link, dates: src.dates, bullets: p.bullets.map(function (b) { return bulletText(bank, b, rewrite) }).filter(Boolean) }
    }),
    education: bank.education.map(function (e) { return Object.assign({}, e, { details: layout.educationDetails ? e.details : [] }) }),
    extras: layout.extras.map(function (x) { const it = bank.extras[Number(x.slice(1)) - 1]; return it ? it.text : '' }).filter(Boolean)
  }
}

/* Take away the least important thing; false when nothing sensible is left to cut. */
function trimOnce (layout) {
  // the longest bullet lists first, projects before jobs; keep 2 bullets per job and 1 per project
  const lists = layout.experience.map(function (e) { return { e: e, min: 2, w: 0 } }).concat(layout.projects.map(function (p) { return { e: p, min: 1, w: 1 } }))
  const cand = lists.filter(function (l) { return l.e.bullets.length > l.min }).sort(function (a, b) { return (b.e.bullets.length - a.e.bullets.length) || (b.w - a.w) })
  if (cand.length) { cand[0].e.bullets.pop(); return 'a bullet' }
  if (layout.projects.length > 1) { layout.projects.pop(); return 'a project' }
  if (layout.extras.length) { layout.extras.pop(); return 'an extra' }
  const big = layout.skills.slice().sort(function (a, b) { return b.items.length - a.items.length })[0]
  if (big && big.items.length > 4) { big.items.pop(); return 'a skill' }
  if (layout.skills.length > 2) { layout.skills.pop(); return 'a skill group' }
  if (layout.summary) { layout.summary = ''; return 'the summary' }
  if (layout.educationDetails) { layout.educationDetails = false; return 'education details' }
  const exp = layout.experience.find(function (e) { return e.bullets.length > 1 })
  if (exp) { exp.bullets.pop(); return 'a bullet' }
  if (layout.projects.length) { layout.projects.pop(); return 'a project' }
  return false
}

/*
 * What could still go on the page, most useful first. Everything is ranked by the words it shares with
 * the job: bullets the model listed, then other bullets and skills that match the job, then projects
 * that match; things that share nothing with the job come last (a full page should not be padded
 * with an Android internship's details for a firmware job when a firmware skill could go there).
 */
function additions (bank, layout, pick, job) {
  const want = new Set(words([job && job.title, job && job.requirements].join(' ')))
  const score = function (text) { return words(text).filter(function (w) { return want.has(w) }).length }
  const out = []
  const ranked = {}
  pick.experience.concat(pick.projects).forEach(function (e) { ranked[e.id] = e.bullets })
  layout.experience.concat(layout.projects).forEach(function (e, n) {
    const src = e.id[0] === 'E' ? bank.experience[Number(e.id.slice(1)) - 1] : bank.projects[Number(e.id.slice(1)) - 1]
    const listed = ranked[e.id] || []
    src.bullets.forEach(function (text, j) {
      const id = e.id + '.' + (j + 1)
      if (e.bullets.indexOf(id) !== -1) return
      // the model's own picks first, then by words shared with the job
      out.push({ entry: e.id, bullet: id, rank: (listed.indexOf(id) !== -1 ? 100 - listed.indexOf(id) : 0) + score(text) * 10 - n * 0.01 })
    })
  })
  // skills come a group at a time (single items barely change the page): the matching ones first
  bank.skills.forEach(function (g) {
    const shown = layout.skills.find(function (x) { return x.group === g.group })
    const missing = g.items.filter(function (it) { return !(shown && shown.items.indexOf(it) !== -1) })
    const hits = missing.filter(function (it) { return score(it + ' ' + g.group) > 0 })
    const rest = missing.filter(function (it) { return hits.indexOf(it) === -1 })
    if (hits.length) out.push({ skill: { group: g.group, items: hits }, rank: 10 * Math.min(3, hits.length) + 5 })
    if (rest.length) out.push({ skill: { group: g.group, items: rest }, rank: shown ? 2 : -0.5 })
  })
  const projects = (pick.projects || []).concat(pick.moreProjects || [])
  projects.forEach(function (p) {
    if (layout.projects.some(function (x) { return x.id === p.id }) || out.some(function (o) { return o.project && o.project.id === p.id })) return
    const src = bank.projects[Number(p.id.slice(1)) - 1]
    out.push({ project: p, rank: (pick.projects.indexOf(p) !== -1 ? 50 : 0) + score([src.name, src.tech].concat(src.bullets).join(' ')) * 10 - 1 })
  })
  return out.sort(function (a, b) { return b.rank - a.rank })
}

function applyAddition (layout, add) {
  if (add.bullet) {
    const e = layout.experience.concat(layout.projects).find(function (x) { return x.id === add.entry })
    if (e) e.bullets.push(add.bullet)
  } else if (add.project) {
    layout.projects.push({ id: add.project.id, bullets: add.project.bullets.slice(0, 2) })
  } else if (add.skill) {
    let g = layout.skills.find(function (x) { return x.group === add.skill.group })
    if (!g) { g = { group: add.skill.group, items: [] }; layout.skills.push(g) }
    add.skill.items.forEach(function (it) { if (g.items.indexOf(it) === -1) g.items.push(it) })
  }
}

function cloneLayout (l) { return JSON.parse(JSON.stringify(l)) }

/**
 * Fit the picked content onto exactly one page, as full as it gets.
 * compile(tex) → Promise<{ ok, pages, fill (0..1 of the last page), error }>
 */
async function fitToPage (opts) {
  const bank = opts.bank
  const pick = opts.pick
  const compile = opts.compile
  const minFill = opts.minFill || 0.96
  const maxCompiles = opts.maxCompiles || 18
  let layout = initialLayout(bank, pick)
  let compiles = 0
  const steps = []
  const run = async function (l) {
    compiles++
    const tex = renderTemplate(opts.template, layoutToDoc(bank, l, pick.rewrite))
    const r = await compile(tex)
    return Object.assign({ tex: tex }, r)
  }
  let r = await run(layout)
  if (!r.ok) return { ok: false, error: r.error || 'LaTeX could not build the resume', tex: r.tex, log: r.log }
  // 1. too long: cut the least important things until it fits
  while (r.pages > 1 && compiles < maxCompiles) {
    // far over: cut several things at once (about one bullet per line over); step 2 adds back what fits
    const over = Math.max(1, Math.floor(((r.pages - 2) + r.fill) * 22))
    let cut = null
    for (let k = 0; k < over; k++) { const c = trimOnce(layout); if (!c) break; cut = c; steps.push('cut ' + c) }
    if (!cut) break
    r = await run(layout)
    if (!r.ok) return { ok: false, error: r.error, tex: r.tex, log: r.log }
  }
  // 2. room left: add the next best things while they still fit
  if (r.pages === 1) {
    let best = { layout: cloneLayout(layout), result: r }
    const queue = additions(bank, layout, pick, opts.job)
    let misses = 0
    while (best.result.fill < minFill && queue.length && compiles < maxCompiles && misses < 3) {
      const add = queue.shift()
      const trial = cloneLayout(best.layout)
      applyAddition(trial, add)
      const t = await run(trial)
      if (!t.ok) break
      if (t.pages === 1) { best = { layout: trial, result: t }; steps.push('added ' + (add.bullet ? 'a bullet' : add.skill ? 'a skill' : 'a project')); misses = 0 } else misses++
    }
    layout = best.layout
    r = best.result
  }
  // the PDF of the layout kept, not of the last try (a try that ran onto page 2 is built after it)
  return { ok: true, pages: r.pages, fill: r.fill, tex: r.tex, pdf: r.pdf, pdfData: r.pdfData, layout: layout, doc: layoutToDoc(bank, layout, pick.rewrite), compiles: compiles, steps: steps }
}

/*
 * Is this a job-hunting task? "apply to jobs", "find me an internship", "tailor my resume" — but not
 * "apply the coupon at checkout", "resume the download" or "papers about job scheduling".
 */
// words that mean job hunting wherever they stand next to "apply" ("roles" and "positions" are not
// enough on their own: "apply the admin role", "apply the saved positions")
const JOB_STRONG = /\b(jobs?|internships?|co-?ops?|openings?|postings?|vacanc(y|ies)|careers? pages?|hiring|greenhouse|lever|ashby|workday)\b/i
const JOB_TASK = [
  /\bjob (applications?|hunt(ing)?|search(es|ing)?|boards?)\b/i,
  // "apply for software engineer roles", "apply for this senior role" — but not "apply the admin role to Sam"
  /\bapply(ing)? (for|to)\b[^.\n]{0,50}\b(roles|positions)\b/i,
  /\bapply(ing)? (for|to) (this|the|a|an|that)( [\w-]+){0,3} (role|position)\b/i,
  // after "find": plurals, or one job/role followed by where or what it is ("a job in Toronto", "a role as …"),
  // so "papers about job scheduling" and "the role of …" stay out
  new RegExp('\\b(find|search|look for|looking for|hunt|get)\\b[^.\\n]{0,40}\\b((jobs|positions|roles|internships|co-?ops|openings|postings|vacancies)\\b|(job|position|role|internship|co-?op|opening|posting|vacancy)(\\s+(at|in|for|with|near|as|on|that|which)\\b|\\s*([.,!?;]|$)))', 'i'),
  /\btailor(ed|ing)?\b[^.\n]{0,40}\b(resume|résumé|cv)(?![\w])/i,
  /\b(my|a|the|this)\s+(resume|résumé|cv)(?![\w])[^\n]{0,60}\b(for|to|job|posting|role|position)\b/i,
  /\bcover letters?\b/i
]

function isJobTask (text) {
  const t = String(text || '')
  // "apply" anywhere with a job word anywhere ("go through the openings … and apply to the ones that fit")
  if (/\b(apply|applying)\b/i.test(t) && JOB_STRONG.test(t)) return true
  // "finish the Lyft Software Engineer application (job 2 of my list)" — a form for a job, without the word apply
  if (/\b(applications?|application form)\b/i.test(t) && JOB_STRONG.test(t)) return true
  return JOB_TASK.some(function (re) { return re.test(t) })
}

/*
 * A short label for an answer Iris learned from the user: the form's own question when Iris quoted it,
 * otherwise the first sentence without "The application asks for your …" around it.
 */
function answerLabel (question) {
  const q = String(question || '').replace(/\s+/g, ' ').trim()
  const quoted = /["“]([^"”]{8,200})["”]/.exec(q)
  let label = quoted ? quoted[1].trim() : q.split(/(?<=[.?!])\s+/)[0]
  if (!quoted) {
    label = label.replace(/^question\s*:\s*/i, '')
      .replace(/^(the|this)\s+(application|form|site|page|job|posting|employer|company)\s+(asks?|needs?|wants?|requires?)\s+((for|about)\s+)?/i, '')
      .replace(/^(your|the)\s+/i, '')
      .replace(/\.$/, '')
    label = label.charAt(0).toUpperCase() + label.slice(1)
  }
  if (label.length > 100) label = label.slice(0, 100).replace(/\s+\S*$/, '') + '…'
  return label
}

/*
 * Job title and company from a posting's link and page title, as each board writes them:
 * Greenhouse "Job Application for <title> at <company>", Lever "<company> - <title> - <team>",
 * Ashby (the API gives the title; the company is in the link), anything else "<title> - <company>".
 */
function jobFromPage (url, pageTitle) {
  const t = String(pageTitle || '').replace(/\s+/g, ' ').trim().replace(/^(job application for|apply for|application for|careers?\s*[-–|:])\s*/i, '')
  let path = []
  let host = ''
  try { const u = new URL(url); host = u.hostname.toLowerCase(); path = u.pathname.split('/').filter(Boolean) } catch (e) { /* not a link */ }
  const nice = function (slug) { return String(slug || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase() }) }
  if (/(^|\.)lever\.co$/.test(host)) {
    const parts = t.split(/ [-–] /)
    if (parts.length >= 2) return { title: parts[1].trim(), company: parts[0].trim() }
    return { title: t, company: nice(path[0]) }
  }
  if (/(^|\.)ashbyhq\.com$/.test(host)) return { title: t.split(/ [-–@|] /)[0].trim(), company: nice(path[0]) }
  if (/\.myworkdayjobs\.com$/.test(host)) return { title: t.split(/ [-–@|] /)[0].trim(), company: nice(host.split('.')[0]) }
  const at = / at ([^|–-]+)$/.exec(t)
  if (at) return { title: t.slice(0, at.index).trim(), company: at[1].trim() }
  const parts = t.split(/ [-–|@] /)
  return { title: parts[0].trim(), company: parts.length > 1 ? parts[parts.length - 1].trim() : (/greenhouse\.io$/.test(host) ? nice(path[0]) : '') }
}

/** Read a pdfLaTeX log: page count and how full the last page is. */
function readLatexLog (log) {
  const text = String(log || '')
  const pages = /Output written on .*?\((\d+) pages?/.exec(text)
  const fill = /IRIS-FILL ([\d.]+)pt ([\d.]+)pt/.exec(text)
  const err = /^! (.+)$/m.exec(text)
  const line = /^l\.(\d+)/m.exec(text)
  let ratio = null
  if (fill && Number(fill[2]) > 0 && Number(fill[2]) < 16000) ratio = Math.min(1, Number(fill[1]) / Number(fill[2]))
  return { pages: pages ? Number(pages[1]) : 0, fill: ratio === null ? 1 : ratio, error: err ? err[1] + (line ? ' (line ' + line[1] + ')' : '') : null }
}

/*
 * LinkedIn's weekly invitation limit, read from the applications' own notes: when it was last met, unless a newer
 * note says a connection request went out. 0 when it is not in force (never met, a week old, or lifted since).
 * A real week (10-18 → 10-23): 297 jobs each spent steps opening LinkedIn just to meet the same limit again.
 */
const LINKEDIN_LIMIT = /(weekly|invitation) (invitation |invite )?limit|out of (invitations|invites)|no (invitations|invites) left/i
const LINKEDIN_SENT = /(connection|invite|invitation)s? (requests? )?(sent|went out)|sent (a |an |\d+ )?(connection|invitation|invite)|connected with/i

function linkedinLimitSeen (applications, now) {
  let limitAt = 0
  let sentAt = 0
  ;(applications || []).forEach(function (a) {
    const at = (a && (a.updated || a.at)) || 0
    const note = String((a && a.note) || '')
    if (LINKEDIN_LIMIT.test(note)) limitAt = Math.max(limitAt, at)
    else if (LINKEDIN_SENT.test(note) && !/already|earlier|before/i.test(note)) sentAt = Math.max(sentAt, at)
  })
  const week = 7 * 24 * 3600 * 1000
  return limitAt && limitAt > sentAt && (now || Date.now()) - limitAt < week ? limitAt : 0
}

module.exports = {
  linkedinLimitSeen,
  SECTION_KINDS,
  isJobTask,
  skillYears,
  jobFromPage,
  answerLabel,
  yearsAsked,
  yearsWorked,
  DEFAULT_TEMPLATE,
  DEFAULT_PREFS,
  normalizeBank,
  bankIsEmpty,
  bankCounts,
  bankText,
  splitItems,
  latexEscape,
  latexToPlain,
  readGroup,
  parseTemplate,
  templateSections,
  renderTemplate,
  contactLine,
  templatize,
  classifySection,
  tailorMessages,
  parseTailorReply,
  coverLetterMessages,
  parseCoverLetter,
  profileFromTextMessages,
  parseProfileFromText,
  coverLetterTex,
  keywordPick,
  checkRewrite,
  factTokens,
  fitToPage,
  readLatexLog,
  layoutToDoc,
  initialLayout
}
