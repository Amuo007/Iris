# Iris — Plan

Iris is an AI web browser for macOS built on [Min](https://github.com/minbrowser/min) (Apache-2.0).
Min keeps tabs, tasks, history, bookmarks, search, filtering, settings and session restore.
Everything else in this plan is new: a **vision-only, input-only AI agent**, and a **complete visual
redesign**.

---

## 1. Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Electron main process  (main.build.js)                                  │
│                                                                         │
│  main/irisAgent/agentBridge.js      privileged side of the agent         │
│    ├─ capture      tab.webContents.capturePage()  → PNG + dpr           │
│    ├─ inject       tab.webContents.sendInputEvent() real mouse/key evt  │
│    ├─ state        page-load / focus / bounds of the target tab         │
│    └─ overlay      sends action events to the UI window for the marker  │
│                              │ ipc 'iris-agent:*'                       │
└──────────────────────────────┼──────────────────────────────────────────┘
                               │
┌──────────────────────────────┼──────────────────────────────────────────┐
│ Renderer: browser UI window  │                                          │
│                              ▼                                          │
│  js/iris/agentPanel.js   AI side panel (right drawer)                   │
│  js/iris/actionMarker.js  visible click/type/scroll marker overlay      │
│  js/iris/agentState.js    step timeline, pause/stop/take-over controls  │
│  css/iris.css             the whole Iris design system                  │
└─────────────────────────────────────────────────────────────────────────┘
                               ▲ require() at runtime (Electron-free)
┌──────────────────────────────┴──────────────────────────────────────────┐
│  iris/agent/  — pure core, NO Electron/DOM imports, unit tested         │
│    actionSchema.js    strict action grammar, parse + validate           │
│    coordinateMapper.js screenshot px ⇄ page CSS px (Retina/scroll)      │
│    agentLoop.js       observe → think → act → verify loop               │
│    safety.js          max steps, budget, repeated-action, human stops   │
│    prompts.js         system prompt / action-spec text                   │
│    history.js         observation history, image budget, compaction      │
│    modelClient.js     OpenAI-compatible chat-completions client          │
└─────────────────────────────────────────────────────────────────────────┘
                               ▲
                     test/*.test.js  (node:test, FakeModel)
```

**Why the core is Electron-free.** The interesting logic — the loop, the parser, the
coordinate maths, the stop conditions — must be testable with a fake model and a fake
"computer" without launching Electron. So the core talks to two injected interfaces:

```js
createAgent({ model: FakeModel, computer: FakeComputer, safety, onEvent })
```

* `model.next({ task, history, screenshot }) -> string` — a raw model message.
* `computer.screenshot() -> { dataUrl, width, height, devicePixelRatio, url, loading }`
* `computer.act(action) -> { ok, error }`
* `computer.state() -> { loading, url, focusLost, stopped }`

`main/irisAgent/agentBridge.js` is the only file that knows about Electron.

**Why the loop lives in the main process.** The model call is an HTTPS `fetch` to a
user-supplied server; doing it in the main process avoids CORS/CSP interaction with the UI
window's `script-src 'self'` and keeps the whole privileged surface (capture + input) in one
place. The renderer never receives a token or makes the call.

### Data flow for one step

1. `agentLoop` asks `computer.screenshot()`.
2. `history` trims to the image budget, builds the chat messages.
3. `model.next()` returns a message; `actionSchema.parse()` coerces it.
4. Bad output → a correction message is appended and the step is retried (max 2 retries),
   otherwise it becomes a `retry`/`fail` outcome (never a crash).
5. `coordinateMapper` converts screenshot pixels → page CSS pixels.
6. `computer.act()` injects real `sendInputEvent`s.
7. `agentLoop` waits for the page to settle (`did-stop-loading` / idle timeout), then loops.
8. Every one of those events is emitted to the panel so the user watches it happen.

### Agent action vocabulary (strict format)

The model must answer with exactly one JSON object, no prose, no markdown fence:

```json
{"thought": "one sentence", "action": {"type": "click", "x": 512, "y": 300}}
```

| type | fields | notes |
|---|---|---|
| `click` | `x`,`y` | screenshot px, top-left origin |
| `double_click` | `x`,`y` | |
| `right_click` | `x`,`y` | |
| `drag` | `fromX`,`fromY`,`toX`,`toY` | interpolated mid-points |
| `scroll` | `x`,`y`,`direction`,`amount` | direction `up\|down` |
| `type` | `text` | types at current caret, char events |
| `key` | `key`,`modifiers?` | named keys + ctrl/alt/shift/meta |
| `shortcut` | `keys` | e.g. `cmd+l` |
| `wait` | `ms?` | for pages still loading |
| `navigate` | `url` | opens a URL in the tab (typed as a real navigation) |
| `done` | `answer?` | terminal |
| `fail` | `reason` | terminal |

Parser is deliberately forgiving about *framing* (fences, leading prose, single quotes,
trailing commas, `Thought:` prefix) and ruthlessly strict about *semantics* (unknown type,
missing coordinate, out-of-range coordinate, non-finite number → rejected + correction
prompt). Recovery ladder: extract fenced JSON → extract first balanced `{...}` → coerce
types → reject.

### Coordinate mapping (accuracy)

The screenshot returned by `capturePage()` is in **device pixels** (`dpr = 2` on Retina);
`sendInputEvent()` expects **CSS pixels** relative to the view. The mapper is a single pure
function, `screenshotSpace ⇄ cssSpace`, carrying `imageWidth/imageHeight` vs
`viewWidth/viewHeight` independently (so a downscaled image works too), plus optional
content-translation for future support. All tests assert round-trips and the 2× case
explicitly (e.g. image 2880×1800 for a 1440×900 view → exact halves, clamped, rounded).

### Safety stops

* `maxSteps` per task (user setting, default 25).
* Wall-clock budget + per-step model timeout.
* Identical-action loop detection (same action N times → pause and ask).
* Blocked destinations: `chrome://`, `file://` writes, permission prompts, downloads.
* **User always wins**: `Esc` in the panel = pause; the Stop button halts within one step;
  any real user input in the page (mouse move/click/keydown) auto-pauses the agent —
  "take over". A "User takeover" banner appears and Resume re-arms it.
* Marker overlay shows exactly where the next click lands before/while it happens.

---

## 2. UI redesign (Iris must not look like Min)

Min's identity: 36 px flat grey navbar, tabs inline with the address bar, Carbon icon font,
system font, blue-ish `#0f4d90` accent, square panels. All of that goes.

**Layout**
* Row 1 — **command bar**: brand mark, back/forward/reload, a *centred pill* address+search
  field with a gradient focus ring and inline site-permission chip, then
  `✦ Ask Iris` agent button, menu.
* Row 2 — **floating tab strip**: rounded "card" tabs, 8 px radius, drop shadow, gradient
  active tab, close button on hover, drag handle texture, per-task accent line. Height 44 px.
  This 2-row structure alone changes the entire proportion of the window.
* **AI drawer** on the right, 380 px, translucent material, opens over a dimmed scrim and
  *shrinks the web view* (via `webviews.viewMargins`) so the page is never occluded and
  click mapping stays exact.
* Bottom-centred floating **find-in-page** pill, floating download shelf with rounded cards,
  restyled task overlay as a full-screen blurred board, restyled settings/password/bookmark
  managers through shared tokens.

**Design tokens** (`css/iris.css`, all `var()` driven, `body.dark-mode` overrides them)
* Light: surface `#f6f5fb`, card `#ffffff`, ink `#171426`, accent gradient
  `#7c3aed → #2563eb`, iris blue `#4f46e5`, success `#0d9488`, warn `#d97706`, danger `#e11d48`.
* Dark: surface `#0b0a12`, card `#151322`, ink `#ece9f7`, same accents lifted, hairline
  `rgba(255,255,255,.08)`, aurora backdrop glow behind the brand.
* Radii 8/12/18/999, elevation shadows, 150 ms cubic-bezier easing everywhere.

**Typography** — bundled *Space Grotesk* (headings/UI) + *Inter* (body) as local woff2, with a
distinct tabular numeral setting for the address bar. Replaces Min's system-font look.

**Icons** — new inline-SVG brand mark (an iris/aperture) and new agent glyph; icon font glyphs
kept only where Min's JS hard-references them, but restyled (size, weight, pill hit-targets).

**App icon** — generated `icon.icns` from the new iris SVG (violet aperture on dark gem),
plus `icons/` PNGs; `productName: Iris`, bundle id `org.irisbrowser.iris`.

---

## 3. Delivery order

1. Vendor Min, keep LICENSE, verify build + launch. ✅
2. `iris/agent/` pure core + tests green (fake model, fake computer).
3. Electron glue: capture, input injection, IPC bridge, marker overlay, side panel UI.
4. Design system + rebrand (css/iris.css, index.html restructure, fonts, icons, app icon).
5. Settings (model URL, model name, max steps, temperature, screenshot quality) persisted
   in Min's existing settings store, exposed in a new "Iris AI" settings page.
6. Visual QA loop: launch, `desktopCapturer` screenshots, inspect, fix.
7. `npm run buildMacArm` → ad-hoc signed `Iris.app` that launches from the Dock.
8. README + report + push to `origin`.

## 4. Test plan (all offline, no calls to the real model server)

`node --test test/` with a `FakeModel` (scripted message queue) and `FakeComputer`
(records injected actions, fakes loading states, returns synthetic screenshots):

* action parsing: valid, fenced, prose-wrapped, single-quoted, missing fields, unknown type,
  NaN coords, out-of-bounds, wrong-case type, `done`, multiple-json-in-one-message.
* coordinate mapping: 1×, 2× Retina, 0.5× downscale, clamping, rounding, round-trip,
  drag endpoints, scroll anchor.
* agent loop: happy path to `done`, step cap, retry-on-bad-output, wait-on-loading,
  pause/resume mid-run, stop, user-takeover pause, terminal `fail`, image-budget trimming,
  no-call-after-stop.
* safety: max-steps, budget, loop detection, blocked scheme, marker payload emitted.
