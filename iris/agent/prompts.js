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

function modeText (mode) {
  if (mode === 'continuous') {
    return 'This is a long, autonomous run with no step limit. Keep working until the task is fully done. ' +
      'Save every useful finding with "remember" so nothing is lost, and check your notes so you never repeat work (for example, never download the same file twice). ' +
      'Reply "done" only when there is truly nothing left to do, with a full report.'
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
  return 'You have ' + stepsLeft + ' step(s) left. If the task is complete, reply with {"thought":"...","action":{"type":"done","answer":"..."}}.'
}

module.exports = {
  systemPrompt,
  taskMessage,
  followUpMessage,
  digestLine,
  digestText,
  filesText,
  skillsText,
  tabsText,
  notesText,
  profileText,
  modeText,
  observationIntro,
  loadingWarning,
  correctionMessage,
  failureMessage,
  takeoverMessage,
  finishReminder
}
