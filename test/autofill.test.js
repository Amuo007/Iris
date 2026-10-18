'use strict'

const test = require('node:test')
const assert = require('node:assert')
const af = require('../iris/agent/autofill')

/* the user's real profile shape (values shortened where they do not matter) */
const bank = {
  basics: { name: 'Amrinder Singh', email: 'a@example.com', phone: '(832) 263-4489', location: 'Houston, TX 77084', links: [{ label: 'LinkedIn', url: 'https://www.linkedin.com/in/x/' }, { label: 'GitHub', url: 'https://github.com/x' }, { label: 'Portfolio', url: 'https://x.github.io/portfolio/' }] },
  education: [{ school: 'University of Houston', degree: 'Bachelor of Science, Computer Science', dates: 'Expected December 2026' }],
  experience: [{ title: 'Software Developer', company: 'Geometris (IoT Telematics)' }],
  prefs: { salary: 'Open to negotiation (entry level). If a number is required: the low end.' },
  answers: [
    { label: 'Work authorization', value: 'Yes (F-1 CPT / OPT pending)' },
    { label: 'Needs visa sponsorship', value: 'Yes, in the future' },
    { label: 'Willing to relocate', value: 'Yes' },
    { label: 'Gender', value: 'Male' },
    { label: 'Race / ethnicity', value: 'Asian (Indian)' },
    { label: 'Veteran status', value: 'No' },
    { label: 'Disability status', value: 'No' },
    { label: 'GPA', value: '3.3' }
  ]
}
const info = [{ label: 'Address', value: '17723 quiet loch ln houston TX 77084' }]
const facts = af.buildFacts(bank, info)
const plan = (label, kind, options, extra) => af.planField(Object.assign({ label, kind: kind || 'text', options: options || null, required: true }, extra || {}), facts)

test('every site but LinkedIn; Greenhouse in full, the rest basic', () => {
  assert.strictEqual(af.autofillAllowed('https://job-boards.greenhouse.io/doordashusa/jobs/1').mode, 'full')
  assert.strictEqual(af.autofillAllowed('https://job-boards.greenhouse.io/embed/job_app?for=x&token=1').mode, 'full')
  assert.strictEqual(af.autofillAllowed('https://www.linkedin.com/jobs/view/1').ok, false)
  assert.strictEqual(af.autofillAllowed('https://linkedin.com/jobs/view/1').ok, false)
  assert.match(af.autofillAllowed('https://www.linkedin.com/jobs/view/1').why, /LinkedIn/)
  assert.strictEqual(af.autofillAllowed('https://apply.workable.com/x/j/1/apply').mode, 'basic')
  assert.strictEqual(af.autofillAllowed('https://jobs.lever.co/x/1/apply').mode, 'basic')
  assert.strictEqual(af.autofillAllowed('https://acme.wd5.myworkdayjobs.com/x').mode, 'basic')
  assert.strictEqual(af.autofillAllowed('https://evil.example/greenhouse.io').mode, 'basic')
  assert.strictEqual(af.autofillAllowed('file:///etc/passwd').ok, false)
})

test('basic mode leaves custom dropdowns to the agent', () => {
  assert.strictEqual(af.planField({ label: 'Gender', kind: 'combobox', required: true }, facts, 'basic').do, 'leave')
  assert.strictEqual(af.planField({ label: 'Gender', kind: 'combobox', required: true, aria: true }, facts, 'basic').do, 'choose')
  assert.strictEqual(af.planField({ label: 'First name', kind: 'text', required: true }, facts, 'basic').value, 'Amrinder')
  assert.strictEqual(af.planField({ label: 'Will you need to relocate for this position?', kind: 'radios', options: ['Yes', 'No'], required: true }, facts, 'basic').do, 'leave')
  assert.strictEqual(af.planField({ label: 'Are you willing to relocate?', kind: 'radios', options: ['Yes', 'No'], required: true }, facts, 'basic').option, 'Yes')
  assert.strictEqual(af.planField({ label: 'Have you been previously employed by Sigma Defense, Solute, EWA, JUNO or Sub U?', kind: 'text', required: true }, facts, 'basic').value, 'No')
  assert.strictEqual(af.planField({ label: 'What are your salary requirements?', kind: 'text', required: true }, facts, 'basic').value, 'Open to negotiation (entry level)')
})

