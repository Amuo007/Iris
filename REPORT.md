# Build report — Iris

## Status after the October 13 overhaul (live-tested)

Everything below was run against the real local model (Qwen3.8-Flash-Next IQ4_NL on Lemonade),
end to end through the panel, on a real Mac. 135 unit tests pass (`node --test test/*.test.js`).

| Task | Result |
| --- | --- |
| example.com → follow "Learn more", report the title | ✅ 3 steps · 23 s |
| Wikipedia: height and completion year of the Eiffel Tower | ✅ 3 steps · 28 s |
| Weather in Chicago (DuckDuckGo) | ✅ 2 steps · 17 s |
| GitHub trending, top 3 | ✅ 2 steps · 22 s |
| weather.com 10-day forecast (ad-heavy) | ✅ 5 steps · 45 s |
| timeanddate.com sunset in Paris | ✅ 6 steps · 23 s |
| allrecipes bake time (very long page, ads) | ✅ fixed from 28 steps to fewer with find-on-page |
| Ad page: newsletter overlay + pop-up tab | ✅ closed both, 5 steps · 37 s |
| Link that opens a new tab | ✅ followed it, 3 steps · 23 s |
| Follow-up in the same chat, switch back to tab 1, log in | ✅ 4 steps · 31 s |
| Log in with My info (password typed from the keychain store) | ✅ 3 steps · 24 s |
| No account → sign up → asks the user for a missing field → log in | ✅ 13 steps · 1:54 |
| Sign up → code sent by email → open inbox tab → enter code → save account | ✅ 13 steps · 1:53 |
| Native dropdown, date field, hover menu, slider, confirm() dialog, file upload | ✅ all six, 3–6 steps each |
| ilovepdf.com: upload a PDF, convert, download the JPG | ✅ 6 steps · 50 s |
| Non-stop research on arXiv, downloading PDFs | ✅ 9 papers in 10 min; survived a model-server restart |
| Same site twice (skills) | ✅ second run used the learned shortcut, 2 steps · 24 s |

Bugs found and fixed while testing live: blind capture (window matched by title), typed text came
out in capitals, mouse wheel scrolled the wrong way, Enter did not submit forms, ⌘A did nothing,
typing appended to old text, a double pause after taking over, find-on-page timing on busy pages,
prompt-cache misses from one-by-one context trimming.

