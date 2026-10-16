'use strict'

/*
 * iris/agent/prompts.js — everything said to the model, in one file.
 * Pure.
 */

const { ACTION_SPEC_TEXT } = require('./actionSchema')

function systemPrompt (extra) {
  const parts = [
    'You are Iris, an AI agent that operates a web browser for the user.',
    'Each step you get a screenshot of the current tab and act on it with a real mouse and keyboard.',
    '',
    ACTION_SPEC_TEXT
  ]
  if (extra) parts.push('', extra)
  return parts.join('\n')
}

function taskMessage (task) {
  return 'Task: ' + task
}

/**
 * The deeper-thinking call before a "Plan first" run. No screenshot: just the request.
 * It may ask the user a few multiple-choice questions first (once), then it plans.
 */
function planMessages (task, extra, opts) {
  const o = opts || {}
  const lines = [
    'You plan tasks for Iris, an AI agent that uses a web browser like a person (screenshots, mouse, keyboard).',
    'The user may describe what they want loosely. Work out what they most likely need, then write a short plan.'
  ]
  if (o.allowQuestions) {
    lines.push(
      'If the request could mean quite different things and the answer would change what Iris looks for,',
      'ask first: reply with JSON only, {"questions":[{"q":"<short question>","options":["<a>","<b>","<c>"]}]},',
      'at most 4 questions with 2-4 options each. If it is clear enough, do not ask.'
    )
  }
  if (o.lookups) {
    lines.push(
      'You can look things up before planning, outside the browser (fast, text only). Reply with JSON only:',
      '{"lookups":[{"kind":"web|papers|arxiv|wiki|page","query":"..."}]}   (at most ' + o.lookups.max + ' now)',
      'web = search results with snippets (add "reddit" to see how people do it), papers = academic papers with',
      'abstracts and citation counts, arxiv = newest arXiv preprints, wiki = encyclopedia summary,',
      'page = the text of one public page (query = its URL).',
      'Look up only what changes the plan: which websites are best for this, what a good result looks like,',
      'how others did it. ' + (o.level === 'deep'
        ? 'Be thorough: compare a few sources before you plan.'
        : 'Keep it quick: one or two look-ups, or none when the task is simple or you already know where to go.')
    )
  }
  lines.push(
    'The plan is plain text, at most 14 short lines, exactly these parts:',
    'Goal: <one line>',
    'Good result means: <2-4 short criteria Iris can check by reading a page>',
    'Start at: <1-3 exact URLs or searches to begin with>',
    'How: <2-5 steps: where to look, which searches to try>',
    'Done when: <one line, e.g. a number of kept results>'
  )
  if (o.lookups || o.hadLookups) {
    lines.push('Known so far: <only if look-ups found candidates or facts worth checking, each with its URL>')
  }
  const user = ['Request: ' + task]
  if (o.answers) user.push('The user answered your questions:\n' + o.answers + '\nNow write the plan (no more questions).')
  if (o.current) user.push('The current plan, to revise rather than restart:\n' + o.current)
  return [
    { role: 'system', content: lines.join('\n') + (extra ? '\n\n' + extra : '') },
    { role: 'user', content: user.join('\n\n') }
  ]
}

/** {"questions":[...]} from a planner reply, cleaned up; null if it is a plan. */
function parseQuestions (text) {
  const m = /\{[\s\S]*"questions"[\s\S]*\}/.exec(String(text || ''))
  if (!m) return null
  try {
    const obj = JSON.parse(m[0])
    const qs = (obj.questions || []).slice(0, 4).map(function (q) {
      return { q: String(q.q || q.question || '').slice(0, 200), options: (q.options || []).slice(0, 4).map(function (x) { return String(x).slice(0, 120) }) }
    }).filter(function (q) { return q.q })
    return qs.length ? qs : null
  } catch (e) {
    return null
  }
}

/**
 * One quick call before a final answer is shown: remove details Iris never saw. The checker gets
 * the task, the answer, what Iris noted and thought along the way, and the last screenshot.
 */
function answerCheckMessages (task, answer, evidence, dataUrl) {
  const system = [
    'You check the final answer of Iris, an AI agent that just did a task in a web browser.',
    'Iris may only report what it actually saw. Its notes and step-by-step thoughts are below, with the last screenshot.',
    'List every specific detail in the answer (time, date, price, number, name, code, link) that appears neither in the',
    'notes and thoughts nor in the screenshot. Then rewrite the answer without those details, keeping everything else',
    'word for word. Reply with JSON only: {"unsupported":["<detail>",...],"answer":"<rewritten answer>"}.',
    'If every detail is supported, reply {"unsupported":[]}.'
  ].join('\n')
  const text = 'Task: ' + task + '\n\nAnswer to check:\n' + answer + '\n\nWhat Iris noted and thought during the task:\n' + evidence
  const content = [{ type: 'text', text }]
  if (dataUrl && dataUrl !== 'omitted') content.push({ type: 'image_url', image_url: { url: dataUrl } })
  return [{ role: 'system', content: system }, { role: 'user', content }]
}