test('facts come from the profile, the address from My info', () => {
  assert.strictEqual(facts.firstName, 'Amrinder')
  assert.strictEqual(facts.lastName, 'Singh')
  assert.strictEqual(facts.street, '17723 Quiet Loch Ln')
  assert.strictEqual(facts.city, 'Houston')
  assert.strictEqual(facts.state, 'Texas')
  assert.strictEqual(facts.zip, '77084')
  assert.strictEqual(facts.company, 'Geometris')
  assert.strictEqual(facts.major, 'Computer Science')
  assert.strictEqual(facts.gradMonth, 'December')
  assert.strictEqual(facts.gradYear, '2026')
  assert.strictEqual(facts.degreeDone, false)
  assert.strictEqual(facts.visaStatus, 'F-1')
})

test('contact boxes', () => {
  assert.deepStrictEqual(plan('First Name'), { do: 'text', value: 'Amrinder' })
  assert.deepStrictEqual(plan('Preferred First Name'), { do: 'text', value: 'Amrinder' })
  assert.deepStrictEqual(plan('Last Name'), { do: 'text', value: 'Singh' })
  assert.deepStrictEqual(plan('Please provide your full legal name as it appears on your government ID'), { do: 'text', value: 'Amrinder Singh' })
  assert.deepStrictEqual(plan('Email'), { do: 'text', value: 'a@example.com' })
  assert.deepStrictEqual(plan('Phone'), { do: 'text', value: '(832) 263-4489' })
  assert.deepStrictEqual(plan('LinkedIn Profile'), { do: 'text', value: 'https://www.linkedin.com/in/x/' })
  assert.deepStrictEqual(plan('Website'), { do: 'text', value: 'https://x.github.io/portfolio/' })
  assert.deepStrictEqual(plan('Current Company'), { do: 'text', value: 'Geometris' })
  assert.strictEqual(plan('Referrer email').do, 'leave')
  assert.strictEqual(plan('School name').do !== 'text' || plan('School name').value !== 'Amrinder Singh', true)
})

test('a filled box is left alone unless a sure fact differs; essays and number boxes go to the agent', () => {
  assert.strictEqual(plan('First Name', 'text', null, { value: 'Amrinder' }).do, 'leave')
  assert.strictEqual(plan('Phone', 'text', null, { value: '8322634489' }).do, 'leave')
  assert.deepStrictEqual(plan('City', 'text', null, { value: 'Katy' }), { do: 'text', value: 'Houston', replace: 'Katy' })
  assert.deepStrictEqual(plan('Zip Code', 'text', null, { value: '77449' }), { do: 'text', value: '77084', replace: '77449' })
  assert.strictEqual(plan('Current Company', 'text', null, { value: 'Acme' }).do, 'leave')
  assert.strictEqual(plan('Why do you want to work here?', 'textarea').do, 'leave')
  assert.strictEqual(plan('Expected salary', 'text', null, { inputType: 'number' }).do, 'leave')
  assert.deepStrictEqual(plan('End date year', 'text', null, { inputType: 'number' }), { do: 'text', value: '2026' })
})

