'use strict'

/*
 * iris/agent/autofill.js — the "autofill" tool's thinking: which application forms it may touch, what the
 * user's facts are, and which value or option each standard field gets. No Electron here (main/irisAutofill.js
 * runs it in the page), so all of it is tested with plain node.
 *
 * The user's rule (2026-10-17): a Simplify-like fill is fine on every site but LinkedIn (there Iris works only from
 * screenshots, as before). Only fields with a fact behind them are filled — a deterministic answer from the
 * profile or the saved answers, never a guess; everything else (essays, agreements, odd questions) is left to
 * the agent, which also checks every filled value on the screenshot before it submits.
 */

/* Application sites the tool knows. Greenhouse in full: its forms share one layout (react-select dropdowns,
   label[for] labels, fieldset groups, a hidden file input per document). The others in a basic mode: plain text
   boxes, native dropdowns, radio/checkbox groups and the resume — their custom dropdowns are left to the agent. */
const AUTOFILL_HOSTS = [
  { re: /(^|\.)greenhouse\.io$/i, mode: 'full' },
  { re: /^apply\.workable\.com$/i, mode: 'basic' },
  { re: /(^|\.)smartrecruiters\.com$/i, mode: 'basic' },
  { re: /^ats\.rippling\.com$/i, mode: 'basic' },
  { re: /^recruiting\.paylocity\.com$/i, mode: 'basic' },
  { re: /\.applytojob\.com$/i, mode: 'basic' },
  { re: /^jobs\.ashbyhq\.com$/i, mode: 'basic' },
  { re: /^jobs\.lever\.co$/i, mode: 'basic' }
]
const AUTOFILL_BLOCKED = [/(^|\.)linkedin\.com$/i, /linkedin/i]

function autofillAllowed (url) {
  let host = ''
  try { host = new URL(url).hostname } catch (e) { return { ok: false, why: 'no page is open' } }
  if (AUTOFILL_BLOCKED.some(function (re) { return re.test(host) })) return { ok: false, why: 'autofill never runs on LinkedIn: fill this by hand' }
  // any other site: the basic mode (the user, 2026-10-17: everywhere but LinkedIn)
  const site = AUTOFILL_HOSTS.find(function (h) { return h.re.test(host) }) || { mode: 'basic' }
  if (!/^https?:$/.test(new URL(url).protocol)) return { ok: false, why: 'not a web page' }
  return { ok: true, host: host, mode: site.mode }
}

/* ---------- the user's facts ---------- */

function clean (s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim() }
function titleCase (s) { return clean(s).toLowerCase().replace(/\b[a-z]/g, function (c) { return c.toUpperCase() }) }

const STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia' }