/** {"unsupported":[...],"answer":"..."} from the checker, or null when it found nothing to fix. */
function parseAnswerCheck (text, original) {
  const m = /\{[\s\S]*"unsupported"[\s\S]*\}/.exec(String(text || ''))
  if (!m) return null
  try {
    const obj = JSON.parse(m[0])
    const removed = (obj.unsupported || []).map(function (x) { return String(x).slice(0, 120) }).filter(Boolean)
    const answer = typeof obj.answer === 'string' ? obj.answer.trim() : ''
    // never accept a rewrite that throws most of the answer away
    if (!removed.length || !answer || answer.length < String(original || '').length * 0.4) return null
    return { removed, answer }
  } catch (e) {
    return null
  }
}

/** The look-up results, handed back to the planner. */
function lookupResultsMessage (results, more) {
  return 'Look-up results:\n\n' + results.join('\n\n') + '\n\n' +
    (more ? 'If something important is still missing, look up more (same JSON); otherwise write the plan now.'
      : 'Now write the plan (no more look-ups).')
}

/** Goal and finish line, repeated on every step so a long run never drifts from them. */
function planReminder (plan) {
  const lines = String(plan || '').split('\n').filter(function (l) { return /^\s*(Goal|Done when)\s*:/i.test(l) })
  return lines.length ? 'Remember the plan — ' + lines.map(function (l) { return l.trim() }).join(' | ') : ''
}

function planText (plan) {
  return 'Your plan (made before starting; follow it and adjust when you learn something new):\n' + plan +
    '\nJudge each candidate (open it and read enough) before you keep, download or report it.'
}

function finishCheckNote () {
  return 'Not finished yet: you have not judged any candidate. Open each one you want to report, read enough of it ' +
    '(abstract, description), and record judge. Your final answer must list only what you kept with judge, each with the reason.'
}

function reviewNote () {
  return 'Check-in: compare your progress with the plan. What is done, what is left, and does the approach need to change? Then continue.'
}

function decisionsText (kept, skipped, ids) {
  const shown = kept.slice(-10)
  return 'Your decisions so far: kept ' + kept.length + (shown.length ? ' (latest: ' + shown.join('; ') + ')' : '') + ', skipped ' + skipped + '. Use recall to check one.' +
    (ids && ids.length ? '\nAlready judged — never open these again: ' + ids.slice(-300).join(', ') : '')
}

function followUpMessage (text) {
  return 'New message from the user (continue from where you are; earlier steps above are context): ' + text
}

function tabsText (tabs) {
  return 'Tabs: ' + tabs.map(function (t, i) {
    const name = (t.title || t.url || 'New tab').slice(0, 60)
    return '[' + (i + 1) + '] ' + name + (t.active ? ' (current)' : '')
  }).join('  ')
}

const { describeAction } = require('./actionSchema')

function digestLine (action, thought) {
  return describeAction(action) + (thought ? ' — ' + String(thought).slice(0, 90) : '')
}

function digestText (lines, dropped) {
  return 'Earlier steps (summary' + (dropped ? ', plus ' + dropped + ' older ones' : '') + '):\n' + lines.join('\n')
}

/** Where this task has been, newest first, with the last thing noted on each site. */
function sitesText (visited, current) {
  return 'Sites in this task (steps there; your last thought there):\n' + visited.map(function (v) {
    return '- ' + v.host + (v.host === current ? ' (here now)' : '') + ': ' + v.steps + ' step' + (v.steps === 1 ? '' : 's') + (v.last ? '; "' + v.last + '"' : '')
  }).join('\n') + '\nDo not go back to a site that already failed you (login wall, blocked, no results) unless something has changed.'
}

function filesText (files) {
  const latest = files.slice(-5)
  return 'Downloaded in this chat so far: ' + files.length + ' file' + (files.length === 1 ? '' : 's') +
    ' (latest: ' + latest.join(', ') + '). Iris skips anything already downloaded by itself; use recall to check a specific one.'
}

function skillsText (skills) {
  return 'What you learned before on ' + skills.site + ':\n' + skills.tips.map(function (t) { return '- ' + t }).join('\n')
}

function notesText (notes, older) {
  return 'Your notes' + (older ? ' (latest ' + notes.length + '; ' + older + ' older ones: use recall to search them)' : '') + ':\n' +
    notes.map(function (n) { return '- ' + n }).join('\n')
}