test('dropdowns with known options pick by meaning', () => {
  assert.strictEqual(plan('Country', 'select', ['Afghanistan +93', 'United States Minor Outlying Islands', 'United States +1']).option, 'United States +1')
  assert.strictEqual(plan('Have you worked at DoorDash?', 'select', ['I am a previous employee', 'I am a previous DoorDash Dasher', 'I have not worked at DoorDash']).option, 'I have not worked at DoorDash')
  assert.strictEqual(plan('Have you ever worked for Robinhood as an employee, intern or contractor?', 'select', ['Yes', 'I have never worked at Robinhood']).option, 'I have never worked at Robinhood')
  assert.strictEqual(plan('What is your gender identity?', 'select', ['Cisgender woman', 'Cisgender man', 'Transgender man']).option, 'Cisgender man')
  assert.strictEqual(plan('Gender', 'select', ['Female', 'Male', 'Decline to self-identify']).option, 'Male')
  assert.strictEqual(plan('What is your race or ethnicity?', 'select', ['East Asian', 'South Asian', 'White']).option, 'South Asian')
  assert.strictEqual(plan('Race', 'select', ['Hispanic or Latino', 'Asian (Not Hispanic or Latino)', 'Two or More Races']).option, 'Asian (Not Hispanic or Latino)')
  assert.strictEqual(plan('What is your military status?', 'select', ['I am on active duty', 'I have never served in the military', 'I identify as a protected veteran']).option, 'I have never served in the military')
  assert.strictEqual(plan('Veteran Status', 'select', ['I am a veteran', 'I am not a protected veteran', 'I identify as one or more of the classifications of protected veteran']).option, 'I am not a protected veteran')
  assert.strictEqual(plan('Have you served in the U.S. Armed Forces?', 'select', ['Yes', 'No']).option, 'No')
  // "military service" in a list inside some other question is not the veteran question
  assert.strictEqual(plan('Did you provide completed information for all previous employers, during at least the last 84 months, including self-employment, military service, summer, and part-time jobs.', 'radios', ['YES', 'NO']).do, 'leave')
  assert.strictEqual(plan('Were you ever employed by TMEIC (including previous company names), Toshiba, Mitsubishi, or affiliated business?', 'select', ['Yes', 'No']).option, 'No')
  assert.strictEqual(plan('Disability Status', 'select', ['Yes, I have a disability', "No, I don't have a disability", "I don't wish to answer"]).option, "No, I don't have a disability")
  assert.strictEqual(plan('Are you Hispanic/Latino?', 'select', ['Yes', 'No', 'Decline']).option, 'No')
  assert.strictEqual(plan('How did you hear about this job?', 'select', ['LinkedIn', 'Employee Referral', 'Company Website', 'Other']).option, 'Company Website')
  assert.strictEqual(plan('How did you hear about this job?', 'select', ['LinkedIn', 'Job Board', 'Company Website', 'Other']).option, 'Job Board')
  assert.deepStrictEqual(plan('How did you hear about this job?', 'text'), { do: 'text', value: 'Job board' })
  assert.deepStrictEqual(plan('Who is your current (or most recent) employer?'), { do: 'text', value: 'Geometris' })
  assert.deepStrictEqual(plan('What is your current (or most recent) title?'), { do: 'text', value: 'Software Developer' })
  assert.strictEqual(plan('How did you learn about Optiver?', 'select', ['LinkedIn', 'Referral', 'Other']).option, 'Other')
  assert.strictEqual(plan('Degree', 'select', ["Associate's Degree", "Bachelor's Degree", "Master's Degree"]).option, "Bachelor's Degree")
  assert.strictEqual(plan('What is the highest level of education you have completed?', 'select', ['High School Diploma/GED', "Bachelor's Degree"]).option, 'High School Diploma/GED')
})

test('sponsorship: future yes; "now" decided by the question\'s own list', () => {
  const yn = ['Yes', 'No']
  assert.strictEqual(plan('Will you now or in the future require sponsorship for employment visa status?', 'select', yn).option, 'Yes')
  assert.strictEqual(plan('Will you in the future require immigration sponsorship by our company?', 'select', yn).option, 'Yes')
  assert.strictEqual(plan('Will you now require immigration sponsorship (e.g., H-1B, E-3, TN, O-1, STEM OPT)?', 'select', yn).option, 'Yes')
  assert.strictEqual(plan('Do you currently require employer sponsorship for United States work authorization? (F-1 CPT/OPT, J-1, TN, H1-B, O-1, etc)', 'select', yn).option, 'Yes')
  assert.strictEqual(plan('Do you currently require sponsorship?', 'select', yn).option, 'No')
  assert.strictEqual(plan('Are you legally authorized to work in the United States?', 'select', yn).option, 'Yes')
  // long option lists are read by the agent
  assert.strictEqual(plan('Work Authorization', 'select', ['I am authorized to work in the US for any employer', 'I am authorized to work in the US for my present employer only']).do, 'leave')
})