/* "17723 quiet loch ln houston TX 77084" or "Houston, TX 77084" → parts (whatever can be told apart). */
function parseAddress (text, cityHint) {
  const s = clean(text)
  const out = {}
  const zip = s.match(/\b(\d{5})(-\d{4})?\b\s*$/)
  if (zip) out.zip = zip[1]
  const st = s.replace(/\b\d{5}(-\d{4})?\b\s*$/, '').trim().match(/,?\s*\b([A-Z]{2})\b\.?\s*,?$/i)
  if (st && STATES[st[1].toUpperCase()]) { out.stateCode = st[1].toUpperCase(); out.state = STATES[out.stateCode] }
  let rest = s.replace(/\b\d{5}(-\d{4})?\b\s*$/, '').replace(/,?\s*\b[A-Z]{2}\b\.?\s*,?$/i, '').replace(/,\s*$/, '').trim()
  const city = clean(cityHint)
  if (city && new RegExp('\\b' + city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i').test(rest)) {
    out.city = titleCase(city)
    rest = rest.slice(0, rest.length - city.length).replace(/,\s*$/, '').trim()
  } else if (/,/.test(rest)) {
    const parts = rest.split(',')
    out.city = titleCase(parts.pop())
    rest = parts.join(',').trim()
  }
  if (/^\d+\s+\S/.test(rest)) out.street = titleCase(rest)
  return out
}

/*
 * Facts from the career profile (bank) and My info (info: [{label, value, secret}]). Only plain facts: anything
 * the user did not write down stays out, so the tool leaves that field to the agent.
 */
function buildFacts (bank, info) {
  bank = bank || {}
  const b = bank.basics || {}
  const get = function (re) { const f = (info || []).find(function (x) { return !x.secret && re.test(x.label) && x.value }); return f ? clean(f.value) : '' }
  const answer = function (re) { const a = (bank.answers || []).find(function (x) { return re.test(x.label || x.question || '') }); return a ? clean(a.value || a.answer) : '' }
  const name = clean(b.name) || get(/^(full )?name$/i)
  const parts = titleCase(name).split(' ')
  const link = function (re) { const l = (b.links || []).find(function (x) { return re.test(x.label || '') || re.test(x.url || '') }); return l ? l.url : '' }
  const loc = clean(b.location)
  const city = (loc.match(/^([^,]+),/) || [])[1] || ''
  const addr = Object.assign(parseAddress(loc, city), parseAddress(get(/^address$/i), city))
  const edu = (bank.education || [])[0] || {}
  const job = (bank.experience || [])[0] || {}
  const end = clean(edu.dates).match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i)
  const degree = clean(edu.degree)
  const yes = function (s) { return /^\s*yes\b/i.test(s) }
  const facts = {
    firstName: parts[0] || '',
    lastName: parts.length > 1 ? parts.slice(1).join(' ') : '',
    fullName: titleCase(name),
    email: clean(b.email) || get(/^e-?mail$/i),
    phone: clean(b.phone) || get(/^phone/i),
    linkedin: link(/linkedin/i) || answer(/linkedin/i),
    github: link(/github/i) || answer(/github/i),
    website: link(/portfolio|website|personal/i) || answer(/portfolio|website/i),
    city: addr.city || titleCase(city),
    state: addr.state || '',
    stateCode: addr.stateCode || '',
    zip: addr.zip || '',
    street: addr.street || '',
    country: 'United States',
    school: clean(edu.school),
    degreeLevel: /bachelor/i.test(degree) ? 'bachelor' : /master/i.test(degree) ? 'master' : /ph\.?d|doctor/i.test(degree) ? 'phd' : '',
    major: clean((degree.match(/,\s*(.+)$/) || degree.match(/\bin\s+(.+)$/i) || [])[1]),
    gradMonth: end ? titleCase(end[1]) : '',
    gradYear: end ? end[2] : '',
    // "Expected December 2026": the degree is not finished — "highest completed" is high school
    degreeDone: !!degree && !/expected|anticipated|in progress|present/i.test(clean(edu.dates)),
    gpa: answer(/^gpa$/i),
    company: clean(job.company).replace(/\s*\(.*\)\s*$/, ''),
    title: clean(job.title),
    workAuthorized: yes(answer(/work authori[sz]ation/i)),
    sponsorFuture: yes(answer(/needs visa sponsorship|future sponsorship/i)) || /future/i.test(answer(/needs visa sponsorship/i)),
    visaStatus: /f-?1/i.test(answer(/work authori[sz]ation|currently requires sponsorship/i)) ? 'F-1' : '',
    relocate: yes(answer(/relocat/i)),
    startDate: answer(/start date/i),
    gender: answer(/^gender$/i),
    transgender: answer(/transgender/i),
    pronouns: answer(/pronoun/i),
    orientation: answer(/sexual orientation|orientation/i),
    race: answer(/race|ethnic/i),
    veteran: answer(/veteran/i),
    disability: answer(/disabilit/i),
    salary: clean((bank.prefs || {}).salary).replace(/\.\s.*$/, '')
  }
  return facts
}

/* ---------- options ---------- */

