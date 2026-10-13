'use strict'

/*
 * iris/agent/chromeBookmarks.js — turn Google Chrome's "Bookmarks" JSON into Iris bookmarks.
 *
 * Bar items get the tag "bar" and keep their order (barIndex); items in a bar folder get
 * "barfolder:<name>"; everything else is tagged with its folder name, as Min does for HTML
 * imports. Chrome stores dates as microseconds since 1601. Pure.
 */

const EPOCH_1601_MS = 11644473600000

function chromeDate (us) {
  const n = Number(us || 0)
  return n ? Math.round(n / 1000 - EPOCH_1601_MS) : Date.now()
}

function parseChromeBookmarks (json) {
  const root = (json && json.roots) || {}
  const out = []
  const walk = function (node, tags, index) {
    if (!node) return
    if (node.type === 'url' && /^https?:|^file:/.test(node.url || '')) {
      out.push({ url: node.url, title: node.name || node.url, tags: tags.slice(), barIndex: index, added: chromeDate(node.date_added) })
    } else if (node.children) {
      node.children.forEach(function (child, i) { walk(child, tags, index !== undefined ? index * 1000 + i : undefined) })
    }
  }
  ;((root.bookmark_bar && root.bookmark_bar.children) || []).forEach(function (node, i) {
    if (node.type === 'folder') walk(node, ['barfolder:' + node.name], i)
    else walk(node, ['bar'], i)
  })
  ;['other', 'synced'].forEach(function (key) {
    ;((root[key] && root[key].children) || []).forEach(function (node) {
      walk(node, node.type === 'folder' ? [node.name] : ['Other-bookmarks'])
    })
  })
  return out
}

module.exports = { parseChromeBookmarks, chromeDate }