test('saved self-ID answers are said plainly, never "decline"', () => {
  const f2 = af.buildFacts(Object.assign({}, bank, { answers: bank.answers.concat([{ label: 'Transgender', value: 'No (I do not identify as transgender)' }, { label: 'Pronouns', value: 'He/Him' }]) }), info)
  const p2 = (label, kind, options, extra) => af.planField(Object.assign({ label, kind: kind || 'text', options: options || null, required: true }, extra || {}), f2)
  assert.strictEqual(p2('Do you identify as transgender?', 'select', ['Yes', 'No', "I don't wish to answer"]).option, 'No')
  assert.strictEqual(p2('Do you identify as transgender?', 'select', ['Yes', 'No', "I don't wish to answer"], { required: false }).option, 'No')
  assert.strictEqual(p2('Pronouns', 'select', ['She/Her', 'He/Him', 'They/Them', 'Decline']).option, 'He/Him')
  assert.strictEqual(p2('Pronouns', 'text').value, 'He/Him')
  assert.strictEqual(p2('What is your sexual orientation?', 'select', ['Heterosexual', 'Gay', 'Decline to self-identify'], { required: false }).do, 'leave')
})

test('SMS / WhatsApp opt-ins: no — even when the question mentions email', () => {
  assert.strictEqual(plan('Would you like to receive communications via SMS and/or WhatsApp to the number provided?', 'select', ['Yes', 'No']).option, 'No')
  const long = 'Would you like to receive communications via SMS and/or WhatsApp to the number provided [above or during the application process] about your application process? Message & data rates may apply and message frequency may vary. If you select no, we will only communicate with you via email and/or telephone calls.'
  assert.strictEqual(plan(long, 'select', ['Yes', 'No']).option, 'No')
  assert.strictEqual(plan(long, 'combobox').do, 'choose')
  assert.strictEqual(plan('Yes - I consent to receiving text messages', 'radios', ['Yes - I consent to receiving text messages', 'No - I do not consent to receiving text messages']).option, 'No - I do not consent to receiving text messages')
  assert.strictEqual(plan('How did you hear about us? (LinkedIn, a friend, our website …)', 'select', ['LinkedIn', 'Company website', 'Other']).option, 'Company website')
  assert.deepStrictEqual(plan('Email address'), { do: 'text', value: 'a@example.com' })
  assert.deepStrictEqual(plan('Confirm your email*'), { do: 'text', value: 'a@example.com' })
  assert.deepStrictEqual(plan('LinkedIn Profile URL'), { do: 'text', value: 'https://www.linkedin.com/in/x/' })
})

test('privacy notices are acknowledged; agreements are left to the agent', () => {
  assert.strictEqual(plan('Applicant Privacy Acknowledgement', 'select', ['Yes', 'No']).option, 'Yes')
  assert.strictEqual(plan('Please review and acknowledge our Candidate Privacy Policy linked below:', 'select', ['I acknowledge']).option, 'I acknowledge')
  assert.strictEqual(plan('By agreeing here I acknowledge the mutual Applicant Arbitration Agreement and the privacy notice', 'select', ['Yes', 'No']).do, 'leave')
})

