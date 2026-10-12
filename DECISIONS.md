# Decision log

Why Iris is built the way it is. Each entry: the problem, the options that were on the table, what
was chosen, and what it cost.

---

## 1. Fork Min rather than build on Electron from scratch

**Problem.** The brief needs a real browser (tabs, history, bookmarks, search, settings, content
blocking, updates to pages' quirks) plus an agent on top, on a short time budget.

**Options.**
1. Electron shell + Chromium `loadURL` — reinvent tabs, history, permissions, PDFs, downloads.
2. Playwright/Puppeteer-driven browser — automation-first, which the brief explicitly rules out.
3. Fork Min (MIT/Apache, small, plain JS, no framework) and add the agent.

**Decision.** (3). Upstream `master` merged into this repo with `--allow-unrelated-histories` so
Min's history and `LICENSE` stay intact and upstream can still be re-merged.

**Cost.** Min's globals (`settings`, `tabs`, `tasks`, `webviews`, `viewMap`, `ipc`) are shared across
concatenated files, so new code must read upstream carefully. Min's `tabBar.css`/`base.css` rules
sometimes need matching specificity to override (e.g. `#navbar #tabs { flex: 1 }`).

---

## 2. Vision-only agent: screenshots in, input events out

**Problem.** The agent must not be able to read or mutate page internals.

**Options.**
1. DOM/CDP automation (`Runtime.evaluate`, selectors) — fast, reliable, and forbidden by the brief.
2. Accessibility tree — semi-structured, still a second channel into the page.
3. Screenshots only, and real `sendInputEvent` mouse/keyboard events.

**Decision.** (3), enforced structurally: the only Electron APIs used to affect a page are
`webContents.capturePage()` / `desktopCapturer` (see) and
`webContents.sendInputEvent()` (act). There is no `executeJavaScript` anywhere in the agent path. A
site can therefore only ever show Iris the same pixels it shows you.

**Cost.** Every interaction needs pixel-accurate mapping (decision 4), and "did it work?" has to be
answered from pixels plus cheap page signals (URL, title, loading state), not from the DOM.

---

## 3. Agent core is Electron-free and unit-tested; one Electron adapter on top

**Problem.** An agent loop tangled in Electron can only be tested by launching a browser, and the
interesting failure modes (parsing, mapping, budgets, retries) are pure logic.

**Decision.** `iris/agent/*.js` is pure Node: no `require('electron')`, no DOM. `main/irisAgent.js`
is the single adapter that implements the "computer" (capture, inject, overlay, IPC) against the
loop's interface. Result: `node --test test/*.test.js` runs 90 tests in about a second with zero
network and zero Electron.

**Cost.** A thin interface layer (`IrisComputer`) has to be kept in sync with the loop's contract —
worth it for the test speed.

---

## 4. Capture: `capturePage()` first, window grab + crop as the fallback

**Problem.** On macOS, `capturePage()` against Min's per-tab `WebContentsView` can reject with
"the page has not painted yet" or simply never settle — including for a New Tab Page, whose view is
not attached to the window's content view and whose `getURL()` is empty. A hung capture blocked the
main-process event loop.

**Options.**
1. Capture only the view. Breaks on fresh tabs and on unattached views.
2. Capture the whole window through `desktopCapturer` and crop to the tab's bounds.
3. Screenshot the whole display and crop.

**Decision.** Try the view; if it is unattached, has no URL, or fails/times out, fall back to the
window's composited image cropped to the view's bounds (`captureWindowOf`). Never treat an unpainted
tab as an error: report `loading` and let the loop's bounded auto-wait handle it.

**Cost.** Two code paths, and the panel's renderer must supply the view bounds at start
(`fallbackBounds`) so a never-painted tab can still be captured. This path is exercised in the
packaged app: the demo run's screenshots come from `desktopCapturer` at scale 2.

---

## 5. Coordinates carried as two independent sizes

**Problem.** Screenshot pixels and CSS pixels differ by device pixel ratio (2× here), by any
downscaling applied before the model call, and by where the panel has shifted the page.

**Decision.** `coordinateMapper.js` carries image width/height and view width/height separately and
maps per axis, with clamping into the viewport. Nothing in the codebase assumes a scale factor. Both
the image point and the resulting CSS point are shown in the panel, which makes off-by-DPR bugs
visible instead of silent.

**Consequence.** Adding 3× displays or a smaller model image is a config change, not a code change.

---

## 6. Click marker lives in its own transparent, click-through window

**Problem.** The marker has to appear above the page. DOM in Min's UI window is composited *under*
the `WebContentsView`s, so a marker div is invisible over page content.

**Options.**
1. Inject the marker into the page — forbidden (no DOM writes, and it would pollute screenshots).
2. A separate `BrowserWindow`: `transparent`, `frame: false`, `alwaysOnTop('screen-saver')`,
   `setIgnoreMouseEvents(true, { forward: true })`.

**Decision.** (2). It forwards mouse events, so it can never steal a click from the page or from
the user, and it is positioned from the same bounds the capture uses, so marker and click agree.

---

## 7. Strict action grammar with a recovery path

**Problem.** Small models emit near-miss JSON: `"x": "784"`, missing keys, extra keys, prose around
the object, `"click at 10,20"`.

**Decision.** One schema (`actionSchema.js`) defines the grammar; the parser returns either a valid
action or a *specific* reason, and has a separate recovery tier that coerces common malformations
(string numbers, single-key shorthand, prose preambles) while rejecting anything ambiguous. Only a
parsed action reaches the input injector.

**Consequence.** Bad model output becomes a retryable, explainable step rather than a crash or a
wild click.

---

## 8. Retries are consecutive, not per-step

**Problem.** "3 retries per step" plus "3 failures" is ambiguous and easy to blow up into
`steps × retries` attempts.

**Decision.** Two distinct budgets: `maxRetriesPerStep` (3) for a single step, and
`maxConsecutiveFailures` (3) across steps, plus `repeatActionLimit` (3) for identical consecutive
actions and a wall-clock budget. Every stop names its cause.

---

## 9. Takeover detection by monotonic counter, ignoring injected events

**Problem.** Pausing on user input must not trigger on the agent's own injected events.

**Decision.** The adapter records `injectingUntil` around each injected sequence; `before-input-event`
increments `takeoverCount` only outside that window. The panel exposes pause/stop and shows why the
run yielded. A monotonic counter means "takeover" survives restarts of the loop without ambiguity.

---

## 10. Loop runs in the main process

**Problem.** Renderer processes have CSP and cannot make arbitrary cross-origin requests; capture
and input injection are privileged.

**Decision.** Keep the loop in the main process, next to the adapter. The panel is a dumb, event-
driven view fed by broadcast IPC.

**Consequence.** Model HTTP happens in main; if a future build wants per-tab isolation, the loop
would move into a utility process — the core stays unchanged because it is Electron-free.

---

## 11. Never call the real model server during development

**Constraint from the brief.** All development, tests and demos use `IRIS_FAKE_MODEL=1` and
`iris/agent/fakeModel.js`. The real endpoint and model name appear only as *defaults* in settings,
so the user's first real run is the first real request.

---

## 12. Settings live in Min's existing store, under one key

**Decision.** Everything is `settings.irisAI`, merged over `IRIS_DEFAULT_SETTINGS` at run start and
re-read on change. The settings page clamps numbers and falls back to defaults on blank/invalid
input; a typo can't wedge the agent. The panel's "AI settings" deep-links to
`Settings → Iris AI`.

**Why not a separate config file.** Two sources of truth for one feature; Min's store already
persists, syncs to the main process, and survives updates.

---

## 13. Rebrand at the identity layer, keep Min's licence and attribution

**Decision.** New icon (vector iris/aperture, rasterised with Chromium, assembled with
`sips`/`iconutil`), new type (Space Grotesk + Inter, bundled offline), new token palette, new
two-row command bar, card tabs, new welcome page and settings section; product renamed to **Iris**
(`org.irisbrowser.iris`, `Iris.app`). English UI strings that named Min became Iris; `LICENSE`,
copyright headers and a credit line on the welcome page stay, and Min's original README moved to
`docs/UPSTREAM.md`.

---

## 14. Build/tooling notes worth remembering

- **Node 22 required for `npm install`** — Node 20.18 fails on `@electron/get`'s ESM entry.
- **`npm run build` now includes `buildLocalization`.** Localization was previously stale, which is
  why old "Min" strings survived a rename.
- **`node --test test/` does not resolve here** — always glob: `node --test test/*.test.js`.
- **Electron IPC:** in `ipcMain` handlers use `event.reply(...)`. `event.sender` is a `webContents`
  and has `send()`, not `reply()` — calling `sender.reply` threw
  `TypeError: e.sender.reply is not a function` in every handler until fixed.
- **`browserify` (renderer) vs concatenation (main):** renderer can `require('iris/...')` via
  configured paths; main's build is a concatenation, so `iris/agent/*` is required by relative path
  and globals like `settings`/`getView` are visible across files. A name collision in that
  concatenation (`webContents` declared twice) forced an `allWebContents` alias.
- **This dev VM:** OS-level `screencapture` cannot grab the display ("could not create image"), so
  all visual verification goes through Electron `desktopCapturer`.
