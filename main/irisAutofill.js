/*
 * main/irisAutofill.js — the "autofill" action: fills an application form's standard fields from the career
 * profile and the saved answers, then tells the agent what it set and what is left. The rules (which sites,
 * which value goes where) live in iris/agent/autofill.js.
 *
 * Hybrid by design: text boxes get their value the way React notices it; dropdowns, checkboxes and the options of
 * a list are clicked with the same real mouse events Iris always uses; the resume goes in through the same
 * DevTools file path as the file picker. Every field is read back afterwards. Anything that fails is simply left
 * for the agent, which checks the whole form on the screenshot before it submits.
 *
 * Concatenated into main.build.js after irisJobs.js (shared scope: irisSendInput, irisInputPlan, sleep,
 * withTimeout, irisCareerLoad, irisProfileLoad, irisOwnResume, DBUG, path, fs).
 */

const irisAutofillLib = require('./iris/agent/autofill.js')

/* one page script, bounded: a page that hangs never holds the run */
async function irisAfEval (wc, code) {
  try {
    return await withTimeout(wc.executeJavaScript(code, true), 4000, 'the page did not answer')
  } catch (e) {
    DBUG('autofill: page script failed: ' + (e && e.message))
    return null
  }
}

/* a real click at a point of the view (CSS px), with the pointer gliding there like any Iris click */
async function irisAfClick (computer, wc, x, y) {
  const zoom = wc.getZoomFactor ? wc.getZoomFactor() || 1 : 1
  const at = { x: Math.round(x * zoom), y: Math.round(y * zoom) }
  const plan = irisInputPlan.planInputEvents({ type: 'click', x: at.x, y: at.y }, { from: computer.pointer })
  for (const step of plan) {
    if (step.command) continue
    await irisSendInput(wc, step.event)
    if (step.delayMs) await sleep(step.delayMs)
  }
  computer.pointer = at
}

/* real keys into whatever has the focus (a dropdown's search box) */
async function irisAfType (computer, wc, text) {
  const plan = irisInputPlan.planInputEvents({ type: 'type', text: text, clear: false }, { from: computer.pointer })
  for (const step of plan) {
    if (step.command) continue
    await irisSendInput(wc, step.event)
    if (step.delayMs) await sleep(step.delayMs)
  }
}

async function irisAfKey (wc, key) {
  const plan = irisInputPlan.planInputEvents({ type: 'key', key: key }, {})
  for (const step of plan) {
    if (step.command) continue
    await irisSendInput(wc, step.event)
    if (step.delayMs) await sleep(step.delayMs)
  }
}

function irisAfNorm (s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase() }

/* the box shows the chosen option — in full, or a short form of it (Greenhouse's phone country shows "+1" for
   "United States +1") */
function irisAfShows (shown, option) {
  const a = irisAfNorm(shown)
  const b = irisAfNorm(option)
  return !!a && (b.indexOf(a) !== -1 || a.indexOf(b.slice(0, 20)) !== -1)
}

/* A react-select dropdown: open it with a real click, (type to search,) read its options, click the one the rule
   picks, read back what it shows. Returns the option chosen, or a reason it was left. */
/* The options of a list that shows them only while open (Greenhouse's dropdowns): opened, read, closed. */
async function irisAfPeekOptions (computer, wc, field) {
  const box = await irisAfEval(wc, irisAutofillLib.pageRect(field.key, 'control'))
  if (!box || box.y < 0 || box.y > box.vh) return null
  await irisAfClick(computer, wc, box.x, box.y)
  await sleep(350)
  let options = await irisAfEval(wc, irisAutofillLib.pageOptions(field.key))
  if (!options || !options.length) {
    await irisAfKey(wc, 'down')
    await sleep(350)
    options = await irisAfEval(wc, irisAutofillLib.pageOptions(field.key))
  }
  await irisAfKey(wc, 'escape')
  await sleep(150)
  return options && options.length ? options.map(function (o) { return String(o.text || '').trim() }).filter(Boolean) : null
}