test('common questions that follow from the profile', () => {
  const f3 = af.buildFacts(Object.assign({}, bank, { answers: bank.answers.concat([{ label: 'Years of experience', value: '1 year' }, { label: 'Earliest start date', value: 'December 21, 2026 (subject to OPT approval)' }]) }), info)
  const p3 = (label, kind, options) => af.planField({ label, kind: kind || 'text', options: options || null, required: true }, f3)
  assert.strictEqual(p3('Are you able to work onsite 3 days a week?', 'select', ['Yes', 'No']).option, 'Yes')
  assert.strictEqual(p3('Are you comfortable working in-office five days a week?', 'select', ['Yes', 'No']).option, 'Yes')
  assert.deepStrictEqual(p3('Earliest start date'), { do: 'text', value: 'December 21, 2026' })
  assert.deepStrictEqual(af.planField({ label: 'Available to Start', kind: 'text', placeholder: 'MM/DD/YYYY', required: true }, f3), { do: 'text', value: '12/21/2026' })
  assert.deepStrictEqual(af.planField({ label: 'Start date', kind: 'text', inputType: 'date', required: true }, f3), { do: 'text', value: '2026-12-21' })
  assert.strictEqual(p3('How many years of software engineering industry experience do you have (excluding internships)?', 'select', ['Less than 2 years', '2-5 years', '5+ years']).option, 'Less than 2 years')
  assert.strictEqual(p3('Years of experience', 'select', ['0', '1-3', '3-5', '5+']).option, '1-3')
  assert.strictEqual(p3('Do you hold an active security clearance?', 'select', ['Yes', 'No']).option, 'No')
  assert.strictEqual(p3('Are you a U.S. citizen?', 'select', ['Yes', 'No']).option, 'No')
  assert.strictEqual(p3('Are you a U.S. citizen or permanent resident?', 'select', ['Yes', 'No']).do, 'leave')
  assert.strictEqual(p3('Are you a citizen of the United States? (Non-Citizens will not be eligible to move forward in the hiring process.)', 'radios', ['YES', 'NO']).option, 'NO')
  assert.strictEqual(p3('Are you a US citizen? If not, please explain your status.', 'select', ['Yes', 'No']).option, 'No')
  assert.strictEqual(p3('Are you a citizen of the United States or a green card holder?', 'radios', ['Yes', 'No']).do, 'leave')
  assert.strictEqual(p3('Do you have 3+ years of professional experience?', 'select', ['Yes', 'No']).option, 'No')
  assert.strictEqual(p3('Do you have 3+ years of experience in ETL orchestration?', 'select', ['Yes', 'No']).option, 'No')
  assert.strictEqual(p3('Do you have 1+ years of experience with Python?', 'select', ['Yes', 'No']).do, 'leave')
  assert.strictEqual(af.pickYears(['None', 'Under 1 year', '1+ years'], 1), 2)
  assert.strictEqual(af.pickYears(['0–1 years', '1–2 years'], 1), 0)
})

test('unknown and optional self-ID questions are left to the agent', () => {
  assert.strictEqual(plan('Do you identify as transgender?', 'select', ['Yes', 'No', 'I don\'t wish to answer'], { required: false }).do, 'leave')
  assert.strictEqual(plan('Do you identify as transgender?', 'select', ['Yes', 'No', 'I don\'t wish to answer']).option, 'I don\'t wish to answer')
  assert.strictEqual(plan('Are you located in the greater Seattle area?', 'select', ['Yes', 'No']).do, 'leave')
  assert.strictEqual(plan('Have you previously applied to Point72?', 'select', ['Yes', 'No']).do, 'leave')
  assert.strictEqual(plan('Start date month', 'select', ['January']).do, 'leave')
})

test('react-select boxes with options not yet known keep the patterns', () => {
  const p = plan('Gender', 'combobox')
  assert.strictEqual(p.do, 'choose')
  assert.strictEqual(af.pickOption(['Female', 'Male'], p.patterns, p.avoid), 1)
  const school = plan('School', 'combobox')
  assert.strictEqual(school.search, 'University of Houston')
  const city = plan('Location (City)', 'combobox')
  assert.strictEqual(city.search, 'Houston, Texas')
  assert.strictEqual(af.pickOption(['North Houston, Texas, United States', 'Houston, Texas, United States'], [/^Houston, Texas, United States$/i, /^Houston, Texas/i]), 1)
})

test('the resume goes in the resume box only', () => {
  assert.deepStrictEqual(plan('Resume/CV', 'file', null, { id: 'resume' }), { do: 'upload', file: 'resume' })
  assert.strictEqual(plan('Cover Letter', 'file', null, { id: 'cover_letter' }).do, 'leave')
  assert.strictEqual(plan('Resume/CV', 'file', null, { id: 'resume', value: 'resume.pdf' }).do, 'leave')
  assert.strictEqual(plan('Resume import (the site autofill)', 'file', null, { id: 'spl-dropzone-file-input-2' }).do, 'leave')
})

