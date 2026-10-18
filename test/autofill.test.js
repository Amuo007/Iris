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

test('only Greenhouse forms, never LinkedIn', () => {
  assert.strictEqual(af.autofillAllowed('https://job-boards.greenhouse.io/doordashusa/jobs/1').ok, true)
  assert.strictEqual(af.autofillAllowed('https://job-boards.greenhouse.io/embed/job_app?for=x&token=1').ok, true)
  assert.strictEqual(af.autofillAllowed('https://www.linkedin.com/jobs/view/1').ok, false)
  assert.match(af.autofillAllowed('https://www.linkedin.com/jobs/view/1').why, /LinkedIn/)
  assert.strictEqual(af.autofillAllowed('https://jobs.lever.co/x/1/apply').ok, false)
  assert.strictEqual(af.autofillAllowed('https://evil.example/greenhouse.io').ok, false)
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

test('a filled box is left alone; essays and number boxes go to the agent', () => {
  assert.strictEqual(plan('First Name', 'text', null, { value: 'Amrinder' }).do, 'leave')
  assert.strictEqual(plan('Why do you want to work here?', 'textarea').do, 'leave')
  assert.strictEqual(plan('Expected salary', 'text', null, { inputType: 'number' }).do, 'leave')
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
  assert.strictEqual(plan('Disability Status', 'select', ['Yes, I have a disability', "No, I don't have a disability", "I don't wish to answer"]).option, "No, I don't have a disability")
  assert.strictEqual(plan('Are you Hispanic/Latino?', 'select', ['Yes', 'No', 'Decline']).option, 'No')
  assert.strictEqual(plan('How did you hear about this job?', 'select', ['LinkedIn', 'Employee Referral', 'Company Website', 'Other']).option, 'Company Website')
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

test('unknown and optional self-ID questions are left to the agent', () => {
  assert.strictEqual(plan('Do you identify as transgender?', 'select', ['Yes', 'No', 'I don\'t wish to answer'], { required: false }).do, 'leave')
  assert.strictEqual(plan('Do you identify as transgender?', 'select', ['Yes', 'No', 'I don\'t wish to answer']).option, 'I don\'t wish to answer')
  assert.strictEqual(plan('Are you located in the greater Seattle area?', 'select', ['Yes', 'No']).do, 'leave')
  assert.strictEqual(plan('Have you previously applied to Point72?', 'select', ['Yes', 'No']).do, 'leave')
  assert.strictEqual(plan('Applicant Privacy Acknowledgement', 'select', ['Yes']).do, 'leave')
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
})
