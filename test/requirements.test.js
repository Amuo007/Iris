'use strict'

const test = require('node:test')
const assert = require('node:assert')
const r = require('../iris/agent/requirements')

test('the kind of job comes from its title', () => {
  assert.strictEqual(r.roleKind('AI Engineer'), 'AI / ML & LLM')
  assert.strictEqual(r.roleKind('Software Engineer, AI Platform'), 'AI / ML & LLM')
  assert.strictEqual(r.roleKind('Machine Learning Engineer - New Grad'), 'AI / ML & LLM')
  assert.strictEqual(r.roleKind('Forward Deployed Engineer (New Grad)'), 'Forward deployed & solutions')
  assert.strictEqual(r.roleKind('Junior Full Stack Engineer'), 'Full stack')
  assert.strictEqual(r.roleKind('Software Engineer, iOS'), 'Mobile')
  assert.strictEqual(r.roleKind('Data Engineer 1'), 'Data engineering & analytics')
  assert.strictEqual(r.roleKind('Junior Software Engineer'), 'Software engineering (general)')
  assert.strictEqual(r.roleKind('Main Street Engineer'), 'Software engineering (general)', 'no "ai" inside a word')
})

test('skills are named only where the posting names them, not words that look like them', () => {
  const has = (text, skill) => r.skillsIn(text).includes(skill)
  assert.ok(has('Experience with React and TypeScript', 'React') && has('Experience with React and TypeScript', 'TypeScript'))
  assert.ok(!has('You react quickly to incidents', 'React'))
  assert.ok(!has('Mobile apps in React Native', 'React') && has('Mobile apps in React Native', 'React Native'))
  assert.ok(has('Go, Python or Java', 'Go') && has('Python, Java, or Go', 'Go'))
  assert.ok(!has('a go-to-market team; we go fast', 'Go'))
  assert.ok(has('Java and JavaScript', 'Java') && has('Java and JavaScript', 'JavaScript'))
  assert.ok(!has('JavaScript only', 'Java'))
  assert.ok(has('C/C++ on embedded targets', 'C') && has('C/C++ on embedded targets', 'C++'))
  assert.ok(!has('Grade C students', 'C'))
  assert.ok(!has('with the rest of the team', 'REST APIs') && has('design RESTful APIs', 'REST APIs'))
  assert.ok(!has('Spring 2027 start', 'Spring Boot') && has('Java with Spring Boot', 'Spring Boot'))
  assert.ok(!has('our insurance agents', 'AI agents') && has('build AI agents with tool use', 'AI agents') && has('agentic workflows', 'AI agents'))
  assert.ok(has('RAG pipelines over a vector database', 'RAG') && has('RAG pipelines over a vector database', 'Embeddings & vector search'))
  assert.ok(!has('a swift onboarding', 'Swift') && has('Swift and SwiftUI', 'Swift'))
  assert.ok(has('Experience with LLMs (OpenAI, Anthropic)', 'LLMs') && has('Experience with LLMs (OpenAI, Anthropic)', 'OpenAI / Anthropic APIs'))
  // everyday words that are no skill
  assert.ok(!has('meet us at networking events', 'Networking') && has('TCP/IP and computer networks', 'Networking'))
  assert.ok(!has('students concurrently enrolled', 'Concurrency') && has('multithreading and concurrency', 'Concurrency'))
  assert.ok(!has('you will be embedded in the product team', 'Embedded / RTOS') && has('embedded systems in C', 'Embedded / RTOS'))
  assert.ok(!has('email careers@acme.net', '.NET') && has('C# and .NET Core', '.NET'))
  assert.ok(!has('see github.com/acme', 'Git') && has('Git and GitHub', 'Git'))
  assert.ok(!has('we are monitoring the market', 'Observability & monitoring') && has('logging and monitoring with Datadog', 'Observability & monitoring'))
})