Not done (blocked by the assistant's safety rules during this session, left for the owner to decide):
a saved payment card, an unattended overnight run started by the assistant, and the MCP bridge for
coding agents.

---

## Original build report (October 12)

Time-boxed build. This is the honest state: what was verified and how, what is only unit-tested,
what is not done, and what I would do next.

**Headline:** Iris forks Min (Apache-2.0, upstream merged so it can be re-merged), replaces Min's
chrome with a distinct visual identity, and adds a vision-only agent that sees the page through
screenshots and acts through real mouse/keyboard events, with a live step-by-step panel, pause /
stop / takeover, a visible on-page click marker, Retina-safe coordinate mapping, strict action
parsing, budgeted retries, and persisted settings. 90 unit tests pass; the packaged `Iris.app`
launches and ran a full agent task.

| | |
| --- | --- |
| Agent core (Electron-free) | 2,000 lines across 9 modules |
| Browser integration (main, renderer, CSS, pages) | 2,894 lines |
| Unit tests | 90 pass / 0 fail, ~0.08 s, no Electron, no network |
| Commits | 4 feature commits on top of the Min merge, all pushed to `origin/main` |
| Real model requests during development | **0** (fake model only) |

---

## Verified working (observed running)

**Browser runs, and is no longer recognisable as Min.** Two-row glass command bar (brand mark +
wordmark, grouped back/forward/reload pill, single omnibox carrying title *and* URL, task switcher,
**Ask Iris**, menu) with tab cards on a second row. Screenshots: `docs/screenshots/command-bar.png`,
`docs/screenshots/welcome.png`.

**Agent runs end to end, in dev and in the packaged app.** Log from the packaged binary:
`run:start → step:start → observation → thought → action → action:result → … → run:end done`.
The panel shows each step: the screenshot used, the thought, an action chip
(`CLICK`, `SCROLL`, `NAVIGATE`), the coordinate translation
(`Click at (784, 476) → 564, 342 css px`), and a completion summary.
Screenshot: `docs/screenshots/agent-panel.png`.

**Screenshots really are the page.** `captureWindowOf: asking desktopCapturer for 1512x901` →
`capture ok {2256x1630} scale 2 url https://example.com/`, and the thumbnails in the panel show
example.com's actual text. Both capture paths exist: `capturePage()` on the tab, and a
window-grab-plus-crop fallback that handles the macOS cases where `capturePage()` rejects with
"the page has not painted yet" or hangs (notably the New Tab Page, whose view is unattached and has
an empty URL).

**On-page click marker.** A transparent, click-through, `screen-saver`-level window paints a dot,
two expanding rings, crosshair guides and a label naming the action, exactly at the mapped point.
Verified by pixel-scanning a full-display capture taken during a live run:
`docs/screenshots/marker.png` (`Click at (784, 476)`; the scroll frame shows `×3`).

**Pause / stop / takeover wiring.** Panel buttons drive `iris-agent-pause|resume|stop`; the adapter
records injected-event windows and counts genuine human input separately (`takeoverCount`), pausing
rather than fighting the user. Loop-side pause/stop/resume and takeover stops are unit-tested.

**Safety stops.** Step budget (25), wall clock (5 min), per-step model timeout, per-step retries
(3), consecutive failures (3), repeated-action loop detection (3), blocked URL schemes
(`javascript:`, `file:`, `view-source:`, `chrome:`, `chrome-extension:`, `devtools:`, `blob:`),
and a sensitive-action gate that refuses money/credential/destruction actions unless enabled.

**Settings.** New **Settings → Iris AI** section, persisted under `irisAI`, clamped numerics, deep-
linked from the panel; the agent merges it over defaults at start and the main process broadcasts
changes (`docs/screenshots/settings.png`).

**Packaging.** `npm run buildMacArm` → `dist/app/mac-arm64/Iris.app` (+ zip), bundle id
`org.irisbrowser.iris`, own `.icns` icon, ad-hoc signed, launched and used for the agent run above.
`app.setName('Iris')` fixes the menu bar in development builds.

**Tests.** `node --test test/*.test.js` → 90/90. Covers the action grammar (valid / malformed /
recovered), coordinate mapping at 1×, 2×, 3× and after downscaling, input-event plans for
clicks/double-clicks/right-clicks/hover/type/keys/hotkeys/scroll/drag/wait, every safety stop, the
image-budget history, the fake model, and the loop (happy path, pause, stop, resume, retries,
verification, blocked actions, takeover).

---

## Built, but only verified by unit tests

These need a *real* vision model to be exercised for real, and the brief said not to call the model
server during the build:

- **Prompt quality / model compliance.** `prompts.js` and the strict schema are tested with scripted
  outputs. How reliably `Qwen3.8-Flash-Next-GGUF-IQ4_NL` emits valid actions, and whether the
  wording needs tuning, is unmeasured.
- **Verify step against real pages.** The loop asks "did the page change as claimed?" using cheap
  signals (URL, title, loading state, pixel-difference of consecutive screenshots). Fine in tests;
  on real sites it needs tuning (carousels, ads, lazy loading will produce noise).
- **`maxTokens` / image budget under real latency.** Timeouts are configured (90 s/request) and
  unit-tested with a fake clock, but never against a slow local inference server.

## Known gaps

1. **Marker is invisible to the agent's own screenshots.** macOS excludes the transparent
   click-through overlay from `desktopCapturer` window sources (confirmed: only the browser window
   appears in `getSources`). Good for clean vision, but it means the marker can only be verified
   through a full-display capture, as done here.
2. **New Tab Page polish.** The NTP inherits the Iris fonts and palette through the shared bundle
   but its layout is still Min's. Not restyled.
3. **No multi-tab agent work.** One task runs in one tab. "Open three tabs and compare prices" is
   out of scope of the current loop.
4. **Rollback.** There is stop/pause/takeover but no undo of an action already performed.
5. **Windows/Linux packaging not re-verified.** `scripts/buildMac.js` was renamed for `Iris.app`;
   `buildWindows.js`/`buildDebian.js`/`buildRedhat.js` still reference Min's icon filenames and
   `icons/icon256.ico` was not regenerated from the new vector source.
6. **No notarisation.** Ad-hoc signature only, which is fine for your own machine; a second Mac
   will need an explicit allow (or a Developer ID + notarisation step).
7. **`standard` lint not run on the new `iris/` code** (`npm test` still targets Min's globs;
   `test:agent` was added for the new suite).

## Bugs found and fixed along the way

- `TypeError: e.sender.reply is not a function` in all five IPC handlers — `event.reply()` is the
  API; `event.sender` is a `webContents` and only has `send()`.
- Main-process event loop froze on the first agent screenshot: `capturePage()` on Min's New Tab
  Page view (unattached, empty URL) never settled → desktopCapturer fallback + "not painted yet is
  not an error".
- Tab strip invisible: Min's `.is-edit-mode .tab-item { opacity: 0 }` plus
  `#navbar #tabs { flex: 1 }` (two-ID specificity) kept the strip squeezed onto row 1; fixed with
  matching specificity and `flex: 0 0 100%`.
- Whole command bar rendered 44 px above the viewport (body overflow → scroll): `#webviews` height
  still assumed Min's 36 px toolbar; now derived from `--iris-navbar-height`.
- Tab titles vanished: `.tab-item .title` is absolutely positioned, so the title container needed an
  explicit height once `align-items` changed.
- Renamed "Min" strings kept reappearing because `dist/localization.build.js` was stale —
  `buildLocalization` is now part of `npm run build`.
- `webContents` declared twice in main's concatenated bundle → aliased `allWebContents`.
- Dev tooling: `node --test test/` does not resolve here (must glob); OS `screencapture` cannot grab
  this VM's display (all verification goes through `desktopCapturer`); `npm install` needs Node 22.

## Next improvements, in order of value

1. **Drive it with the real model and tune the prompts** — collect failures (bad JSON, off-target
   clicks, wrong scrolls) and tighten `prompts.js` + recovery rules. Everything to measure this is
   already instrumented (`IRIS_AGENT_DEBUG`).
2. **Per-step verification policy per action type.** Clicks that should navigate vs. toggle vs.
   submit need different expectations; today it is one generic check.
3. **Scroll/search/list strategies.** Add "find the element matching X" primitives that scroll
   systematically and remember what has been seen, instead of hoping the model scrolls well.
4. **Approval UX for sensitive actions.** Today they are refused by default; the next step is an
   inline "Iris wants to click *Buy* — Allow once / Allow / Deny" card in the panel.
5. **Rollback / re-do.** Screenshot + action journal per step already exists; add "undo last action"
   via the page's own undo (⌘Z) or a re-type, and let a paused run fork from an earlier step.
6. **Multi-tab and background-tab work**, plus a "run this in a background tab so I can keep
   browsing" mode.
7. **Restyle the New Tab Page** and the remaining Min surfaces (task view, reader view) to Iris.
8. **Cross-platform packaging**: regenerate `icon256.ico`/installer images from the same vector
   source and re-verify Windows/Linux builds.
9. **Accessibility fallback for capture**: if a page never paints (GPU-less VMs, DRM surfaces),
   fall back to an accessibility-tree description so the agent degrades instead of stalling.
10. **Lint the new modules** (`standard` globs extended to `iris/**/*.js`) and add a CI job that runs
    `npm run build && node --test test/*.test.js`.

## How to reproduce everything here

```bash
export PATH=~/.nvm/versions/node/v22.19.0/bin:$PATH
npm install && npm run build
node --test test/*.test.js                                  # 90 tests

# dev app + scripted agent
IRIS_FAKE_MODEL=1 IRIS_AUTODEMO=1 IRIS_AGENT_DEBUG=/tmp/iris-agent.log \
  npx electron . --development-mode

# packaged app (first run shows the Iris welcome page)
npm run buildMacArm && open dist/app/mac-arm64/Iris.app
node ./scripts/buildIcons.js                                # rebuild icon.icns from the SVG
```
