'use strict'

/*
 * What job postings ask for, gathered for the user to learn from (Settings → What jobs ask for): the technologies and
 * asks each posting names, matched against a fixed list — nothing is made up or rephrased by a model — grouped by the
 * kind of job (from its title) and counted across postings. It runs on the posting text Iris already reads for
 * eligibility, with no model call, so applying is not slowed.
 */

/* the kind of job, from its title: the first that matches (an "AI Software Engineer" is an AI job) */
const ROLE_KINDS = [
  ['AI / ML & LLM', /\b(ai|a\.i\.|ml|machine learning|llms?|genai|generative|deep learning|nlp|computer vision|perception|data scien\w*|applied scien\w*|research engineer|mlops|prompt)\b/i],
  ['Forward deployed & solutions', /\b(forward[- ]deployed|fde|solutions? engineer|implementation engineer|customer engineer|sales engineer|integration engineer)\b/i],
  ['Mobile', /\b(ios|android|mobile)\b/i],
  ['Frontend', /\b(front[- ]?end|ui engineer|ui developer|web developer|ux engineer)\b/i],
  ['Full stack', /\b(full[- ]?stack|fullstack|product engineer)\b/i],
  ['Data engineering & analytics', /\b(data engineer\w*|analytics engineer|data analyst|etl|bi developer|business intelligence|sql developer)\b/i],
  ['Cloud, DevOps & SRE', /\b(devops|sre|site reliability|cloud engineer|infrastructure engineer|platform reliability)\b/i],
  ['Backend', /\b(back[- ]?end|api engineer|platform engineer|distributed systems)\b/i],
  ['Embedded & systems', /\b(embedded|firmware|systems software|kernel|robotics|autonomy|fpga|hardware)\b/i],
  ['Security', /\b(security|cyber\w*)\b/i],
  ['Quant & trading', /\b(quant\w*|trading|trader)\b/i]
]
const GENERAL_KIND = 'Software engineering (general)'

/* [group, [[label, pattern], …]] — a pattern without the i flag is case-sensitive on purpose ("React" is the library,
   "react" the verb; "Go" the language, "go" the word) */