/* Index of the first option matching the first pattern that matches anything (patterns in order of preference). */
function pickOption (options, patterns, avoid) {
  const list = (options || []).map(function (o) { return clean(typeof o === 'string' ? o : o.text) })
  for (const re of patterns) {
    for (let i = 0; i < list.length; i++) {
      if (re.test(list[i]) && !(avoid && avoid.test(list[i]))) return i
    }
  }
  return -1
}

const YES = [/^yes\b/i, /^y$/i]
const NO = [/^no\b/i, /^n$/i]
const DECLINE = [/decline/i, /(don'?t|do not) wish/i, /prefer not/i, /not to (say|answer|disclose|self)/i, /choose not/i]

/* ---------- the rules: label → what to put there ---------- */

/*
 * Each rule: test (label), then text (a value for a text box) and/or choose (option patterns, in order of
 * preference; avoid: never these). requires: a fact that must exist. The first rule whose test matches wins;
 * a field with no rule, or whose rule has no fact, is left to the agent.
 */
function rulesFor (f) {
  const genderMale = /^\s*male\b/i.test(f.gender)
  const raceAsianIndian = /asian/i.test(f.race) && /india|south asian/i.test(f.race)
  const notVet = /^\s*no\b/i.test(f.veteran)
  const noDis = /^\s*no\b/i.test(f.disability)
  return [
    // ---- contact
    { test: /^(legal |preferred )?first name|^given name/i, text: f.firstName },
    { test: /^(legal )?last name|^surname|^family name/i, text: f.lastName },
    { test: /^(full |legal |your )?(full )?(legal )?name\b(?!.*(company|school|employer|reference|manager|recruiter|referr))|full legal name/i, text: f.fullName },
    { test: /e-?mail/i, skip: /referr|manager|reference/i, text: f.email },
    { test: /^(mobile |cell |primary )?phone( number)?\b/i, text: f.phone },
    { test: /linkedin/i, text: f.linkedin },
    { test: /github/i, text: f.github },
    { test: /^(personal )?(website|portfolio|blog)|portfolio|personal (site|website)/i, skip: /linkedin|github/i, text: f.website },
    // ---- place
    { test: /^country\b/i, choose: [/^united states( of america)?(\s*\+1)?$/i, /^united states\b(?!.*(minor|islands))/i, /^usa?$/i], text: f.country },
    { test: /^(location|current location|city)\b|location \(city\)|^where are you (currently )?(located|based)/i, place: true, text: f.city && f.state ? f.city + ', ' + f.state : '' },
    { test: /^(street )?address( line 1)?$|street address|home address/i, text: [f.street, f.city, f.stateCode, f.zip].filter(Boolean).join(', ').replace(/, (\d{5})$/, ' $1') },
    { test: /^state\b|^province\b|state\/province/i, choose: f.state ? [new RegExp('^' + f.state + '$', 'i'), new RegExp('^' + f.stateCode + '$', 'i')] : null, text: f.state },
    { test: /^(zip|postal)( code)?\b/i, text: f.zip },
    // ---- education (Greenhouse's school--0 / degree--0 / discipline--0 boxes)
    { test: /^school\b|^university\b|^college\b|^institution\b/i, search: true, choose: f.school ? [new RegExp('^' + f.school + '$', 'i'), new RegExp('^' + f.school + '\\b', 'i')] : null, text: f.school },
    { test: /highest (level of )?(education|degree)|education level|level of education/i, choose: f.degreeDone ? null : [/high school/i, /secondary/i], requires: !f.degreeDone },
    { test: /^degree\b/i, choose: f.degreeLevel === 'bachelor' ? [/^bachelor'?s? degree$/i, /^bachelor/i, /\bB\.?S\.?\b/] : f.degreeLevel === 'master' ? [/^master'?s? degree$/i, /^master/i] : null },
    { test: /^discipline\b|^major\b|field of study|area of study/i, choose: f.major ? [new RegExp('^' + f.major + '$', 'i'), new RegExp(f.major, 'i')] : null, text: f.major },
    { test: /^end date month|graduation month|^end month/i, choose: f.gradMonth ? [new RegExp('^' + f.gradMonth, 'i')] : null, text: f.gradMonth },
    { test: /^end date year|graduation (date|year)|^end year|year of graduation|expected graduation/i, choose: f.gradYear ? [new RegExp('^' + f.gradYear + '$')] : null, text: f.gradYear },
    { test: /^start date (month|year)|^start (month|year)/i, leave: 'not in the profile' },
    { test: /\bgpa\b|grade point/i, text: f.gpa },
    // ---- work
    { test: /current (company|employer)|most recent (company|employer)|^(company|employer)( name)?$/i, text: f.company },
    { test: /current (job )?title|most recent (job )?title|^(job )?title$/i, text: f.title },
    // ---- authorization and sponsorship (plain yes/no boxes only; long option lists go to the agent)
    { test: /(legally )?(authori[sz]ed|eligible) to work|work authori[sz]ation|right to work/i, skip: /sponsor/i, choose: f.workAuthorized ? YES : null, yesNoOnly: true },
    { test: /sponsor/i, yesNoOnly: true, choose: sponsorChoice(f) },
    { test: /willing to relocate|open to relocat|consider relocat|able to relocate/i, yesNoOnly: true, choose: f.relocate ? YES : null, text: f.relocate ? 'Yes' : '' },
    { test: /salary|compensation|pay (expectation|requirement)|desired (pay|salary)/i, skip: /range for this|posted/i, text: f.salary },
    { test: /(18|eighteen) (years of age|years old)|at least 18|over (the age of )?18/i, yesNoOnly: true, choose: YES },
    // marketing texts: no — the site still writes by email and phone calls
    { test: /\bsms\b|text messag|whatsapp/i, yesNoOnly: true, choose: NO },
    // ---- this company
    { test: /(have you|did you)( ever)? (been )?(previously )?(worked|employed|been employed|been engaged)|(current|former) .*(employee|intern|contractor)|do you currently work (for|at)|ever worked (for|at)/i,
      choose: [/never/i, /^no\b/i, /have not|haven'?t/i, /not (worked|been)/i], avoid: /yes/i, text: 'No' },
    { test: /how did you (hear|learn|find)|where did you (hear|find|learn)|source of (your )?application|referral source/i,
      choose: [/company'?s? (web)?site|careers? (page|site|website)|company careers/i, /job board/i, /^other$/i], avoid: /linkedin|referr|employee|recruiter|event|agency/i },
    // ---- voluntary self-identification (saved answers only)
    // a saved answer is said plainly (the user: no "I don't wish to answer" when there is a real answer); the
    // decline option only for a required question with nothing saved
    { test: /transgender/i, choose: f.transgender ? (/^\s*no\b/i.test(f.transgender) ? [/^no\b/i, /do not identify as transgender|don'?t identify as transgender|not transgender/i] : [/^yes\b/i]) : DECLINE, avoid: f.transgender ? /decline|wish|prefer not|not to (say|answer|disclose)/i : null, onlyIfRequired: !f.transgender },
    { test: /sexual orientation/i, choose: f.orientation ? [new RegExp('^' + escapeRe(f.orientation.split(/[ (/]/)[0]), 'i')] : DECLINE, onlyIfRequired: !f.orientation },
    { test: /pronoun/i, choose: f.pronouns ? [new RegExp('^' + escapeRe(f.pronouns.split('/')[0]) + '\\s*/\\s*' + escapeRe((f.pronouns.split('/')[1] || '').trim()), 'i'), new RegExp('^' + escapeRe(f.pronouns.split('/')[0]) + '\\b', 'i')] : DECLINE, text: f.pronouns, onlyIfRequired: !f.pronouns },
    { test: /hispanic|latin[oax]/i, choose: f.race ? (/hispanic|latin/i.test(f.race) ? [/^yes\b/i] : [/^no\b/i, /not hispanic/i]) : null },
    { test: /\brace\b|ethnicity|racial/i, choose: raceAsianIndian ? [/^south asian\b/i, /\bsouth asian\b/i, /^asian\b(?!.*(east|pacific))/i, /^asian$/i] : (/asian/i.test(f.race) ? [/^asian$/i, /^asian\b/i] : null), avoid: /east asian|pacific|two or more|^hispanic/i },
    { test: /^gender\b|gender identity|^sex\b|identify your sex|^what is your gender/i, choose: f.gender ? (genderMale ? [/^male$/i, /^man$/i, /^cisgender man$/i, /^male\b/i, /^man\b/i] : [/^female$/i, /^woman$/i, /^cisgender woman$/i]) : null, avoid: genderMale ? /female|woman|trans/i : /trans/i },
    { test: /veteran|military/i, choose: f.veteran ? (notVet ? [/i am not a protected veteran/i, /not a (protected )?veteran/i, /never served/i, /^no\b/i, /\bi am not\b/i] : null) : null, avoid: notVet ? /^yes|i identify as (a )?(protected|non-protected|one or more)|active duty|reserve|national guard/i : null },
    { test: /disabilit/i, choose: f.disability ? (noDis ? [/^no,? i (don'?t|do not) have a disability/i, /^no\b/i, /do not have a disability|don'?t have a disability/i] : null) : null, avoid: noDis ? /^yes/i : null }
  ]
}

/* "Will you now or in the future require sponsorship …": Yes for the future; for "now/currently" only, the
   question's own list decides (it names F-1/OPT/CPT/STEM → Yes for an F-1 student), else No. */
function sponsorChoice (f) {
  return function (label) {
    const future = /future|ever|at any (point|time)|will you require|will you (now or|need)/i.test(label)
    const nowOnly = !future && /\b(now|currently|current)\b/i.test(label)
    if (future) return f.sponsorFuture ? YES : null
    if (nowOnly) {
      if (f.visaStatus === 'F-1' && /f-?1|opt\b|cpt\b|stem/i.test(label)) return YES
      return f.visaStatus === 'F-1' ? NO : null
    }
    return f.sponsorFuture ? YES : null
  }
}

/*
 * What to do with one collected field: {do:'text', value} | {do:'choose', patterns, avoid, search} |
 * {do:'upload', file:'resume'} | {do:'leave', why}. Fields that already hold a value are left as they are.
 */
function planField (field, facts, mode) {
  const label = clean(field.label).replace(/\s*\*\s*$/, '').replace(/\*/g, '').trim()
  if (mode === 'basic' && field.kind === 'combobox') return { do: 'leave', why: 'a custom dropdown on this site: pick it by hand' }
  if (field.kind === 'file') {
    if (/resume|cv\b/i.test(label) || /resume/i.test(field.id || '')) return field.value ? { do: 'leave', why: 'already attached' } : { do: 'upload', file: 'resume' }
    return { do: 'leave', why: 'a document other than the resume' }
  }
  if (field.value) return { do: 'leave', why: 'already filled' }
  if (!label) return { do: 'leave', why: 'no label' }
  const rule = rulesFor(facts).find(function (r) { return r.test.test(label) && !(r.skip && r.skip.test(label)) })
  if (!rule) return { do: 'leave', why: 'not a standard question' }
  if (rule.leave) return { do: 'leave', why: rule.leave }
  if (rule.requires === false) return { do: 'leave', why: 'no fact for it' }
  if (rule.onlyIfRequired && !field.required) return { do: 'leave', why: 'optional, no saved answer' }
  const choose = typeof rule.choose === 'function' ? rule.choose(label) : rule.choose
  const isChoice = field.kind === 'combobox' || field.kind === 'select' || field.kind === 'radios' || field.kind === 'checkboxes'
  if (isChoice) {
    if (!choose) {
      // a box that searches as you type (School, a city): the text is what to search for
      if (field.kind === 'combobox' && rule.text && (rule.search || rule.place)) return { do: 'choose', search: rule.text, patterns: [new RegExp('^' + escapeRe(rule.text), 'i')], place: !!rule.place }
      return { do: 'leave', why: 'no saved answer' }
    }
    if (rule.yesNoOnly && field.options && field.options.length && !field.options.every(function (o) { return /^(yes|no)\b/i.test(clean(o)) && clean(o).length <= 12 })) {
      return { do: 'leave', why: 'its options are more than yes/no: the agent reads them' }
    }
    if (field.options && field.options.length) {
      const i = pickOption(field.options, choose, rule.avoid)
      if (i < 0) return { do: 'leave', why: 'no option matches the saved answer' }
      return { do: 'choose', option: clean(field.options[i]), patterns: choose, avoid: rule.avoid || null }
    }
    // options are only known once the list is open (react-select): the runner picks with the same patterns
    return { do: 'choose', patterns: choose, avoid: rule.avoid || null, yesNoOnly: !!rule.yesNoOnly, search: rule.search ? rule.text : null, place: !!rule.place }
  }
  if (field.kind === 'text' || field.kind === 'textarea') {
    if (field.kind === 'textarea' && !/address/i.test(label)) return { do: 'leave', why: 'a written answer: the agent writes it' }
    if (field.inputType === 'number' || field.inputType === 'date') return { do: 'leave', why: 'a ' + field.inputType + ' box: the agent fills it' }
    const value = rule.text
    if (!value) return { do: 'leave', why: 'no fact for it' }
    return { do: 'text', value: value }
  }
  return { do: 'leave', why: 'unknown kind of field' }
}

function escapeRe (s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/* ---------- page scripts (run inside the form's page by main/irisAutofill.js) ---------- */

/*
 * Lists the form's fields. Each gets data-iris-af="fN" so later scripts find it again.
 * kinds: text, textarea, combobox (react-select), select, checkboxes / radios (one per group), file.
 */
const PAGE_COLLECT = `(() => {
  const clean = s => String(s || '').replace(/\\s+/g, ' ').trim();
  const visible = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return (r.width > 0 && r.height > 0) || el.type === 'file' || cs.position === 'absolute'; };
  const labelOf = el => {
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l && clean(l.innerText)) return clean(l.innerText); }
    const by = el.getAttribute('aria-labelledby'); if (by) { const t = by.split(' ').map(i => document.getElementById(i)).filter(Boolean).map(n => n.innerText).join(' '); if (clean(t)) return clean(t); }
    if (el.getAttribute('aria-label')) return clean(el.getAttribute('aria-label'));
    const fsx = el.closest('fieldset'); if (fsx && fsx.querySelector('legend')) return clean(fsx.querySelector('legend').innerText);
    const wrap = el.closest('.field, .select, .text-input-wrapper, .input-wrapper, div'); const l2 = wrap && wrap.querySelector('label'); return l2 ? clean(l2.innerText) : '';
  };
  const form = document.querySelector('form#application-form, form#application_form, form.application--form, form') || document;
  const out = []; let n = 0; const seenGroups = new Set();
  form.querySelectorAll('input, select, textarea').forEach(el => {
    const t = (el.type || '').toLowerCase();
    if (t === 'hidden' || t === 'submit' || t === 'button' || el.disabled) return;
    if (/recaptcha/i.test(el.name || el.id || '')) return;
    if (!el.id && !el.name && t !== 'file') return;
    if (t === 'checkbox' || t === 'radio') {
      const grp = el.closest('fieldset') || el.parentElement.parentElement;
      const key = (el.name || '') + '|' + (grp && grp.id || '');
      if (seenGroups.has(key)) return; seenGroups.add(key);
      const boxes = [...grp.querySelectorAll('input[type=' + t + ']')];
      const id = 'f' + (++n); grp.setAttribute('data-iris-af', id);
      const legend = grp.querySelector('legend');
      const by = grp.getAttribute('aria-labelledby');
      const byText = by ? clean(by.split(' ').map(i => document.getElementById(i)).filter(Boolean).map(n => n.innerText).join(' ')) : '';
      const gl = legend ? clean(legend.innerText) : (byText || labelOf(el));
      const optText = b => { const l = (b.id && document.querySelector('label[for="' + CSS.escape(b.id) + '"]')) || b.closest('label'); return clean(l ? l.innerText : (b.getAttribute('aria-label') || b.value)); };
      out.push({ key: id, id: grp.id || el.name, kind: t === 'checkbox' ? 'checkboxes' : 'radios', label: gl, required: grp.getAttribute('aria-required') === 'true' || boxes.some(b => b.required) || /\\*/.test(gl),
        options: boxes.map(optText), value: boxes.filter(b => b.checked).map(optText).join(', ') });
      return;
    }
    if (!visible(el) && t !== 'file') return;
    const id = 'f' + (++n); el.setAttribute('data-iris-af', id);
    const lab = labelOf(el);
    let kind = el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : t === 'file' ? 'file' : (el.getAttribute('role') === 'combobox' ? 'combobox' : 'text');
    let value = '', options = null;
    if (kind === 'combobox') {
      const ctl = el.closest('.select__control') || el.closest('[class*="control"]');
      const sv = ctl && ctl.querySelectorAll('[class*="single-value"], [class*="multi-value__label"]');
      value = sv && sv.length ? [...sv].map(x => clean(x.innerText)).join(', ') : '';
    } else if (kind === 'select') {
      options = [...el.options].filter(o => o.value !== '').map(o => clean(o.text)); value = el.value ? clean(el.options[el.selectedIndex].text) : '';
    } else if (kind === 'file') {
      const box = el.closest('.file-upload, [class*="upload"], .field') || el.parentElement;
      value = box && /\\.(pdf|docx?|txt|rtf)\\b/i.test(box.innerText) ? clean(box.innerText).slice(0, 80) : '';
    } else { value = clean(el.value); }
    let label = lab;
    if (kind === 'file') { const byId = /resume/i.test(el.id) ? 'Resume/CV' : /cover/i.test(el.id) ? 'Cover Letter' : ''; const box = el.closest('div[class*="upload"], .field, fieldset'); const l = !byId && box && box.querySelector('[id$="label"], .upload-label, legend'); label = byId || (lab && !/^(attach|choose file|upload|browse)$/i.test(lab) ? lab : '') || clean(l ? l.innerText : '') || el.id; }
    const req = el.required || el.getAttribute('aria-required') === 'true' || /\\*/.test(lab);
    out.push({ key: id, id: el.id || el.name, kind, inputType: t, label: label.replace(/\\s*\\*\\s*$/, ''), required: !!req, value, options });
  });
  return out;
})()`

/* Scrolls field {key} (or its option {index}) into the middle of the view; returns its centre in CSS px. The
   scroll is instant: many forms set scroll-behavior:smooth, and a rect read mid-glide puts the click elsewhere. */
function pageRect (key, part) {
  return `(() => {
    const host = document.querySelector('[data-iris-af="${key}"]'); if (!host) return null;
    let el = host;
    const part = ${JSON.stringify(part || '')};
    if (part === 'control') el = host.closest('.select__control') || host.closest('[class*="control"]') || host;
    else if (part.indexOf('box:') === 0) { const i = +part.slice(4); el = host.querySelectorAll('input[type=checkbox], input[type=radio]')[i]; const l = el && ((el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) || el.closest('label')); el = l || el; }
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + Math.min(r.width / 2, 120)), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth, vh: innerHeight };
  })()`
}

/* The options of the open react-select list of field {key}, with their centres. */
function pageOptions (key) {
  return `(() => {
    const host = document.querySelector('[data-iris-af="${key}"]'); if (!host) return null;
    const lb = host.getAttribute('aria-controls') && document.getElementById(host.getAttribute('aria-controls'));
    const opts = [...(lb || document).querySelectorAll('[role="option"]')];
    return opts.map((o, i) => { const r = o.getBoundingClientRect(); return { i, text: String(o.innerText || '').replace(/\\s+/g, ' ').trim(), x: Math.round(r.left + Math.min(r.width / 2, 120)), y: Math.round(r.top + r.height / 2), h: Math.round(r.height), inView: r.top >= 0 && r.bottom <= innerHeight }; });
  })()`
}

/* Scrolls option {index} of field {key}'s open list into view inside the list; returns its centre. */
function pageOptionRect (key, index) {
  return `(() => {
    const host = document.querySelector('[data-iris-af="${key}"]'); if (!host) return null;
    const lb = host.getAttribute('aria-controls') && document.getElementById(host.getAttribute('aria-controls'));
    const o = [...(lb || document).querySelectorAll('[role="option"]')][${Number(index) || 0}]; if (!o) return null;
    o.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    const r = o.getBoundingClientRect();
    return { x: Math.round(r.left + Math.min(r.width / 2, 120)), y: Math.round(r.top + r.height / 2) };
  })()`
}

/* What field {key} shows now (a text box's value, a dropdown's chosen option, the ticked boxes). */
function pageValue (key) {
  return `(() => {
    const el = document.querySelector('[data-iris-af="${key}"]'); if (!el) return null;
    const clean = s => String(s || '').replace(/\\s+/g, ' ').trim();
    if (el.getAttribute('role') === 'combobox') { const ctl = el.closest('.select__control') || el.closest('[class*="control"]'); const sv = ctl && ctl.querySelectorAll('[class*="single-value"], [class*="multi-value__label"]'); return sv && sv.length ? [...sv].map(x => clean(x.innerText)).join(', ') : ''; }
    if (el.tagName === 'SELECT') return el.value ? clean(el.options[el.selectedIndex].text) : '';
    if (el.tagName === 'FIELDSET' || el.querySelector) { const boxes = el.querySelectorAll ? [...el.querySelectorAll('input[type=checkbox], input[type=radio]')] : []; if (boxes.length) return boxes.filter(b => b.checked).map(b => { const l = (b.id && document.querySelector('label[for="' + CSS.escape(b.id) + '"]')) || b.closest('label'); return clean(l ? l.innerText : (b.getAttribute('aria-label') || b.value)); }).join(', '); }
    if (el.type === 'file') { const box = el.closest('.file-upload, [class*="upload"], .field') || el.parentElement; return box && /\\.(pdf|docx?|txt|rtf)\\b/i.test(box.innerText) ? 'attached' : ''; }
    return clean(el.value);
  })()`
}

/* Puts {value} into text box {key} the way React notices (its own value setter, then input/change/blur). */
function pageSetText (key, value) {
  return `(() => {
    const el = document.querySelector('[data-iris-af="${key}"]'); if (!el) return false;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.focus({ preventScroll: true });
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    return el.value;
  })()`
}

/* Picks option {text} of native select {key}. */
function pageSetSelect (key, text) {
  return `(() => {
    const el = document.querySelector('[data-iris-af="${key}"]'); if (!el || el.tagName !== 'SELECT') return false;
    const o = [...el.options].find(o => o.text.replace(/\\s+/g, ' ').trim() === ${JSON.stringify(String(text))}); if (!o) return false;
    el.value = o.value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`
}

/* The form's top, for the agent's check afterwards. */
const PAGE_SCROLL_TOP = `(() => { const f = document.querySelector('[data-iris-af="f1"]'); const t = f && (f.closest('form') || f); if (t) t.scrollIntoView({ block: 'start', behavior: 'instant' }); window.scrollBy({ top: -80, behavior: 'instant' }); return true; })()`

module.exports = {
  AUTOFILL_HOSTS,
  autofillAllowed,
  parseAddress,
  buildFacts,
  pickOption,
  planField,
  PAGE_COLLECT,
  pageRect,
  pageOptions,
  pageOptionRect,
  pageValue,
  pageSetText,
  pageSetSelect,
  PAGE_SCROLL_TOP
}