test('a ticked box shows on its own input or on the styled wrapper around it', () => {
  const on = new Function(af.AF_DEEP + ' return __on')()
  const node = (attrs, parent) => ({ parentElement: parent || null, getAttribute: k => (attrs && k in attrs) ? attrs[k] : null })
  const box = (checked, parent) => ({ checked, parentElement: parent })
  assert.strictEqual(on(box(true, node({}))), true)
  assert.strictEqual(on(box(false, node({}, node({})))), false)
  // input > label > div[role=radio aria-checked]: the site keeps the input itself unticked
  assert.strictEqual(on(box(false, node({}, node({ role: 'radio', 'aria-checked': 'true' })))), true)
  assert.strictEqual(on(box(false, node({}, node({ role: 'radio', 'aria-checked': 'false' }, node({ 'aria-checked': 'true' }))))), false)
  assert.strictEqual(on(box(false, node({ 'aria-pressed': 'true' }))), true)
  // only the box's own wrapper counts, not some far-off ancestor
  assert.strictEqual(on(box(false, node({}, node({}, node({}, node({ 'aria-checked': 'true' })))))), false)
})

test('home address and contact facts go in the applicant\'s own section only', () => {
  assert.deepStrictEqual(plan('City', 'text', null, { section: 'Information' }), { do: 'text', value: 'Houston' })
  assert.strictEqual(plan('City', 'text', null, { section: 'Work History 1' }).do, 'leave')
  assert.strictEqual(plan('Zip Code', 'text', null, { section: 'Work History 1' }).do, 'leave')
  assert.strictEqual(plan('State', 'text', null, { section: 'Education History 1' }).do, 'leave')
  assert.strictEqual(plan('Phone', 'text', null, { section: 'References' }).do, 'leave')
  assert.strictEqual(plan('First name', 'text', null, { section: 'Emergency Contact' }).do, 'leave')
  // a filled employer city is not "put right" to the home city either
  assert.strictEqual(plan('City', 'text', null, { section: 'Employment History', value: 'Austin' }).do, 'leave')
  // a job title that happens to say "Experience" is not a work-history block
  assert.deepStrictEqual(plan('City', 'text', null, { section: 'Developer Experience Engineer' }), { do: 'text', value: 'Houston' })
  // school and employer questions still fill inside their own sections
  assert.strictEqual(plan('School Name', 'text', null, { section: 'Education History 1' }).value, 'University of Houston')
})

test('school type and graduated questions', () => {
  assert.strictEqual(plan('School Type (required)', 'select', ['Unspecified', 'High School', 'Community College', 'Vocational', 'College/University', 'Graduate School']).option, 'College/University')
  assert.strictEqual(plan('Did you Graduate? (required)', 'select', ['Yes', 'No']).option, 'No')
})

test('a first address line beside City/State/Zip takes the street; one Address box takes it all', () => {
  assert.deepStrictEqual(plan('Address Line 1', 'text'), { do: 'text', value: '17723 Quiet Loch Ln' })
  assert.deepStrictEqual(plan('Street address', 'text'), { do: 'text', value: '17723 Quiet Loch Ln' })
  assert.deepStrictEqual(plan('Address', 'text'), { do: 'text', value: '17723 Quiet Loch Ln, Houston, TX 77084' })
  assert.strictEqual(plan('Address Line 2(optional)', 'text').do, 'leave')
})

test('a City box that searches as you type looks up the home city', () => {
  const p = plan('City', 'combobox', null, { aria: true })
  assert.strictEqual(p.do, 'choose')
  assert.strictEqual(p.search, 'Houston')
  assert.strictEqual(p.place, true)
  assert.deepStrictEqual(plan('City', 'text'), { do: 'text', value: 'Houston' })
})

