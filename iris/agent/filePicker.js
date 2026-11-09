'use strict'

/*
 * File pickers Iris can answer. Iris answers a page's file picker through DevTools, with the <input type=file> that
 * opened it. Some pages open the newer system picker instead (window.showOpenFilePicker, the File System Access API):
 * no file box stands behind it, DevTools names none, and no file can go in. Gem's job forms (jobs.gem.com,
 * react-dropzone) do this: from 10-30 to 11-09 every resume upload there failed with "Either nodeId, backendNodeId or
 * objectId must be specified" (96 tries; RRS Group, Deep Infra, Nuvo …), and those jobs went to the user. A page that
 * cannot use the newer picker uses its file box, as it does in browsers without it (Brave hides it too), so Iris hides
 * it from the pages it opens. Frames from other sites (CAPTCHA widgets, payment forms) are left as they are; a form
 * embedded from another site that opens the newer picker gets its file box found instead (pageFileBox).
 */

// before the page's own scripts: react-dropzone looks for the newer picker once, when its drop box is built
const HIDE_FS_PICKER = 'try { delete window.showOpenFilePicker } catch (e) {}'

// a page built before Iris could hide it: the newer picker refuses, the way a page that may not use it hears it, and
// react-dropzone clicks its file box instead (Gem's form does; checked on jobs.gem.com, 11-09). A Proxy keeps the
// browser's own function as the page sees it (its name, and its source shown as native code).
const REFUSE_FS_PICKER = "if ('showOpenFilePicker' in window) window.showOpenFilePicker = new Proxy(window.showOpenFilePicker, { apply: function () {" +
  " return Promise.reject(new DOMException('File pickers are not allowed here.', 'SecurityError')) } })"

/* which file box a file goes in when the picker names none: boxes = [{ text, area, empty, disabled }]. text = the box's
   own words (its label, name, aria-label, the nearest text around it); area = the text of the part of the page it sits
   in, which counts only when its own words name no document ("Insurance coverage" above a Resume box must not make it
   a cover letter box). want = 'resume', 'cover', 'transcript' or ''. The box's index, or -1. Runs in the page as well
   (see pageFileBox), so it uses nothing from outside itself. */
function rankFileBoxes (boxes, want) {
  const kinds = function (s) {
    const t = String(s || '').toLowerCase()
    const out = []
    if (/\bcover\b/.test(t)) out.push('cover')
    if (/\btranscripts?\b/.test(t)) out.push('transcript')
    if (/r[eé]sum[eé]|\bcv\b|curriculum/.test(t)) out.push('resume')
    return out
  }
  let best = -1
  let top = -Infinity
  boxes.forEach(function (b, i) {
    if (b.disabled) return
    let named = kinds(b.text)
    let weight = 4
    if (!named.length) { named = kinds(b.area); weight = 2 }
    let s = 0
    // a box named for this file wins; one named only for another document loses
    if (want && named.indexOf(want) >= 0) s += named.length === 1 ? weight : weight / 2
    else if (want && named.length) s -= weight
    if (b.empty) s += 1
    if (s > top) { top = s; best = i }
  })
  return best
}

/* the page's file box for a picker DevTools named no box for (the newer picker in a page or frame Iris did not hide it
   from, or a box gone since it opened): an expression whose value is that <input type=file>, or null. Shadow roots
   and frames of the same site included. A box's own words: its label, name and aria-label, and the nearest text around
   it ("Click to upload or drag and drop here" on Gem); its area: the largest part of the page around it that holds no
   other file box ("Resume * Click to upload …", or the whole form when it has one box). */
function pageFileBox (want) {
  return '(() => {' +
    ' const rank = ' + rankFileBoxes.toString() + ';' +
    ' const all = [];' +
    ' const walk = r => { r.querySelectorAll(\'input[type=file]\').forEach(e => all.push(e));' +
    ' r.querySelectorAll(\'*\').forEach(e => { if (e.shadowRoot) walk(e.shadowRoot); });' +
    ' r.querySelectorAll(\'iframe, frame\').forEach(f => { try { if (f.contentDocument) walk(f.contentDocument); } catch (e) {} }); };' +
    ' walk(document);' +
    ' const said = e => String((e && e.innerText) || \'\').trim();' +
    ' const words = el => { let n = el; let near = \'\';' +
    ' for (let k = 0; k < 6; k++) { const p = n.parentElement; if (!p || p.querySelectorAll(\'input[type=file]\').length > 1) break; n = p;' +
    ' if (!near) near = said(n); }' +
    ' const root = el.getRootNode && el.getRootNode().querySelector ? el.getRootNode() : document;' +
    ' let label = null;' +
    ' try { label = el.id && typeof CSS !== \'undefined\' && CSS.escape ? root.querySelector(\'label[for="\' + CSS.escape(el.id) + \'"]\') : null; } catch (e) {}' +
    ' return { text: [said(label), el.name, el.id, el.getAttribute(\'aria-label\'), near.slice(0, 200)].join(\' \'), area: n === el ? \'\' : said(n).slice(0, 400) }; };' +
    ' const i = rank(all.map(e => Object.assign(words(e), { empty: !(e.files && e.files.length), disabled: e.disabled })), ' + JSON.stringify(String(want || '')) + ');' +
    ' return i >= 0 ? all[i] : null; })()'
}

module.exports = { HIDE_FS_PICKER, REFUSE_FS_PICKER, rankFileBoxes, pageFileBox }