async function irisAfChoose (computer, wc, field, plan, facts) {
  const box = await irisAfEval(wc, irisAutofillLib.pageRect(field.key, 'control'))
  if (!box || box.y < 0 || box.y > box.vh) return { left: 'could not bring it into view' }
  await sleep(150)
  // open it — and if no list shows: the Down arrow (a box that already had the focus closes on a click), then the
  // arrow at its right end
  const listShown = async function () { const o = await irisAfEval(wc, irisAutofillLib.pageOptions(field.key)); return !!(o && o.length) }
  await irisAfClick(computer, wc, box.x, box.y)
  await sleep(350)
  if (!plan.search && !(await listShown())) {
    await irisAfKey(wc, 'down')
    await sleep(350)
    if (!(await listShown()) && box.right) {
      await irisAfClick(computer, wc, box.right - 18, box.y)
      await sleep(350)
    }
  }
  let patterns = plan.patterns || []
  if (plan.place) {
    // Greenhouse's city box searches places: the right one names the state and the country
    const city = facts.city
    const st = facts.state
    patterns = [new RegExp('^' + city + ', ' + st + ', United States', 'i'), new RegExp('^' + city + ', ' + st + '\\b', 'i'), new RegExp('^' + city + ', ' + facts.stateCode + '\\b', 'i')]
  }
  if (plan.search) {
    await irisAfType(computer, wc, plan.search)
    await sleep(1200)
  }
  let options = await irisAfEval(wc, irisAutofillLib.pageOptions(field.key))
  if (!options || !options.length) {
    await sleep(900)
    options = await irisAfEval(wc, irisAutofillLib.pageOptions(field.key))
  }
  if ((!options || !options.length) && plan.typeAhead) {
    // a list that opens only as you type (Paylocity's State): clear what its search box holds (a resume import can
    // leave text there that is not a pick), type the short form, then pick from what it lists
    wc.selectAll()
    await irisAfKey(wc, 'backspace')
    await irisAfType(computer, wc, plan.typeAhead)
    await sleep(900)
    options = await irisAfEval(wc, irisAutofillLib.pageOptions(field.key))
    if (!options || !options.length) {
      wc.selectAll()
      await irisAfKey(wc, 'backspace')
    }
  }
  if (!options || !options.length) {
    await irisAfKey(wc, 'escape')
    return { left: 'its list did not open', seen: [] }
  }
  let texts = options.map(function (o) { return o.text })
  if (plan.yesNoOnly && !texts.filter(function (t) { return !irisAutofillLib.isPlaceholderOption(t) }).every(function (t) { return /^(yes|no)\b/i.test(t) && t.length <= 12 })) {
    await irisAfKey(wc, 'escape')
    return { left: 'its options are more than yes/no (' + texts.slice(0, 3).join(' / ') + '…): read them and pick', seen: texts }
  }
  let i = plan.pick ? plan.pick(texts) : irisAutofillLib.pickOption(texts, patterns, plan.avoid)
  if (i < 0 && plan.search && /\s/.test(plan.search)) {
    // a search that found nothing that fits: try its first word alone ("University of Houston" → "Houston" lists it too)
    wc.selectAll()
    await irisAfType(computer, wc, plan.search.split(/[\s,]+/).filter(function (w) { return w.length > 3 && !/^(university|college|of|the)$/i.test(w) })[0] || plan.search)
    await sleep(1200)
    const again = await irisAfEval(wc, irisAutofillLib.pageOptions(field.key))
    if (again && again.length) {
      texts = again.map(function (o) { return o.text })
      i = irisAutofillLib.pickOption(texts, patterns, plan.avoid)
    }
  }
  if (i < 0) {
    await irisAfKey(wc, 'escape')
    return { left: 'no option matches the saved answer (' + texts.slice(0, 4).join(' / ') + (texts.length > 4 ? ' …' : '') + ')', seen: texts }
  }
  const at = await irisAfEval(wc, irisAutofillLib.pageOptionRect(field.key, i))
  if (!at || at.y < 0) {
    await irisAfKey(wc, 'escape')
    return { left: 'its option was out of view', seen: texts }
  }
  await sleep(120)
  await irisAfClick(computer, wc, at.x, at.y)
  await sleep(300)
  let shown = await irisAfEval(wc, irisAutofillLib.pageValue(field.key))
  if (irisAfShows(shown, texts[i])) return { set: texts[i], seen: texts }
  // the click did not take (a list that closes on the press): the keyboard way — open it, type the option, Enter
  const again = await irisAfEval(wc, irisAutofillLib.pageRect(field.key, 'control'))
  if (again && again.y >= 0 && again.y <= again.vh) {
    await irisAfClick(computer, wc, again.x, again.y)
    await sleep(250)
    wc.selectAll()
    await irisAfKey(wc, 'backspace')
    await irisAfType(computer, wc, texts[i])
    await sleep(700)
    const typed = await irisAfEval(wc, irisAutofillLib.pageOptions(field.key))
    if (typed && typed.length && irisAfNorm(typed[0].text) === irisAfNorm(texts[i])) {
      await irisAfKey(wc, 'enter')
      await sleep(300)
      shown = await irisAfEval(wc, irisAutofillLib.pageValue(field.key))
      if (irisAfShows(shown, texts[i])) return { set: texts[i], seen: texts }
    }
    wc.selectAll()
    await irisAfKey(wc, 'backspace')
    await irisAfKey(wc, 'escape')
  }
  return { left: 'clicked "' + texts[i] + '" but the box shows "' + (shown || 'nothing') + '"', seen: texts }
}