test('a lone required privacy box is ticked; optional and talent-community boxes are not', () => {
  const t1 = 'I have read and agree to the privacy notice of North Star Staffing Solutions.'
  assert.deepStrictEqual(af.planField({ label: t1, kind: 'checkboxes', options: [t1], required: true }, facts).option, t1)
  assert.strictEqual(af.planField({ label: t1, kind: 'checkboxes', options: [t1], required: false }, facts).do, 'leave')
  const t2 = 'You declare that you have read and agree to the privacy notice of Anton Paar and agree to be part of communities for future career opportunities.'
  assert.strictEqual(af.planField({ label: t2, kind: 'checkboxes', options: [t2], required: true }, facts).do, 'leave')
})

test('an option drawn as a web component is read from its own shadow root', () => {
  const text = new Function(af.AF_DEEP + ' return __text')()
  const el = (o) => Object.assign({ innerText: '', textContent: '', getAttribute: () => null, shadowRoot: null }, o)
  assert.strictEqual(text(el({ innerText: ' Houston,  TX ' })), 'Houston, TX')
  assert.strictEqual(text(el({ getAttribute: k => k === 'aria-label' ? 'Houston, TX, US' : null })), 'Houston, TX, US')
  const leaf = (tagName, textContent) => ({ tagName, textContent, children: [] })
  assert.strictEqual(text(el({ shadowRoot: { querySelectorAll: () => [leaf('STYLE', '.x{color:red}'), leaf('SPAN', 'Houston, TX, US')] } })), 'Houston, TX, US')
})

test('a "--" placeholder does not make a Yes/No list "more than yes/no"; a State list can be typed into', () => {
  assert.strictEqual(plan('Did you Graduate? (required)', 'select', ['--', 'Yes', 'No']).option, 'No')
  assert.strictEqual(af.isPlaceholderOption('--'), true)
  assert.strictEqual(af.isPlaceholderOption('Select...'), true)
  assert.strictEqual(af.isPlaceholderOption('No'), false)
  const st = plan('State', 'combobox', null, { aria: true, section: 'Information' })
  assert.strictEqual(st.do, 'choose')
  assert.strictEqual(st.typeAhead, 'TX')
  assert.strictEqual(af.pickOption(['TN', 'TX', 'UT'], st.patterns), 1)
})

test('Smart look-ups and questions are read from tool-call markup and repeated JSON', () => {
  const L = require('../iris/agent/lookup')
  const P = require('../iris/agent/prompts')
  const wrapped = '<tool_call>\n{"lookups":[{"kind":"jobs","query":"software engineer new grad"}]}\n</parameter>\n<parameter=arguments>\n{"lookups":[{"kind":"jobs","query":"software engineer new grad"}]}\n</parameter>\n</function>\n</tool_call>'
  assert.deepStrictEqual(L.parseLookups(wrapped, 4), [{ kind: 'jobs', query: 'software engineer new grad' }])
  assert.strictEqual(L.parseLookups('Plan: open Greenhouse {not json} and apply'), null)
  const q = P.parseQuestions('<tool_call>{"questions":[{"q":"Which city?","options":["Houston","Remote"]}]}</tool_call>{"questions":[]}')
  assert.strictEqual(q[0].q, 'Which city?')
})

test('job look-ups keep US postings only', () => {
  const L = require('../iris/agent/lookup')
  for (const loc of ['New York, NY', 'US-VA-Arlington', 'Remote - US', 'Houston, TX', 'Sunnyvale, California']) assert.strictEqual(L.isUSLocation(loc), true, loc)
  for (const loc of ['Istanbul', '', 'London, United Kingdom', 'Toronto, ON', 'Bangalore, India', 'Tbilisi, Georgia']) assert.strictEqual(L.isUSLocation(loc), false, loc)
  assert.deepStrictEqual(L.filterBoardJobs([{ title: 'SWE New Grad', team: '', location: 'Istanbul' }, { title: 'SWE New Grad', team: '', location: 'Austin, TX' }], [], 5).map(j => j.location), ['Austin, TX'])
})

test('a graduation month-and-year question is answered even in a large text box', () => {
  assert.deepStrictEqual(plan('When will you graduate? (month & year) ✱', 'textarea'), { do: 'text', value: 'December 2026' })
  assert.strictEqual(plan('Why do you want to work here?', 'textarea').do, 'leave')
})