/** What Iris knows about the user. Secrets appear only as {{placeholders}}. */
function profileText (profile) {
  if (!profile || !profile.length) return ''
  const lines = ['About the user (use these whenever a form, sign-up or login needs them):']
  profile.forEach(function (f) {
    if (!f || !f.label) return
    if (f.secret) lines.push('- ' + f.label + ': type the placeholder {{' + f.label + '}} — Iris replaces it with the real value as it types')
    else if (f.value) lines.push('- ' + f.label + ': ' + f.value)
  })
  return lines.length > 1 ? lines.join('\n') : ''
}

/** "Keep going until I stop you": a task that has no natural end. */
function isOpenEnded (task) {
  return /until (i|you are|you're) (stop|tell)|keep (going|researching|looking|collecting|finding|searching|downloading)|non-?stop|forever|continuously|as many as (you can|possible)/i.test(String(task || ''))
}

function modeText (mode) {
  if (mode === 'continuous') {
    return 'This is a long, autonomous run with no step limit. Keep working until the task is fully done. ' +
      'Iris itself keeps count of your downloads and of everything you judged, and shows them on every step: do not write ' +
      'progress notes about those. Use "remember" only for findings you will need later that are not tracked (a fact, a ' +
      'useful site, a lead to follow). Reply "done" only when there is truly nothing left to do, with a full report.'
  }
  return ''
}

function observationIntro (obs, index, limits) {
  const lines = []
  const of = limits && limits.maxSteps ? ' of ' + limits.maxSteps : ''
  lines.push('Step ' + index + of + '.')
  lines.push('URL: ' + (obs && obs.url ? obs.url : '(empty tab)'))
  if (obs && obs.title) lines.push('Title: ' + obs.title)
  if (obs && obs.width) lines.push('Screenshot: ' + obs.width + 'x' + obs.height + ' px (x 0-' + (obs.width - 1) + ', y 0-' + (obs.height - 1) + ').')
  if (obs && obs.crop) lines.push('This is a 2x CLOSE-UP of part of the page. Coordinates you give refer to this close-up image. The next screenshot will show the whole page again.')
  if (obs && obs.tabChanged) lines.push(obs.tabChanged)
  if (obs && obs.firstOfTask) lines.push('This page was already open when the task started; it may have nothing to do with the task. Ignore it unless it helps.')
  if (obs && obs.emptyTab) lines.push('This tab is empty (new tab). Use "navigate" to open a website or search.')
  else if (obs && obs.blank) lines.push('The page looks blank. It may still be loading: use "wait" once, then try something else.')
  return lines.join('\n')
}

function loadingWarning (obs) {
  return 'NOTE: this page is still loading. If the screenshot looks blank or incomplete, reply with {"thought":"waiting","action":{"type":"wait","ms":1000}}.' +
    (obs && obs.loadingMs ? ' It has been loading for ' + obs.loadingMs + ' ms.' : '')
}

function correctionMessage (error, limits) {
  const range = limits && limits.imageWidth
    ? '(x in 0..' + (limits.imageWidth - 1) + ', y in 0..' + (limits.imageHeight - 1) + ' at the screenshot resolution)'
    : 'inside the screenshot you were shown'
  return [
    'REJECTED: your previous reply was not a usable action.',
    'Reason: ' + error,
    'Reply again with EXACTLY ONE JSON object matching the schema. No prose, no markdown fences.',
    'Remember: coordinates must be ' + range + '.'
  ].join(' ')
}

function failureMessage (error) {
  return 'The previous action failed: ' + error + '. Look at the newest screenshot and try a different approach.'
}

function takeoverMessage (info) {
  const where = info && info.at ? ' The pointer moved to (' + info.at.x + ', ' + info.at.y + ').' : ''
  return 'The human user just interacted with the page directly (' + ((info && info.kind) || 'input') + ').' + where + ' Take that into account before your next action.'
}

function finishReminder (stepsLeft) {
  return 'Only ' + stepsLeft + ' step' + (stepsLeft === 1 ? '' : 's') + ' left for this task. If you cannot finish in time, reply "done" now with what you have found so far ' +
    '(say what is missing). A partial answer is far better than none.'
}

module.exports = {
  systemPrompt,
  taskMessage,
  followUpMessage,
  planMessages,
  parseQuestions,
  planText,
  planReminder,
  answerCheckMessages,
  parseAnswerCheck,
  lookupResultsMessage,
  reviewNote,
  finishCheckNote,
  decisionsText,
  digestLine,
  digestText,
  filesText,
  sitesText,
  skillsText,
  tabsText,
  notesText,
  profileText,
  modeText,
  isOpenEnded,
  observationIntro,
  loadingWarning,
  correctionMessage,
  failureMessage,
  takeoverMessage,
  finishReminder
}