/* The agent's own "choose" / "fill": a field found by the label it read on the screen, done the way autofill does it
   (open the list, pick by text, read it back) — no aiming at small options by pixels. */
function irisAfEscape (s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
async function irisChooseField (computer, wc, label, option) {
  const fields = await irisAfEval(wc, irisAutofillLib.PAGE_COLLECT)
  if (!Array.isArray(fields)) return { ok: false, error: 'could not read the form on this page' }
  const kinds = ['combobox', 'select', 'radios', 'checkboxes']
  const field = irisAutofillLib.findField(fields, label, kinds)
  if (!field) {
    const names = fields.filter(function (f) { return kinds.indexOf(f.kind) >= 0 && f.label }).map(function (f) { return '"' + String(f.label).slice(0, 50) + '"' }).slice(0, 12)
    return { ok: false, error: 'no dropdown or choice labelled "' + label + '" here' + (names.length ? ' (the ones on this page: ' + names.join(', ') + ')' : '') + ': click it yourself' }
  }
  const result = await irisAfChooseOne(computer, wc, field, option)
  if (result.error) return { ok: false, error: result.error }
  if (result.set !== undefined) return { ok: true, note: 'Chose "' + result.set + '" in "' + field.label + '" (read back from the page).' }
  const seen = result.seen && result.seen.length ? ' Its options: ' + result.seen.slice(0, 15).join(' / ') + '.' : ''
  return { ok: false, error: 'could not choose "' + option + '" in "' + field.label + '": ' + (result.left || 'it did not take') + '.' + seen }
}

/* Picks {option} in a known choice field: { set } when the page shows it, else { left, seen } or { error }. */
async function irisAfChooseOne (computer, wc, field, option) {
  const o = irisAfEscape(String(option).trim())
  // "University of Houston" among its campuses: the main one, not the first branch in the alphabet (real run: Clear Lake)
  const patterns = [new RegExp('^' + o + '$', 'i'), new RegExp('^' + o + '\\s*[-–(,:]\\s*(main|flagship)', 'i'), new RegExp('^' + o + '\\b(?!\\s*[-–(,:]\\s*\\w)', 'i'), new RegExp('^' + o, 'i'), new RegExp(o, 'i')]
  let result
  if (field.kind === 'select') {
    const i = irisAutofillLib.pickOption(field.options || [], patterns)
    if (i < 0) return { error: 'no option "' + option + '" in "' + field.label + '" — its options: ' + (field.options || []).slice(0, 15).join(' / ') }
    const ok = await irisAfEval(wc, irisAutofillLib.pageSetSelect(field.key, field.options[i]))
    result = ok ? { set: field.options[i] } : { left: 'the list did not take it' }
  } else if (field.kind === 'radios' || field.kind === 'checkboxes') {
    const i = irisAutofillLib.pickOption(field.options || [], patterns)
    if (i < 0) return { error: 'no choice "' + option + '" in "' + field.label + '" — its choices: ' + (field.options || []).slice(0, 15).join(' / ') }
    result = await irisAfTick(computer, wc, field, i, field.options[i])
  } else {
    result = await irisAfChoose(computer, wc, field, { do: 'choose', patterns: patterns, typeAhead: String(option).trim() }, {})
  }
  return result
}

async function irisFillField (computer, wc, label, text) {
  const fields = await irisAfEval(wc, irisAutofillLib.PAGE_COLLECT)
  if (!Array.isArray(fields)) return { ok: false, error: 'could not read the form on this page' }
  const field = irisAutofillLib.findField(fields, label, ['text', 'textarea'])
  if (!field) return { ok: false, error: 'no text box labelled "' + label + '" here: click it and type yourself' }
  const r = await irisAfFillOne(computer, wc, field, text)
  return r.set !== undefined ? { ok: true, note: 'Filled "' + field.label + '" (read back from the page: "' + String(r.shown).slice(0, 60) + '").' }
    : { ok: false, error: 'typed into "' + field.label + '" but it shows "' + String(r.shown || 'nothing').slice(0, 60) + '"' }
}

/* Puts {text} in a known text box (page setter, else real keys) and reads it back: { set, shown } or { shown }. */
async function irisAfFillOne (computer, wc, field, text) {
  await irisAfEval(wc, irisAutofillLib.pageSetText(field.key, text))
  await sleep(80)
  let shown = await irisAfEval(wc, irisAutofillLib.pageValue(field.key))
  if (irisAfNorm(shown) !== irisAfNorm(text)) {
    const at = await irisAfEval(wc, irisAutofillLib.pageRect(field.key, ''))
    if (at) {
      await irisAfClick(computer, wc, at.x, at.y)
      await sleep(120)
      wc.selectAll()
      await irisAfType(computer, wc, text)
      await sleep(200)
      shown = await irisAfEval(wc, irisAutofillLib.pageValue(field.key))
    }
  }
  if (irisAfNorm(shown) === irisAfNorm(text) || String(shown || '').replace(/\D/g, '') === String(text).replace(/\D/g, '') && /\d/.test(text)) return { set: text, shown: shown }
  return { shown: shown }
}

/*
 * The questions the rules could not answer, all at once: one text-only model call (no screenshot) answers them from
 * the profile and saved answers; code fills each and reads it back. Not when the form asks applicants not to use AI or
 * to prove they are human — those are the agent's (and the user's) to judge.
 */
async function irisAfAnswerRest (computer, wc, fields, title) {
  const labelled = fields.filter(function (f) { return f.label && f.kind !== 'file' && String(f.label).length > 2 })
  if (labelled.some(function (f) { return /(not|don'?t|do not) use (ai|artificial intelligence|chatgpt|an? ai)|ai (policy|assistant)|confirm (that )?you are (a )?human|automated (application|submission)|are you a (human|robot|bot)/i.test(f.label) })) return { skipped: 'the form has an AI or human-check question' }
  if (!labelled.length) return { answers: {} }
  const bank = irisCareerLoad()
  const cfg = irisSettings()
  // a long list (hundreds of schools): no options sent — the model names its answer and code matches it in the full list
  const list = labelled.slice(0, 40).map(function (f) {
    const o = f.options || []
    return Object.assign({ key: f.key, kind: f.kind, label: String(f.label).slice(0, 300), required: !!f.required }, o.length > 40 ? { options: 'a long list (' + o.length + ' options): answer with the text you want, it is matched' } : { options: o })
  })
  const messages = [
    { role: 'system', content: 'You fill in a job application form for the user, truthfully, from their profile and saved answers below. ' +
      'For each field you can answer, give the answer; leave out any field you cannot answer from these facts (an optional one), and any ' +
      'that is not about the user. A required field the facts do not settle: the most sensible honest answer a new-grad applicant would give ' +
      '("N/A" for an "if yes, explain" box that does not apply). A list, radio or dropdown: the EXACT text of one of its options (checkboxes: ' +
      'several, joined with " | "). A written answer (why us, a project, anything else): 2–4 plain sentences built only from facts in the ' +
      'profile — never invent a number, award, employer, school or skill, and never infer life events it does not state (moves, dates, ' +
      'struggles). An optional personal or "not on your resume" question with no plain fact for it: leave it out. Dates as the box asks (e.g. MM/YYYY). ' +
      'A date or length the facts do not give (an end date, how many months) is never made up: give what they say and that the rest is ' +
      'flexible (e.g. "From December 21, 2026; flexible on the end date"). Never tick optional ' +
      'marketing, SMS or talent-community consents. Reply with JSON only: {"answers":{"<key>":"<answer>", ...}}' },
    { role: 'user', content: 'PROFILE:\n' + irisCareerLib.bankText(bank, 7000) + '\n\nSAVED ANSWERS:\n' + (bank.answers || []).map(function (a) { return a.label + ': ' + a.value }).join('\n') +
      '\n\nJOB PAGE: ' + String(title || '').slice(0, 160) + '\n\nFIELDS STILL EMPTY:\n' + JSON.stringify(list) }
  ]
  const model = irisLockedModel(irisModelClient.createModelClient({ baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey, temperature: 0.1, thinking: 'off', timeoutMs: cfg.modelTimeoutMs }), cfg.baseUrl)
  const reply = await model.next({ messages: messages, thinking: 'off' })
  if (reply && reply.usage) irisUsageRecord('request', Object.assign({ ms: reply.ms }, reply.usage))
  const text = typeof reply === 'string' ? reply : (reply && reply.content) || ''
  const obj = irisLookupLib.firstJsonWith(text, 'answers')
  return { answers: (obj && obj.answers && typeof obj.answers === 'object') ? obj.answers : {} }
}

/*
 * A written answer checked against the profile before it goes into an application: anything it states as the user's
 * own experience, project, number, employer, school or life event that the profile does not support. { ok } or
 * { ok: false, unsupported: [...] }. Fails open (ok) when the model cannot answer — the prompt rules still hold.
 */
async function irisVerifyAnswer (text) {
  try {
    const bank = irisCareerLoad()
    const cfg = irisSettings()
    const messages = [
      { role: 'system', content: 'You check a job-application answer written for the user against their profile. List every statement in ' +
        'the answer that presents something as the user\'s own (an experience, a project or app they built, a number, an employer, a ' +
        'school, a course, an award, a life event) that the profile below does not support. Skills listed in the profile do NOT prove a ' +
        'project with them, and a fact that is only inferred (when the user moved, what they struggled with, their culture or family) ' +
        'is NOT supported unless the profile states it. Opinions, interests and plans are fine. Reply with JSON only: {"unsupported":["<short quote>", ...]} — an ' +
        'empty list when everything is supported.' },
      { role: 'user', content: 'PROFILE:\n' + irisCareerLib.bankText(bank, 7000) + '\n\nSAVED ANSWERS:\n' + (bank.answers || []).map(function (a) { return a.label + ': ' + a.value }).join('\n') +
        '\n\nANSWER TO CHECK:\n' + String(text).slice(0, 3000) }
    ]
    const model = irisLockedModel(irisModelClient.createModelClient({ baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey, temperature: 0, thinking: 'off', timeoutMs: Math.min(cfg.modelTimeoutMs, 60000) }), cfg.baseUrl)
    const reply = await model.next({ messages: messages, thinking: 'off' })
    if (reply && reply.usage) irisUsageRecord('request', Object.assign({ ms: reply.ms }, reply.usage))
    const obj = irisLookupLib.firstJsonWith(typeof reply === 'string' ? reply : (reply && reply.content) || '', 'unsupported')
    const bad = obj && Array.isArray(obj.unsupported) ? obj.unsupported.map(function (x) { return String(x).slice(0, 120) }).filter(Boolean) : []
    return bad.length ? { ok: false, unsupported: bad } : { ok: true }
  } catch (e) {
    DBUG('answer check failed: ' + e.message)
    return { ok: true }
  }
}

/* checkboxes / radios: a real click on the chosen box's label */
async function irisAfTick (computer, wc, field, index, optionText) {
  const at = await irisAfEval(wc, irisAutofillLib.pageRect(field.key, 'box:' + index))
  if (!at) return { left: 'could not find the box' }
  await sleep(150)
  await irisAfClick(computer, wc, at.x, at.y)
  await sleep(200)
  const shown = await irisAfEval(wc, irisAutofillLib.pageValue(field.key, field.name))
  if (irisAfShows(shown, optionText)) return { set: optionText }
  return { left: 'ticked "' + optionText + '" but it does not show as ticked' }
}

/* the resume, through DevTools like a file the user picked */
async function irisAfUpload (computer, wc, field) {
  const file = (computer.lastResume && fs.existsSync(computer.lastResume)) ? computer.lastResume : irisOwnResume()
  if (!file || !fs.existsSync(file)) return { left: 'no resume file is set in Settings → Jobs' }
  let shownBefore = false
  try {
    if (!wc.debugger.isAttached()) return { left: 'cannot reach the file box: use Attach' }
    await irisAfEval(wc, irisAutofillLib.pageMarkBox(field.key))
    // the file's name may show away from the box (under the drop zone): it counts if it was not there before
    shownBefore = await irisAfEval(wc, irisAutofillLib.pageHasText(path.basename(file)))
    const found = await wc.debugger.sendCommand('Runtime.evaluate', { expression: '(() => { ' + irisAutofillLib.AF_DEEP + ' return __one(\'[data-iris-af="' + field.key + '"]\'); })()' })
    const objectId = found && found.result && found.result.objectId
    if (!objectId) return { left: 'cannot reach the file box: use Attach' }
    await wc.debugger.sendCommand('DOM.setFileInputFiles', { files: [file], objectId: objectId })
  } catch (e) {
    return { left: 'the file did not go in (' + e.message + '): use Attach' }
  }
  for (let i = 0; i < 20; i++) {
    await sleep(400)
    if (await irisAfEval(wc, irisAutofillLib.pageValue(field.key)) || (!shownBefore && await irisAfEval(wc, irisAutofillLib.pageHasText(path.basename(file))))) {
      if (computer.lastJob) computer.lastJob.uploaded = true
      return { set: path.basename(file) }
    }
  }
  return { left: 'the resume was sent to the box but the page does not show it: check, else use Attach' }
}

/*
 * Runs the tool on the page in the tab Iris works in. Returns { ok, pageChanged, report } — the report is what the
 * agent reads next: each field set (label → value), and each one left with the reason.
 */
async function irisAutofillRun (computer, wc) {
  const started = Date.now()
  const allowed = irisAutofillLib.autofillAllowed(wc.getURL())
  if (!allowed.ok) return { ok: false, error: allowed.why }
  const fields = await irisAfEval(wc, irisAutofillLib.PAGE_COLLECT)
  if (!Array.isArray(fields) || fields.filter(function (f) { return f.kind !== 'file' }).length < 3) {
    return { ok: false, error: 'no application form on this page yet (open the form first, e.g. click Apply), then autofill' }
  }
  const facts = irisAutofillLib.buildFacts(irisCareerLoad(), irisProfileLoad())
  const set = []
  const left = []
  const record = []
  computer.injecting = true
  try {
    for (const field of fields) {
      if (Date.now() - started > 120000) { left.push({ field: field, why: 'autofill ran out of time' }); continue }
      const plan = irisAutofillLib.planField(field, facts, allowed.mode)
      let result = null
      try {
        if (plan.do === 'text') {
          await irisAfEval(wc, irisAutofillLib.pageSetText(field.key, plan.value))
          await sleep(60)
          let shown = await irisAfEval(wc, irisAutofillLib.pageValue(field.key))
          if (irisAfNorm(shown) !== irisAfNorm(plan.value)) {
            // the page did not take it that way (a box that rewrites itself): click in and type it with real keys
            const at = await irisAfEval(wc, irisAutofillLib.pageRect(field.key, ''))
            if (at) {
              await irisAfClick(computer, wc, at.x, at.y)
              await sleep(120)
              wc.selectAll()
              await irisAfType(computer, wc, plan.value)
              await sleep(150)
              shown = await irisAfEval(wc, irisAutofillLib.pageValue(field.key))
            }
          }
          // a phone box may reformat the digits: same digits count as the same value
          const digits = function (v) { return String(v || '').replace(/\D/g, '') }
          const same = irisAfNorm(shown) === irisAfNorm(plan.value) || (/^[\d\s()+.-]+$/.test(plan.value) && digits(shown) && digits(shown).slice(-10) === digits(plan.value).slice(-10))
          result = same ? { set: plan.value } : { left: 'typed it but the box shows "' + (shown || 'nothing') + '"' }
        } else if (plan.do === 'choose' && field.kind === 'combobox') {
          result = await irisAfChoose(computer, wc, field, plan, facts)
        } else if (plan.do === 'choose' && field.kind === 'select') {
          const ok = await irisAfEval(wc, irisAutofillLib.pageSetSelect(field.key, plan.option))
          result = ok ? { set: plan.option } : { left: 'could not pick "' + plan.option + '"' }
        } else if (plan.do === 'choose' && (field.kind === 'checkboxes' || field.kind === 'radios')) {
          const i = (field.options || []).indexOf(plan.option)
          result = i < 0 ? { left: 'its option is gone' } : await irisAfTick(computer, wc, field, i, plan.option)
        } else if (plan.do === 'upload') {
          result = await irisAfUpload(computer, wc, field)
        } else {
          result = { left: plan.why, quiet: true }
        }
      } catch (e) {
        result = { left: 'failed (' + e.message + ')' }
      }
      if (result.set !== undefined && plan.replace) result.set = result.set + ' (was "' + String(plan.replace).slice(0, 40) + '")'
      if (result.set !== undefined) set.push({ field: field, value: result.set })
      // a box already filled is not "to do", required or not (a second run after a blocked Submit lists only the empty ones)
      else left.push({ field: field, why: result.left, quiet: (result.quiet && !field.required) || plan.why === 'already filled' })
      // for the hybrid dataset: what the tool saw and decided, field by field
      record.push({ key: field.key, id: field.id, kind: field.kind, label: String(field.label || '').slice(0, 400), required: !!field.required,
        before: field.value || '', options: (result.seen || field.options || null), plan: plan.do, planned: plan.value || plan.option || plan.search || null,
        why: plan.why || null, set: result.set !== undefined ? result.set : null, left: result.set === undefined ? (result.left || null) : null,
        section: field.section || undefined, shape: field.shape || undefined })
    }
    // the rest — custom questions, written answers — in one text-only model call, filled by code
    const rest = left.filter(function (l) { return !l.quiet && l.field.label && l.field.kind !== 'file' && !/already filled|section:|optional box|resume import|a document other/i.test(l.why || '') })
    if (rest.length && Date.now() - started < 120000) {
      let asked = null
      // a dropdown whose options show only while open: read them first, so the answer is one of them (a real
      // Greenhouse form: "Central Time (US & Canada)" for a list of "UTC-6: …", the user's name for a Yes / No)
      for (const l of rest) {
        if (l.field.kind !== 'combobox' || (l.field.options && l.field.options.length) || Date.now() - started > 90000) continue
        try {
          const seen = await irisAfPeekOptions(computer, wc, l.field)
          if (seen) l.field.options = seen
        } catch (e) { /* only a look */ }
      }
      try { asked = await irisAfAnswerRest(computer, wc, rest.map(function (l) { return l.field }), wc.getTitle()) } catch (e) { DBUG('autofill: model answers failed: ' + e.message) }
      const answers = (asked && asked.answers) || {}
      // every number of 3+ digits in an answer must be the user's own (a real run wrote the university's zip, 77004, for
      // the home zip 77084): digits found in the profile's values, a year near now, or the field's own options
      const ownDigits = []
      const walk = function (v) { if (typeof v === 'string') { const d = v.replace(/\D/g, ''); if (d.length >= 3) ownDigits.push(d) } else if (v && typeof v === 'object') Object.keys(v).forEach(function (k) { walk(v[k]) }) }
      walk(irisCareerLoad()); walk(irisProfileLoad())
      const thisYear = new Date().getFullYear()
      const madeUpNumbers = function (val, field) {
        return (String(val).match(/\d{3,}/g) || []).filter(function (n) {
          if (n.length === 4 && +n >= thisYear - 1 && +n <= thisYear + 3) return false
          if ((field.options || []).some(function (o) { return String(o).indexOf(n) >= 0 })) return false
          return !ownDigits.some(function (d) { return d.indexOf(n) >= 0 })
        })
      }
      for (const l of rest) {
        const a = answers[l.field.key]
        if (a === undefined || a === null || String(a).trim() === '') continue
        const val = String(a).trim()
        const odd = madeUpNumbers(val, l.field)
        if (odd.length) {
          const rec1 = record.find(function (x) { return x.key === l.field.key })
          if (rec1) { rec1.plan = 'llm'; rec1.planned = val; rec1.llmLeft = 'a number not in the profile: ' + odd.join(', ') }
          continue
        }
        if (val.length > 150 && (l.field.kind === 'text' || l.field.kind === 'textarea')) {
          const chk = await irisVerifyAnswer(val)
          if (!chk.ok) {
            const rec0 = record.find(function (x) { return x.key === l.field.key })
            if (rec0) { rec0.plan = 'llm'; rec0.planned = val; rec0.llmLeft = 'not supported by the profile: ' + chk.unsupported.join('; ') }
            continue
          }
        }
        let r = {}
        try {
          if (l.field.kind === 'text' || l.field.kind === 'textarea') r = await irisAfFillOne(computer, wc, l.field, val)
          else if (l.field.kind === 'checkboxes' && /\s\|\s/.test(val)) { for (const v of val.split(/\s\|\s/)) r = await irisAfChooseOne(computer, wc, l.field, v) }
          else r = await irisAfChooseOne(computer, wc, l.field, val)
        } catch (e) { r = { left: 'failed (' + e.message + ')' } }
        const rec = record.find(function (x) { return x.key === l.field.key })
        if (r.set !== undefined) {
          set.push({ field: l.field, value: r.set + ' (AI)' })
          left.splice(left.indexOf(l), 1)
          if (rec) { rec.plan = 'llm'; rec.planned = val; rec.set = r.set; rec.left = null }
        } else if (rec) { rec.plan = 'llm'; rec.planned = val; rec.llmLeft = r.left || r.error || 'did not take' }
      }
      if (asked && asked.skipped) DBUG('autofill: model answers skipped: ' + asked.skipped)
    }
  } finally {
    computer.injecting = false
    computer.injectingUntil = Date.now() + 400
  }
  await irisAfEval(wc, irisAutofillLib.PAGE_SCROLL_TOP)
  await sleep(250)
  const short = function (f) { return '"' + String(f.label || f.id).slice(0, 70) + '"' }
  const mustDo = left.filter(function (l) { return !l.quiet && (l.field.required || l.field.kind === 'file' || /resume/i.test(l.field.label)) })
  const optional = left.filter(function (l) { return !l.quiet && !mustDo.includes(l) })
  const lines = ['Autofill filled ' + set.length + ' of ' + fields.length + ' fields in ' + Math.round((Date.now() - started) / 1000) + ' s (from the profile and saved answers):']
  set.forEach(function (s) { lines.push('  ✓ ' + short(s.field) + ' = ' + String(s.value).slice(0, 80)) })
  if (mustDo.length) {
    lines.push('Still to do by hand (required):')
    mustDo.forEach(function (l) { lines.push('  • ' + short(l.field) + ' — ' + l.why) })
  }
  if (optional.length) {
    lines.push('Left empty (optional):')
    optional.forEach(function (l) { lines.push('  • ' + short(l.field) + ' — ' + l.why) })
  }
  lines.push('Now: 1) fill each box under "Still to do" straight away with {"type":"choose"} / {"type":"fill"} by its label — no need to scroll to it; ' +
    '2) then ONE pass down the form (the page is back at the top), scrolling about 8 at a time, checking the boxes against this list and fixing what is wrong; ' +
    '3) Submit (or Next, and autofill again on the next step). Do not scroll up and down hunting. ' +
    'The ✓ choices were picked from each list\'s FULL set of options: a value it did not pick is not offered there (a language, a year) — keep its pick, do not look for one.')
  DBUG('autofill: set ' + set.length + ', left ' + left.length + ' in ' + (Date.now() - started) + ' ms')
  try {
    fs.appendFileSync(path.join(userDataPath, 'iris-autofill-log.jsonl'), JSON.stringify({ at: started, ms: Date.now() - started, sessionId: computer.sessionId || null,
      url: wc.getURL(), mode: allowed.mode, fields: record }) + '\n')
  } catch (e) { DBUG('autofill: log failed: ' + e.message) }
  return { ok: true, pageChanged: true, report: lines.join('\n'), set: set.length, left: mustDo.length }
}