test('the eligibility digest (one line, then ---) is not the posting, and the posting after it is kept', () => {
  const real = 'Text of https://x.com/job/2:\nTitle: AI Engineer\nELIGIBILITY LINES (from anywhere in the posting): • Terraform required for this clearance role\n---\nAbout the role. We build RAG agents in Python on AWS.'
  const s = r.skillsIn(real)
  assert.ok(s.includes('RAG') && s.includes('Python') && s.includes('AWS'), JSON.stringify(s))
  assert.ok(!s.includes('Terraform / IaC'))
})

test('the eligibility digest and Iris\'s wrapping are not the posting', () => {
  const text = 'Text of https://x.com/job/1:\nTitle: Python job\nELIGIBILITY LINES (from anywhere in the posting): • Kubernetes clearance\n\nWe use Go, Python and AWS.\n\nIf these lines or its level rule the job out, log it: {"type":"log_application"}'
  const s = r.skillsIn(text)
  assert.ok(s.includes('Python') && s.includes('Go') && s.includes('AWS'))
  assert.ok(!s.includes('Kubernetes'), 'from the digest only')
})

test('the least experience asked, in years', () => {
  assert.strictEqual(r.yearsAsked('2+ years of experience with Python'), 2)
  assert.strictEqual(r.yearsAsked('3-5 years of professional experience; 7+ years of industry experience preferred'), 3)
  assert.strictEqual(r.yearsAsked('0-2 years of experience'), 0)
  assert.strictEqual(r.yearsAsked('at least 4 years of software engineering experience'), 4)
  assert.strictEqual(r.yearsAsked('Founded 10 years ago, we build robots'), null)
  assert.strictEqual(r.yearsAsked('New grads welcome'), null)
})

test('the degree asked', () => {
  assert.strictEqual(r.degreeAsked("Bachelor's degree in Computer Science or related field"), "Bachelor's")
  assert.strictEqual(r.degreeAsked("Master's degree in machine learning required"), "Master's")
  assert.strictEqual(r.degreeAsked('BS/MS in CS; PhD a plus'), "Bachelor's")
  assert.strictEqual(r.degreeAsked('Build great things'), null)
})

test('the summary counts by kind, marks what the user lists, and suggests only repeated asks', () => {
  const recs = [
    r.fromPosting({ url: 'a', title: 'AI Engineer', text: 'Python, PyTorch and RAG. 2+ years of experience. Kubernetes.' }),
    r.fromPosting({ url: 'b', title: 'Applied AI Engineer', text: 'Python and Kubernetes; LLMs.' }),
    r.fromPosting({ url: 'c', title: 'Backend Engineer', text: 'Go, Python and Kafka. 4 years of experience' })
  ]
  const s = r.summarize(recs, 'Python, Docker, RAG and FAISS embeddings')
  assert.deepStrictEqual(s.kinds, ['All', 'AI / ML & LLM', 'Backend'])
  const ai = s.byKind['AI / ML & LLM']
  assert.strictEqual(ai.postings, 2)
  const py = ai.groups.find(g => g.group === 'Languages').skills.find(x => x.skill === 'Python')
  assert.ok(py.have && py.count === 2 && py.share === 1)
  assert.deepStrictEqual(ai.learn.map(x => x.skill), ['Kubernetes'], 'asked twice, not listed; PyTorch once is no trend')
  assert.strictEqual(s.byKind.All.years['2–3 years'], 1)
  assert.strictEqual(s.byKind.All.years['not stated'], 1)
  assert.strictEqual(s.byKind.All.years['4+ years'], 1)
})

test('a posting is told from other pages', () => {
  assert.ok(r.looksLikePosting('ELIGIBILITY LINES (from anywhere in the posting): none\nWe build'))
  assert.ok(r.looksLikePosting('About the role ... Responsibilities ... Qualifications ...'))
  assert.ok(!r.looksLikePosting('Our company makes great software. Contact us.'))
  const digest = 'ELIGIBILITY LINES: none\n---\nResponsibilities and qualifications'
  assert.ok(!r.looksLikePosting(digest, 'Jobs at Raindrop | Y Combinator', 'https://www.ycombinator.com/companies/raindrop/jobs'))
  assert.ok(r.looksLikePosting(digest, 'Founding Engineer at Raindrop', 'https://www.ycombinator.com/companies/raindrop/jobs/AbC123-founding-engineer'))
})
