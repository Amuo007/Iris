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
async function irisAfChoose (computer, wc, field, plan, facts) {
  const box = await irisAfEval(wc, irisAutofillLib.pageRect(field.key, 'control'))
  if (!box || box.y < 0 || box.y > box.vh) return { left: 'could not bring it into view' }
  await sleep(150)
  await irisAfClick(computer, wc, box.x, box.y)
  await sleep(350)
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
  if (!options || !options.length) {
    await irisAfKey(wc, 'escape')
    return { left: 'its list did not open' }
  }
  const texts = options.map(function (o) { return o.text })
  if (plan.yesNoOnly && !texts.every(function (t) { return /^(yes|no)\b/i.test(t) && t.length <= 12 })) {
    await irisAfKey(wc, 'escape')
    return { left: 'its options are more than yes/no (' + texts.slice(0, 3).join(' / ') + '…): read them and pick' }
  }
  const i = irisAutofillLib.pickOption(texts, patterns, plan.avoid)
  if (i < 0) {
    await irisAfKey(wc, 'escape')
    return { left: 'no option matches the saved answer (' + texts.slice(0, 4).join(' / ') + (texts.length > 4 ? ' …' : '') + ')' }
  }
  const at = await irisAfEval(wc, irisAutofillLib.pageOptionRect(field.key, i))
  if (!at || at.y < 0) {
    await irisAfKey(wc, 'escape')
    return { left: 'its option was out of view' }
  }
  await sleep(120)
  await irisAfClick(computer, wc, at.x, at.y)
  await sleep(300)
  const shown = await irisAfEval(wc, irisAutofillLib.pageValue(field.key))
  if (irisAfShows(shown, texts[i])) return { set: texts[i] }
  return { left: 'clicked "' + texts[i] + '" but the box shows "' + (shown || 'nothing') + '"' }
}

/* checkboxes / radios: a real click on the chosen box's label */
async function irisAfTick (computer, wc, field, index, optionText) {
  const at = await irisAfEval(wc, irisAutofillLib.pageRect(field.key, 'box:' + index))
  if (!at) return { left: 'could not find the box' }
  await sleep(150)
  await irisAfClick(computer, wc, at.x, at.y)
  await sleep(200)
  const shown = await irisAfEval(wc, irisAutofillLib.pageValue(field.key))
  if (irisAfShows(shown, optionText)) return { set: optionText }
  return { left: 'ticked "' + optionText + '" but it does not show as ticked' }
}

/* the resume, through DevTools like a file the user picked */
async function irisAfUpload (computer, wc, field) {
  const file = (computer.lastResume && fs.existsSync(computer.lastResume)) ? computer.lastResume : irisOwnResume()
  if (!file || !fs.existsSync(file)) return { left: 'no resume file is set in Settings → Jobs' }
  try {
    if (!wc.debugger.isAttached()) return { left: 'cannot reach the file box: use Attach' }
    const found = await wc.debugger.sendCommand('Runtime.evaluate', { expression: 'document.querySelector(\'[data-iris-af="' + field.key + '"]\')' })
    const objectId = found && found.result && found.result.objectId
    if (!objectId) return { left: 'cannot reach the file box: use Attach' }
    await wc.debugger.sendCommand('DOM.setFileInputFiles', { files: [file], objectId: objectId })
  } catch (e) {
    return { left: 'the file did not go in (' + e.message + '): use Attach' }
  }
  for (let i = 0; i < 10; i++) {
    await sleep(400)
    if (await irisAfEval(wc, irisAutofillLib.pageValue(field.key))) {
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
  computer.injecting = true
  try {
    for (const field of fields) {
      if (Date.now() - started > 120000) { left.push({ field: field, why: 'autofill ran out of time' }); continue }
      const plan = irisAutofillLib.planField(field, facts)
      let result = null
      try {
        if (plan.do === 'text') {
          await irisAfEval(wc, irisAutofillLib.pageSetText(field.key, plan.value))
          await sleep(60)
          const shown = await irisAfEval(wc, irisAutofillLib.pageValue(field.key))
          result = irisAfNorm(shown) === irisAfNorm(plan.value) ? { set: plan.value } : { left: 'typed it but the box shows "' + (shown || 'nothing') + '"' }
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
      if (result.set !== undefined) set.push({ field: field, value: result.set })
      else left.push({ field: field, why: result.left, quiet: result.quiet && !field.required })
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
  lines.push('Now CHECK: the page is back at the top of the form. Scroll down through ALL of it and compare every box with this list; fix anything wrong or empty by hand (normal clicks), answer the questions left to you, then Submit. Do not call autofill again on this form.')
  DBUG('autofill: set ' + set.length + ', left ' + left.length + ' in ' + (Date.now() - started) + ' ms')
  return { ok: true, pageChanged: true, report: lines.join('\n'), set: set.length, left: mustDo.length }
}
