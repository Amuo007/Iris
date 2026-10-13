'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { parseChromeBookmarks, chromeDate } = require('../iris/agent/chromeBookmarks')

const sample = {
  roots: {
    bookmark_bar: {
      children: [
        { type: 'url', name: 'GitHub', url: 'https://github.com/', date_added: '13370000000000000' },
        { type: 'folder', name: 'Work', children: [
          { type: 'url', name: 'Jira', url: 'https://jira.example.com/' },
          { type: 'folder', name: 'Deep', children: [{ type: 'url', name: 'Wiki', url: 'https://wiki.example.com/' }] }
        ] },
        { type: 'url', name: 'Hacker News', url: 'https://news.ycombinator.com/' },
        { type: 'url', name: 'A script', url: 'javascript:alert(1)' }
      ]
    },
    other: { children: [{ type: 'folder', name: 'Recipes', children: [{ type: 'url', name: 'Cake', url: 'https://cake.example/' }] }, { type: 'url', name: 'Loose', url: 'https://loose.example/' }] },
    synced: { children: [] }
  }
}

test('bar items keep their order, folders on the bar become bar folders', () => {
  const out = parseChromeBookmarks(sample)
  const bar = out.filter(b => b.tags.includes('bar')).sort((a, b) => a.barIndex - b.barIndex).map(b => b.title)
  assert.deepStrictEqual(bar, ['GitHub', 'Hacker News'])
  assert.deepStrictEqual(out.filter(b => b.tags.includes('barfolder:Work')).map(b => b.title), ['Jira', 'Wiki'])
})

test('other bookmarks are tagged with their folder; scripts are skipped', () => {
  const out = parseChromeBookmarks(sample)
  assert.deepStrictEqual(out.find(b => b.title === 'Cake').tags, ['Recipes'])
  assert.deepStrictEqual(out.find(b => b.title === 'Loose').tags, ['Other-bookmarks'])
  assert.ok(!out.some(b => b.url.startsWith('javascript:')))
  assert.strictEqual(out.length, 6)
})

test('Chrome dates (microseconds since 1601) become normal timestamps', () => {
  assert.strictEqual(new Date(chromeDate('13370000000000000')).getUTCFullYear(), 2024)
})