const SKILL_GROUPS = [
  ['Languages', [
    ['Python', /\bpython\b/i],
    ['Java', /\bjava\b(?!\s*script)/i],
    ['JavaScript', /\bjava\s?script\b/i],
    ['TypeScript', /\btypescript\b/i],
    ['C++', /c\+\+/i],
    ['C', /(?<![\w+#.])C(?=\s*(?:\/|,|\band\b|\bor\b)\s*(?:C\+\+|C#|(?:Python|Java|Rust|Go)\b))|(?<=(?:C\+\+|Python|Java|Rust),?\s(?:and |or )?)C\b(?![+#])/],
    ['C#', /(^|[^\w])c#/i],
    ['Go', /\bgolang\b|\bGo\b(?=\s*(?:,|\/|and|or)\s*(?:Python|Java|Rust|C\+\+|Kotlin|Scala|TypeScript|Node))|(?<=(?:Python|Java|Rust|C\+\+|Kotlin|Scala|TypeScript),?\s(?:and |or )?)Go\b/],
    ['Rust', /\bRust\b/],
    ['Kotlin', /\bkotlin\b/i],
    ['Swift', /\bSwift\b/],
    ['Scala', /\bscala\b/i],
    ['Ruby', /\bruby\b/i],
    ['SQL', /\bsql\b/i],
    ['Bash / shell', /\bbash\b|\bshell script/i]
  ]],
  ['AI / ML & LLM', [
    ['LLMs', /\bllms?\b|large language models?/i],
    ['RAG', /\bRAG\b|retrieval[- ]augmented/i],
    ['AI agents', /\b(ai|llm|autonomous) agents?\b|\bagentic\b|multi-agent/i],
    ['Prompt engineering', /prompt (engineering|design)/i],
    ['Fine-tuning', /fine[- ]?tun/i],
    ['Embeddings & vector search', /\bembeddings?\b|vector (db|database|search|store)s?|pinecone|weaviate|\bfaiss\b|pgvector|milvus/i],
    ['LangChain / LlamaIndex', /langchain|llamaindex|llama index|langgraph/i],
    ['OpenAI / Anthropic APIs', /\bopenai\b|\banthropic\b|\bclaude\b|\bgpt-?\d|chatgpt/i],
    ['Hugging Face', /hugging ?face/i],
    ['PyTorch', /pytorch/i],
    ['TensorFlow / Keras', /tensorflow|\bkeras\b/i],
    ['scikit-learn', /scikit|sklearn/i],
    ['NLP', /\bnlp\b|natural language processing/i],
    ['Computer vision', /computer vision|\bopencv\b/i],
    ['Reinforcement learning', /reinforcement learning|\brlhf\b/i],
    ['Model evaluation (evals)', /\bevals\b|llm evaluation|evaluation (framework|pipeline|harness)s?/i],
    ['MLOps & model serving', /\bmlops\b|model (deployment|serving)|\bmlflow\b|kubeflow|sagemaker|vertex ai/i],
    ['CUDA / GPUs', /\bcuda\b|\bgpus?\b/i]
  ]],
  ['Web & APIs', [
    ['React', /\bReact(?:\.js|JS)?\b(?! Native)/],
    ['Next.js', /next\.?js/i],
    ['Vue', /\bvue(\.js)?\b/i],
    ['Angular', /\bangular\b/i],
    ['Node.js', /\bnode(\.js|js)?\b(?=\s*(,|\/|\.js|and|or|&|\(|backend|server|runtime))|\bnode\.js\b/i],
    ['Express', /express\.?js|node(\.js)?\s*(\/|and|&|,)\s*express\b/i],
    ['Django', /\bdjango\b/i],
    ['Flask', /\bflask\b/i],
    ['FastAPI', /fastapi/i],
    ['Spring Boot', /\bspring ?(boot|framework|mvc|cloud)\b/i],
    ['.NET', /(^|[\s(,/])\.net\b(?![\w./-])|\basp\.net\b|\bdotnet\b/i],
    ['GraphQL', /graphql/i],
    ['REST APIs', /\brest(ful)?\s*(apis?|services|endpoints)\b|\brestful\b/i],
    ['gRPC', /\bgrpc\b/i],
    ['HTML / CSS', /\bhtml5?\b|\bcss3?\b/i]
  ]],
  ['Cloud & DevOps', [
    ['AWS', /\baws\b|amazon web services/i],
    ['GCP', /\bgcp\b|google cloud/i],
    ['Azure', /\bazure\b/i],
    ['Docker', /\bdocker\b|\bcontaineri[sz]/i],
    ['Kubernetes', /kubernetes|\bk8s\b/i],
    ['Terraform / IaC', /terraform|infrastructure[- ]as[- ]code|\bcloudformation\b|\bpulumi\b/i],
    ['CI/CD', /\bci\s*\/\s*cd\b|continuous (integration|delivery|deployment)|github actions|jenkins/i],
    ['Linux', /\blinux\b|\bunix\b/i],
    ['Git', /\bgit\b|\bgit(hub|lab)\b(?!\.(com|io))/i],
    ['Serverless', /serverless|\blambda functions?\b|aws lambda/i]
  ]],
  ['Data', [
    ['PostgreSQL', /postgres(ql)?/i],
    ['MySQL', /\bmysql\b/i],
    ['MongoDB', /mongo(db)?\b/i],
    ['Redis', /\bredis\b/i],
    ['NoSQL', /\bnosql\b/i],
    ['Kafka', /\bkafka\b/i],
    ['Spark', /\bSpark\b|pyspark/],
    ['Airflow', /\bairflow\b/i],
    ['Snowflake', /\bsnowflake\b/i],
    ['Databricks', /\bdatabricks\b/i],
    ['dbt', /\bdbt\b/i],
    ['BigQuery', /bigquery/i],
    ['Elasticsearch', /elasticsearch|opensearch/i],
    ['pandas / NumPy', /\bpandas\b|\bnumpy\b/i],
    ['ETL & data pipelines', /\betl\b|\belt\b|data pipelines?/i],
    ['Tableau / Power BI', /tableau|power ?bi|\blooker\b/i]
  ]],
  ['Systems & architecture', [
    ['Distributed systems', /distributed (systems?|computing)/i],
    ['Microservices', /micro-?services/i],
    ['System design', /system design|software architecture|design patterns/i],
    ['Concurrency', /\bconcurrency\b|concurrent (programming|systems)|multi-?thread|parallel (programming|computing)/i],
    ['Networking', /\btcp\/ip\b|network(ing)? protocols|computer networks?|networking (fundamentals|concepts|stack)/i],
    ['Operating systems', /operating systems?|linux kernel/i],
    ['Embedded / RTOS', /\bembedded (systems?|software|c\b|linux|devices?|firmware|development|programming)|\brtos\b|\bfirmware\b|microcontroller/i],
    ['Performance & low latency', /performance (optimi[sz]ation|tuning)|low[- ]latency/i]
  ]],
  ['Mobile', [
    ['iOS', /\bios\b/i],
    ['Android', /\bandroid\b/i],
    ['SwiftUI', /swiftui/i],
    ['React Native', /react native/i],
    ['Flutter', /\bflutter\b/i]
  ]],
  ['Practices & fundamentals', [
    ['Data structures & algorithms', /data structures|\balgorithms\b/i],
    ['Object-oriented design', /object[- ]oriented|\boop\b/i],
    ['Testing', /\b(unit|integration|end-to-end|e2e) tests?(ing)?\b|automated test|\bpytest\b|\bjest\b|test[- ]driven/i],
    ['Code review', /code reviews?/i],
    ['Agile / Scrum', /\bagile\b|\bscrum\b/i],
    ['Observability & monitoring', /observability|prometheus|grafana|datadog|\bsplunk\b|(logging|alerting),? (and )?monitoring|monitoring(,| and) (alerting|logging)|monitoring (tools|systems|dashboards)/i],
    ['Security practices', /secure coding|security best practices|\bowasp\b/i]
  ]]
]

function roleKind (title) {
  const t = String(title || '')
  for (const [kind, re] of ROLE_KINDS) if (re.test(t)) return kind
  return GENERAL_KIND
}

/* the posting itself, not Iris's own wrapping: "Text of …:" and "Title:" lines, the eligibility digest (it repeats lines
   from the posting) and the equal-opportunity boilerplate that names no skill */
function postingBody (text) {
  return String(text || '')
    .replace(/^Text of .*$/m, '')
    .replace(/^Title: .*$/m, '')
    .replace(/ELIGIBILITY LINES[^\n]*\n(?:---\n)?/, '\n')
    .replace(/\n\nIf these lines or its level rule the job out[\s\S]*$/, '')
}

/* the skills one posting names, by label */
function skillsIn (text) {
  const body = postingBody(text)
  const out = []
  for (const [, skills] of SKILL_GROUPS) {
    for (const [label, re] of skills) if (re.test(body)) out.push(label)
  }
  return out
}

/* the least experience it asks for, in years ("2+ years", "3-5 years of experience", "at least 4 years"); null when
   none is stated */
function yearsAsked (text) {
  const body = postingBody(text)
  const re = /(?:at least |minimum of |min\.? )?(\d{1,2})\s*(?:\+|-\s*\d{1,2}|to \d{1,2})?\s*(?:\+\s*)?years?(?:'| of)?\s+(?:of\s+)?(?:\w+\s+){0,4}?(?:experience|exp\b|industry|professional|work)/gi
  let m
  let least = null
  while ((m = re.exec(body))) {
    const n = +m[1]
    if (n > 15) continue
    if (least === null || n < least) least = n
  }
  return least
}

function degreeAsked (text) {
  const b = postingBody(text)
  if (/\bph\.?d\b|doctorate/i.test(b) && /\brequired\b|\bmust\b/i.test(b) && !/bachelor|\bbs\b|\bb\.s\./i.test(b)) return 'PhD'
  if (/\bmaster'?s\b|\bm\.s\.|\bms\b in/i.test(b) && !/bachelor|\bbs\b|\bb\.s\./i.test(b)) return "Master's"
  if (/bachelor|\bbs\b|\bb\.s\.|\bb\.tech\b|undergraduate degree/i.test(b)) return "Bachelor's"
  return null
}

/* one posting's record: what it asks for, nothing more */
function fromPosting (posting) {
  const p = posting || {}
  return {
    key: String(p.key || p.url || ''),
    url: String(p.url || ''),
    company: String(p.company || '').slice(0, 80),
    title: String(p.title || '').slice(0, 140),
    kind: roleKind(p.title),
    skills: skillsIn(p.text),
    years: yearsAsked(p.text),
    degree: degreeAsked(p.text),
    at: p.at || Date.now()
  }
}

/* is this text a job posting (not a company page or a search)? Iris's own eligibility digest says so, or the words
   postings use */
function looksLikePosting (text) {
  const t = String(text || '')
  return /ELIGIBILITY LINES/.test(t) || ((t.match(/\b(responsibilities|qualifications|requirements|what you'?ll do|what we'?re looking for|about the role|you will)\b/gi) || []).length >= 2)
}

function yearsBucket (y) {
  if (y === null || y === undefined) return 'not stated'
  if (y <= 1) return '0–1 years'
  if (y <= 3) return '2–3 years'
  return '4+ years'
}

/**
 * The page's view: per kind of job (and "All"), how many postings, and per skill group the skills with how many
 * postings name them, marked when the user's own profile names them too; the most asked skills the user does not list
 * yet; the experience and degree asks.
 * @param {Array} records fromPosting() records
 * @param {string} userText the user's profile and own words, to mark what they already list
 */
function summarize (records, userText) {
  const have = new Set(skillsIn(userText || ''))
  const kinds = {}
  const add = function (kind, r) {
    const k = kinds[kind] || (kinds[kind] = { postings: 0, skills: {}, years: {}, degree: {} })
    k.postings++
    r.skills.forEach(function (s) { k.skills[s] = (k.skills[s] || 0) + 1 })
    const yb = yearsBucket(r.years)
    k.years[yb] = (k.years[yb] || 0) + 1
    const d = r.degree || 'not stated'
    k.degree[d] = (k.degree[d] || 0) + 1
  }
  ;(records || []).forEach(function (r) { add('All', r); add(r.kind, r) })
  const groupOf = {}
  SKILL_GROUPS.forEach(function ([g, skills]) { skills.forEach(function ([label]) { groupOf[label] = g }) })
  const out = {}
  Object.keys(kinds).forEach(function (kind) {
    const k = kinds[kind]
    const rows = Object.keys(k.skills).map(function (s) { return { skill: s, group: groupOf[s], count: k.skills[s], share: k.skills[s] / k.postings, have: have.has(s) } })
      .sort(function (a, b) { return b.count - a.count || a.skill.localeCompare(b.skill) })
    const groups = SKILL_GROUPS.map(function ([g]) { return { group: g, skills: rows.filter(function (x) { return x.group === g }) } }).filter(function (x) { return x.skills.length })
    // what to learn next: asked by at least two postings (one is no trend), not on the profile yet
    const learn = rows.filter(function (x) { return !x.have && x.count >= 2 }).slice(0, 12)
    out[kind] = { postings: k.postings, groups: groups, learn: learn, years: k.years, degree: k.degree }
  })
  const order = ['All'].concat(ROLE_KINDS.map(function (x) { return x[0] }), [GENERAL_KIND]).filter(function (k) { return out[k] })
  return { kinds: order, byKind: out, total: (records || []).length, since: (records || []).reduce(function (m, r) { return Math.min(m, r.at || m) }, Date.now()) }
}

module.exports = { ROLE_KINDS, SKILL_GROUPS, GENERAL_KIND, roleKind, skillsIn, yearsAsked, degreeAsked, fromPosting, looksLikePosting, summarize, postingBody }
