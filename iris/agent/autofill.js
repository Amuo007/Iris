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
    years: (function () { const m = answer(/years of experience/i).match(/(\d+(\.\d+)?)/); return m ? parseFloat(m[1]) : null })(),
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

/* The option of a years-of-experience list whose range holds n ("0-1", "1-3 years", "Less than 2", "2+", "None"). */
function pickYears (options, n) {
  const list = (options || []).map(function (o) { return clean(typeof o === 'string' ? o : o.text) })
  for (let i = 0; i < list.length; i++) {
    const t = list[i].toLowerCase().replace(/[–—]/g, '-')
    let m
    if ((m = t.match(/(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)/))) { if (n >= +m[1] && n <= +m[2]) return i; continue }
    if ((m = t.match(/(?:less than|under|fewer than|<)\s*(\d+(?:\.\d+)?)/))) { if (n < +m[1]) return i; continue }
    if ((m = t.match(/(\d+(?:\.\d+)?)\s*(?:\+|or more|plus|years? or more)/))) { if (n >= +m[1]) return i; continue }
    if ((m = t.match(/^(\d+(?:\.\d+)?)\s*(years?)?$/))) { if (n === +m[1]) return i; continue }
    if (/^(none|no experience|0)$/.test(t) && n === 0) return i
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
    { test: /^(legal |preferred )?first name|^given name/i, text: f.firstName, sure: true },
    { test: /^(legal )?last name|^surname|^family name/i, text: f.lastName, sure: true },
    { test: /^(full |legal |your )?(full )?(legal )?name\b(?!.*(company|school|employer|reference|manager|recruiter|referr))|full legal name/i, text: f.fullName },
    { test: /^(your )?e-?mail( address)?\b|^(confirm|re-?enter|repeat|verify|retype) (your )?e-?mail/i, skip: /referr|manager|reference/i, text: f.email, short: true, sure: true },
    { test: /^(mobile |cell |primary )?phone( number)?\b|^mobile( number)?\b/i, text: f.phone, sure: true },
    { test: /^(your )?linkedin\b|linkedin (profile|url)/i, text: f.linkedin, short: true },
    { test: /^(your )?github\b|github (profile|url)/i, text: f.github, short: true },
    { test: /^(your |personal )?(website|portfolio|blog)\b|personal (site|website)/i, skip: /linkedin|github/i, text: f.website, short: true },
    // ---- place
    { test: /^country\b/i, choose: [/^united states( of america)?(\s*\+1)?$/i, /^united states\b(?!.*(minor|islands))/i, /^usa?$/i], text: f.country },
    { test: /^(location|current location)\b|location \(city\)|^where are you (currently )?(located|based)/i, place: true, text: f.city && f.state ? f.city + ', ' + f.state : '' },
    { test: /^city\b/i, text: f.city, sure: true },
    { test: /^(street )?address( line 1)?$|street address|home address/i, text: [f.street, f.city, f.stateCode, f.zip].filter(Boolean).join(', ').replace(/, (\d{5})$/, ' $1') },
    { test: /^state\b|^province\b|state\/province/i, choose: f.state ? [new RegExp('^' + f.state + '$', 'i'), new RegExp('^' + f.stateCode + '$', 'i')] : null, text: f.state },
    { test: /^(zip|postal)( code)?\b/i, text: f.zip, sure: true },
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
    { test: /(current|most recent|present)\b[^?]{0,25}\b(company|employer)|^(company|employer)( name)?$/i, skip: /previous|former|ever|before/i, text: f.company },
    { test: /(current|most recent|present)\b[^?]{0,25}\b(job )?(title|position|role)\b|^(job )?title$/i, skip: /previous|former|desired|applying/i, text: f.title },
    // ---- authorization and sponsorship (plain yes/no boxes only; long option lists go to the agent)
    { test: /(legally )?(authori[sz]ed|eligible) to work|work authori[sz]ation|right to work/i, skip: /sponsor/i, choose: f.workAuthorized ? YES : null, yesNoOnly: true },
    { test: /sponsor/i, yesNoOnly: true, choose: sponsorChoice(f) },
    { test: /willing to relocate|open to relocat|consider relocat|able to relocate/i, yesNoOnly: true, choose: f.relocate ? YES : null, text: f.relocate ? 'Yes' : '' },
    { test: /salary|compensation|pay (expectation|requirement)|desired (pay|salary)/i, skip: /range for this|posted/i, text: f.salary },
    { test: /(18|eighteen) (years of age|years old)|at least 18|over (the age of )?18/i, yesNoOnly: true, choose: YES },
    // availability that follows from "willing to relocate": on-site, hybrid, office days, commuting
    { test: /(able|willing|comfortable|open) (to )?(work(ing)? |be(ing)? )?(on-?site|in(-| )office|in person|hybrid|from (the|our) office|commut\w*|relocat\w*)|work(ing)? (on-?site|in(-| )office|hybrid)\b.*\?|(days|times) (a|per) week in (the )?office/i,
      skip: /sponsor|authori|citizen|clearance/i, yesNoOnly: true, choose: f.relocate ? YES : null },
    { test: /(earliest|available) (start|to start)|start date|when can you start|availability to start/i, skip: /month|year/i, text: f.startDate ? f.startDate.replace(/\s*\(.*\)\s*$/, '') : '' },
    { test: /years of (professional |relevant |industry |software |work )*(engineering |industry )?experience|how many years/i, skip: /^(do|have|are|did) you\b|\d+\s*\+/i, pick: f.years !== null ? function (opts) { return pickYears(opts, f.years) } : null, text: f.years !== null ? String(f.years) : '' },
    // "Do you have 3+ years of …?" — a sure No when the profile has fewer years in all (a skill's years are never more)
    { test: /\b(\d+)\s*\+?\s*(or more )?years\b.*experience|experience.*\b(\d+)\s*\+?\s*(or more )?years\b/i, skip: /how many|what is|list|describe/i, yesNoOnly: true,
      choose: f.years !== null ? function (label) { const m = label.match(/\b(\d+)\s*\+?\s*(or more )?years\b/i); return m && +m[1] > f.years ? NO : null } : null },
    { test: /security clearance/i, skip: /if (yes|so)|list|which|level/i, yesNoOnly: true, choose: NO },
    { test: /^(are you )?(a )?u\.?s\.? citizen\??$|are you a (united states|u\.?s\.?) citizen\??$/i, yesNoOnly: true, choose: f.visaStatus ? NO : null },
    // marketing texts: no — the site still writes by email and phone calls
    { test: /\bsms\b|text messag|whatsapp/i, choose: [/^no\b/i, /do not consent|don'?t consent|opt out/i], avoid: /^yes\b|i consent to/i },
    // ---- this company
    { test: /(have you|did you)( ever)? (been )?(previously )?(worked|employed|been employed|been engaged)|(current|former) .*(employee|intern|contractor)|do you currently work (for|at)|ever worked (for|at)/i,
      choose: [/never/i, /^no\b/i, /have not|haven'?t/i, /not (worked|been)/i], avoid: /yes/i, text: 'No' },
    // a privacy notice to acknowledge (not an agreement that binds the user: those the agent reads)
    { test: /privacy (policy|notice|acknowledg)|personal (information|data) (policy|notice)|candidate privacy|applicant privacy/i, skip: /arbitration|non-?compete|agreement to|waive/i,
      choose: [/^yes\b/i, /acknowledge/i, /^i (have read|agree|accept|understand)/i, /agree/i], avoid: /^no\b|do not|don'?t/i },
    { test: /how did you (hear|learn|find)|where did you (hear|find|learn)|source of (your )?application|referral source/i,
      // the postings come from a job-board list (the user's n8n digest of new-grad boards): "job board" is the truth
      choose: [/job board|online job|job (site|posting site)|internet job/i, /company'?s? (web)?site|careers? (page|site|website)|company careers/i, /^other$/i], avoid: /linkedin|referr|employee|recruiter|event|agency/i, text: 'Job board' },
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
  if (mode === 'basic' && field.kind === 'combobox' && !field.aria) return { do: 'leave', why: 'a custom dropdown on this site: pick it by hand' }
  if (field.kind === 'file') {
    if (/resume import|site autofill/i.test(label)) return { do: 'leave', why: 'the site\'s resume import (its own autofill): not used' }
    if (/resume|cv\b/i.test(label) || /resume/i.test(field.id || '')) return field.value ? { do: 'leave', why: 'already attached' } : { do: 'upload', file: 'resume' }
    return { do: 'leave', why: 'a document other than the resume' }
  }
  if (!label) return { do: 'leave', why: field.value ? 'already filled' : 'no label' }
  // contact boxes have short labels: a long question that merely mentions "email" or "LinkedIn" is not one
  const rule = rulesFor(facts).find(function (r) { return r.test.test(label) && !(r.skip && r.skip.test(label)) && !(r.short && label.length > 60) })
  if (field.value) {
    // a box already filled (the site's resume import, a browser's saved address): the profile is the truth for the
    // sure facts — put it right when it differs, else leave it
    if (rule && rule.sure && rule.text && field.kind === 'text' && !sameValue(field.value, rule.text)) return { do: 'text', value: rule.text, replace: field.value }
    return { do: 'leave', why: 'already filled' }
  }
  if (!rule) return { do: 'leave', why: 'not a standard question' }
  if (rule.leave) return { do: 'leave', why: rule.leave }
  if (rule.requires === false) return { do: 'leave', why: 'no fact for it' }
  if (rule.onlyIfRequired && !field.required) return { do: 'leave', why: 'optional, no saved answer' }
  const choose = typeof rule.choose === 'function' ? rule.choose(label) : rule.choose
  const isChoice = field.kind === 'combobox' || field.kind === 'select' || field.kind === 'radios' || field.kind === 'checkboxes'
  if (isChoice && rule.pick) {
    // a list judged by a function (years of experience ranges)
    if (field.options && field.options.length) {
      const i = rule.pick(field.options)
      return i < 0 ? { do: 'leave', why: 'no option fits' } : { do: 'choose', option: clean(field.options[i]), pick: rule.pick }
    }
    return { do: 'choose', pick: rule.pick, patterns: [] }
  }
  if (isChoice && rule.pick === null && rule.test.test(label) && rulesFor.length) return { do: 'leave', why: 'no saved answer' }
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
    const value = rule.text
    if (!value) return { do: 'leave', why: 'no fact for it' }
    // a number box takes a plain number (a year, GPA, ZIP); a date box is left to the agent (its format varies)
    if (field.inputType === 'date' || (field.inputType === 'number' && !/^\d+(\.\d+)?$/.test(String(value)))) return { do: 'leave', why: 'a ' + field.inputType + ' box: the agent fills it' }
    return { do: 'text', value: value }
  }
  return { do: 'leave', why: 'unknown kind of field' }
}

/* The same fact written two ways: case and spaces, phone digits, a state and its code. */
function sameValue (a, b) {
  const n = function (x) { return clean(x).toLowerCase() }
  if (n(a) === n(b)) return true
  const d = function (x) { return String(x).replace(/\D/g, '') }
  if (/^[\d\s()+.-]{7,}$/.test(a) && /^[\d\s()+.-]{7,}$/.test(b)) return d(a).slice(-10) === d(b).slice(-10)
  const code = Object.keys(STATES).find(function (k) { return STATES[k].toLowerCase() === n(b) })
  if (code && n(a) === code.toLowerCase()) return true
  return false
}

function escapeRe (s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/* ---------- page scripts (run inside the form's page by main/irisAutofill.js) ---------- */

/* Shared by every page script: find things inside shadow roots too (web-component forms such as SmartRecruiters'
   "Easy apply"), and look labels and ids up in the element's own root first. */
const AF_DEEP = "const __deep = (sel, root) => { const out = []; const walk = r => { r.querySelectorAll(sel).forEach(e => out.push(e)); r.querySelectorAll('*').forEach(e => { if (e.shadowRoot) walk(e.shadowRoot); }); }; walk(root || document); return out; };" +
  " const __one = sel => document.querySelector(sel) || __deep(sel)[0] || null;" +
  " const __root = el => (el && el.getRootNode && el.getRootNode().querySelector) ? el.getRootNode() : document;" +
  " const __labelFor = el => el && el.id ? (__root(el).querySelector('label[for=\"' + CSS.escape(el.id) + '\"]') || document.querySelector('label[for=\"' + CSS.escape(el.id) + '\"]')) : null;" +
  " const __byId = (el, i) => (__root(el).getElementById ? __root(el).getElementById(i) : null) || document.getElementById(i);"


/*
 * Lists the form's fields. Each gets data-iris-af="fN" so later scripts find it again.
 * kinds: text, textarea, combobox (react-select), select, checkboxes / radios (one per group), file.
 */
const PAGE_COLLECT = `(() => {
  ${AF_DEEP}
  const clean = s => String(s || '').replace(/\\s+/g, ' ').trim();
  const visible = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return (r.width > 0 && r.height > 0) || el.type === 'file' || cs.position === 'absolute'; };
  const placeholder = s => /^(select( an option| one)?\\.{0,3}|search\\.{0,3}|choose\\.{0,3}|--+|please select)$/i.test(s);
  const labelOf = el => {
    if (el.id) { const l = __labelFor(el); if (l && clean(l.innerText)) return clean(l.innerText); }
    const by = el.getAttribute('aria-labelledby'); if (by) { const t = by.split(' ').map(i => __byId(el, i)).filter(Boolean).map(n => n.innerText).join(' '); if (clean(t)) return clean(t); }
    const al = clean(el.getAttribute('aria-label')); if (al && !placeholder(al)) return al;
    const fsx = el.closest('fieldset'); if (fsx && fsx.querySelector('legend')) return clean(fsx.querySelector('legend').innerText);
    const wrap = el.closest('.field, .select, .text-input-wrapper, .input-wrapper, div'); const l2 = wrap && wrap.querySelector('label'); if (l2 && clean(l2.innerText)) return clean(l2.innerText);
    // a dropdown with no label element: the question is the text around it (walk up until there is more than the
    // dropdown's own placeholder)
    if (el.getAttribute('role') === 'combobox') { const own = clean(el.tagName === 'INPUT' ? el.value : el.innerText); let up = el; for (let k = 0; k < 8 && up; k++) { up = up.parentElement; if (!up) break; let t = clean(up.innerText || ''); up.querySelectorAll('[role=listbox], [role=status], [role=alert], [aria-live]').forEach(x => { const xt = clean(x.innerText); if (xt) t = clean(t.split(xt).join(' ')); }); const rest = clean(own ? t.split(own).join(' ') : t); if (rest.length >= 3) return rest.length <= 300 ? rest : ''; } }
    return '';
  };
  const form = document.querySelector('form#application-form, form#application_form, form.application--form, form') || document;
  const out = []; let n = 0; const seenGroups = new Set();
  const SEL = 'input, select, textarea, [role=combobox]:not(input):not(select):not(textarea)';
  let all = [...form.querySelectorAll(SEL)];
  if (all.filter(e => e.type !== 'hidden' && e.type !== 'file').length < 3) all = __deep(SEL);
  all.forEach(el => {
    const t = (el.type || '').toLowerCase();
    if (t === 'hidden' || t === 'submit' || t === 'button' || el.disabled) return;
    if (/recaptcha/i.test(el.name || el.id || '')) return;
    if (!el.id && !el.name && t !== 'file') return;
    if (t === 'checkbox' || t === 'radio') {
      // one group per name (radios of one question can sit in separate wrappers); its box: the smallest element
      // holding all of them
      const same = el.name ? [...__root(el).querySelectorAll('input[type=' + t + '][name="' + CSS.escape(el.name) + '"]')] : [];
      let grp = el.closest('fieldset') || el.parentElement.parentElement;
      if (same.length > 1) { grp = el.parentElement; while (grp && !same.every(b => grp.contains(b))) grp = grp.parentElement; grp = grp || document.body; }
      const key = (el.name || '') + '|' + (grp && grp.id || '') + '|' + (same.length > 1 ? 'name' : '');
      if (seenGroups.has(key)) return; seenGroups.add(key);
      const boxes = same.length > 1 ? same : [...grp.querySelectorAll('input[type=' + t + ']')];
      const id = 'f' + (++n); grp.setAttribute('data-iris-af', id);
      const legend = grp.querySelector('legend');
      const by = grp.getAttribute('aria-labelledby');
      const byText = by ? clean(by.split(' ').map(i => __byId(grp, i)).filter(Boolean).map(n => n.innerText).join(' ')) : '';
      const optText = b => { const l = __labelFor(b) || b.closest('label'); if (l && clean(l.innerText)) return clean(l.innerText); const bl = b.getAttribute('aria-labelledby'); const bt = bl ? clean(bl.split(' ').map(i => __byId(b, i)).filter(Boolean).map(x => x.innerText).join(' ')) : ''; return bt || clean(b.getAttribute('aria-label') || b.value); };
      const opts = boxes.map(optText);
      // the question: the legend, the group's own label, else the group's first line of text that is not an option
      const firstLine = clean(String(grp.innerText || '').split('\\n').map(x => x.trim()).find(x => x && !opts.some(o => o && (x === o || x.indexOf(o) === 0))) || '');
      const gl = legend ? clean(legend.innerText) : (byText || (same.length > 1 ? firstLine : '') || labelOf(el));
      out.push({ key: id, id: grp.id || el.name, kind: t === 'checkbox' ? 'checkboxes' : 'radios', label: gl, required: grp.getAttribute('aria-required') === 'true' || boxes.some(b => b.required) || /\\*/.test(gl),
        options: opts, value: boxes.filter(b => b.checked).map(optText).join(', ') });
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
      if (sv && sv.length) value = [...sv].map(x => clean(x.innerText)).join(', ');
      else if (!ctl) { const own = clean(el.tagName === 'INPUT' ? el.value : el.innerText); value = placeholder(own) ? '' : own; }
    } else if (kind === 'select') {
      options = [...el.options].filter(o => o.value !== '').map(o => clean(o.text)); value = el.value ? clean(el.options[el.selectedIndex].text) : '';
    } else if (kind === 'file') {
      const box = el.closest('.file-upload, [class*="upload"], .field') || el.parentElement;
      value = box && /[\\w)-]\\.(pdf|docx?|txt|rtf)\\b/i.test(box.innerText) ? clean(box.innerText).slice(0, 80) : '';
    } else { value = clean(el.value); }
    let label = lab;
    if (kind === 'file') {
      const byId = /resume|\\bcv\\b/i.test(el.id + ' ' + el.name) ? 'Resume/CV' : /cover/i.test(el.id + ' ' + el.name) ? 'Cover Letter' : '';
      // else the nearest text around the box that names the document ("Resume", "Cover letter")
      let near = ''; let a = el; let importer = false;
      for (let k = 0; k < 8 && a && !near; k++) { a = a.parentElement || (a.getRootNode && a.getRootNode().host) || null; const tx = a ? clean(a.innerText || '') : ''; if (/autofill|auto-?complete|easy apply|import|pars(e|ing)|apply with (your )?(resume|linkedin)/i.test(tx) && tx.length < 600) importer = true; const m = tx.match(/(resume|r\u00e9sum\u00e9|\\bcv\\b|curriculum vitae|cover letter)/i); if (m && tx.length < 400) near = /cover/i.test(m[1]) ? 'Cover Letter' : 'Resume/CV'; }
      // a box that reads a resume to fill the form for you is the site's own autofill: not the resume field
      if (importer) near = 'Resume import (the site autofill)';
      label = byId || (lab && !/^(attach|choose file|upload|browse|drop or select)/i.test(lab) && /resume|cv|cover|document/i.test(lab) ? lab : '') || near || lab || el.id;
    }
    const req = el.required || el.getAttribute('aria-required') === 'true' || /\\*/.test(lab);
    const aria = kind === 'combobox' && (el.hasAttribute('aria-expanded') || el.getAttribute('aria-haspopup') === 'listbox' || el.hasAttribute('aria-controls'));
    out.push({ key: id, id: el.id || el.name, kind, inputType: t, label: label.replace(/\\s*\\*\\s*$/, ''), required: !!req, value, options, aria });
  });
  return out;
})()`

/* Scrolls field {key} (or its option {index}) into the middle of the view; returns its centre in CSS px. The
   scroll is instant: many forms set scroll-behavior:smooth, and a rect read mid-glide puts the click elsewhere. */
function pageRect (key, part) {
  return `(() => {
    ${AF_DEEP}
    const host = __one('[data-iris-af="${key}"]'); if (!host) return null;
    let el = host;
    const part = ${JSON.stringify(part || '')};
    if (part === 'control') el = host.closest('.select__control') || host.closest('[class*="control"]') || host;
    else if (part.indexOf('box:') === 0) { const i = +part.slice(4); el = host.querySelectorAll('input[type=checkbox], input[type=radio]')[i]; const l = el && (__labelFor(el) || el.closest('label')); el = l || el; }
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + Math.min(r.width / 2, 120)), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth, vh: innerHeight };
  })()`
}

/* The options of the open react-select list of field {key}, with their centres. */
function pageOptions (key) {
  return `(() => {
    ${AF_DEEP}
    const host = __one('[data-iris-af="${key}"]'); if (!host) return null;
    const lb = host.getAttribute('aria-controls') && document.getElementById(host.getAttribute('aria-controls'));
    const opts = [...(lb || document).querySelectorAll('[role="option"]')];
    return opts.map((o, i) => { const r = o.getBoundingClientRect(); return { i, text: String(o.innerText || '').replace(/\\s+/g, ' ').trim(), x: Math.round(r.left + Math.min(r.width / 2, 120)), y: Math.round(r.top + r.height / 2), h: Math.round(r.height), inView: r.top >= 0 && r.bottom <= innerHeight }; });
  })()`
}

/* Scrolls option {index} of field {key}'s open list into view inside the list; returns its centre. */
function pageOptionRect (key, index) {
  return `(() => {
    ${AF_DEEP}
    const host = __one('[data-iris-af="${key}"]'); if (!host) return null;
    const lb = host.getAttribute('aria-controls') && document.getElementById(host.getAttribute('aria-controls'));
    const o = [...(lb || document).querySelectorAll('[role="option"]')][${Number(index) || 0}]; if (!o) return null;
    o.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    const r = o.getBoundingClientRect();
    return { x: Math.round(r.left + Math.min(r.width / 2, 120)), y: Math.round(r.top + r.height / 2) };
  })()`
}

/* What field {key} shows now (a text box's value, a dropdown's chosen option, the ticked boxes). A file box the
   page replaced after the upload is found again by the section marked around it (pageMarkBox). */
function pageValue (key) {
  return `(() => {
    ${AF_DEEP}
    const el = __one('[data-iris-af="${key}"]');
    if (!el) { const box = __one('[data-iris-afbox="${key}"]'); return box && /[\\w)-]\\.(pdf|docx?|txt|rtf)\\b/i.test(box.innerText || '') ? 'attached' : null; }
    const clean = s => String(s || '').replace(/\\s+/g, ' ').trim();
    if (el.getAttribute('role') === 'combobox') { const ctl = el.closest('.select__control') || el.closest('[class*="control"]'); const sv = ctl && ctl.querySelectorAll('[class*="single-value"], [class*="multi-value__label"]'); if (sv && sv.length) return [...sv].map(x => clean(x.innerText)).join(', '); if (ctl) return ''; const own = clean(el.tagName === 'INPUT' ? el.value : el.innerText); return /^(select( an option| one)?\\.{0,3}|search|choose\\.{0,3}|--+|please select)$/i.test(own) ? '' : own; }
    if (el.tagName === 'SELECT') return el.value ? clean(el.options[el.selectedIndex].text) : '';
    if (el.tagName === 'FIELDSET' || el.querySelector) { const boxes = el.querySelectorAll ? [...el.querySelectorAll('input[type=checkbox], input[type=radio]')] : []; if (boxes.length) return boxes.filter(b => b.checked).map(b => { const l = __labelFor(b) || b.closest('label'); if (l && clean(l.innerText)) return clean(l.innerText); const bl = b.getAttribute('aria-labelledby'); const bt = bl ? clean(bl.split(' ').map(i => __byId(b, i)).filter(Boolean).map(x => x.innerText).join(' ')) : ''; return bt || clean(b.getAttribute('aria-label') || b.value); }).join(', '); }
    if (el.type === 'file') { if (el.files && el.files.length) return 'attached'; let n = el; for (let k = 0; k < 6 && n; k++) { n = n.parentElement; if (n && /[\\w)-]\\.(pdf|docx?|txt|rtf)\\b/i.test(n.innerText || '')) return 'attached'; } return ''; }
    return clean(el.value);
  })()`
}

/* Marks the section around file box {key} (its label and the place the file name shows up after an upload). */
function pageMarkBox (key) {
  return `(() => {
    ${AF_DEEP}
    const el = __one('[data-iris-af="${key}"]'); if (!el) return false;
    let n = el; for (let k = 0; k < 4 && n.parentElement; k++) { n = n.parentElement; if ((n.innerText || '').length > 12) break; }
    n.setAttribute('data-iris-afbox', '${key}');
    return true;
  })()`
}

/* Puts {value} into text box {key} the way React notices (its own value setter, then input/change/blur). */
function pageSetText (key, value) {
  return `(() => {
    ${AF_DEEP}
    const el = __one('[data-iris-af="${key}"]'); if (!el) return false;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.focus({ preventScroll: true });
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    try { Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))}); } catch (e) { el.value = ${JSON.stringify(String(value))}; }
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    el.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    return el.value;
  })()`
}

/* Picks option {text} of native select {key}. */
function pageSetSelect (key, text) {
  return `(() => {
    ${AF_DEEP}
    const el = __one('[data-iris-af="${key}"]'); if (!el || el.tagName !== 'SELECT') return false;
    const o = [...el.options].find(o => o.text.replace(/\\s+/g, ' ').trim() === ${JSON.stringify(String(text))}); if (!o) return false;
    el.value = o.value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`
}

/* The form's top, for the agent's check afterwards. */
const PAGE_SCROLL_TOP = `(() => { ${AF_DEEP} const f = __one('[data-iris-af="f1"]'); const t = f && (f.closest('form') || f); if (t) t.scrollIntoView({ block: 'start', behavior: 'instant' }); window.scrollBy({ top: -80, behavior: 'instant' }); return true; })()`

module.exports = {
  AUTOFILL_HOSTS,
  pickYears,
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
  pageMarkBox,
  PAGE_SCROLL_TOP,
  AF_DEEP
}
