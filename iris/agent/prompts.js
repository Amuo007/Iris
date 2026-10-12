'use strict'

/*
 * iris/agent/prompts.js — everything said to the model, in one file.
 * Pure.
 */

const { ACTION_SPEC_TEXT } = require('./actionSchema')

function systemPrompt (extra) {
  const parts = [
    'You are Iris, an AI agent inside the Iris web browser for macOS.',
    'You are given a task and screenshots of the browser page you control.',
    '',
    ACTION_SPEC_TEXT
  ]
  if (extra) parts.push('', extra)
  return parts.join('\n')
}

function taskMessage (task) {
  return 'Task: ' + task
}

function observationIntro (obs, index) {
  const url = obs && obs.url ? obs.url : '(unknown url)'
  return 'Step ' + index + ' — page: ' + url
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
  observationIntro,
  loadingWarning,
  correctionMessage,
  failureMessage,
  takeoverMessage,
  finishReminder
}
