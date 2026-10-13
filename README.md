# Iris

**Iris is an agentic web browser for macOS.** You can use it as a normal browser, and when
something is tedious you describe the outcome you want and Iris drives the page for you —
step by step, in a side panel you can watch, pause, or take over at any time.

Iris is built on [Min](https://github.com/minbrowser/min) (Apache-2.0), which provides tabs,
tasks, history, bookmarks, search, content blocking and settings. Everything above that layer —
the visual identity, the agent, the panel, the safety gates — is new.

![Iris running an agent task](docs/screenshots/agent-panel.png)

---

## Quick start

### Run from source (development)

```bash
# Node 22 is required to install dependencies (Node 20 breaks @electron/get's ESM install)
export PATH=~/.nvm/versions/node/v22.19.0/bin:$PATH

npm install
npm run build
npx electron . --development-mode
```

### Run the packaged app

```bash
npm run buildMacArm           # -> dist/app/mac-arm64/Iris.app  (+ dist/app/iris-v<version>-mac-arm64.zip)
open dist/app/mac-arm64/Iris.app     # or drag it into /Applications and launch from the Dock
```

The package is ad-hoc signed (`codesign -s -`), which is fine for your own machine. It is not
notarised, so if you copy it to another Mac, allow it once in *System Settings → Privacy &
Security*.

### Watch the agent work without a model server

Iris ships a scripted model so the whole pipeline can be exercised offline:

```bash
IRIS_FAKE_MODEL=1 IRIS_AUTODEMO=1 IRIS_AGENT_DEBUG=/tmp/iris-agent.log \
  npx electron . --development-mode
```

`IRIS_FAKE_MODEL=1` swaps the HTTP client for `iris/agent/fakeModel.js`, which performs the same
`observe → think → act` conversation a real vision model would have. `IRIS_AUTODEMO=1` starts a
demo task ("click the middle of the page, scroll down, then stop") on launch so you can see the
timeline without typing. The real model server is never contacted by any test.

---

## Using Iris

| What | How |
| --- | --- |
| Open the Iris panel | `⌘⇧Space`, or the **Ask Iris** button |
| Run a task | Type what you want and press Enter |
| Continue the chat | Reply after a run ends; Iris keeps the context. **+** starts a new chat |
| Past chats | The clock button: reopen any saved chat and continue it |
| Pause / resume / stop | Buttons in the status bar while Iris works |
| Take over | Click or type in the page; Iris pauses. Type a message to tell it something, or press ▶ |
| Iris asks you | For a CAPTCHA, a phone code or a missing detail, Iris pauses and asks; type the answer |
| Thinking | **Fast** (no thinking) · **Balanced** · **Careful** · **Deep** |
| Run | **Once** · **Non-stop** (no step or time limit, resumes itself after errors) · **Every 15 min … every day** |

Each step shows what Iris did, why, and the screenshot it decided from (click the thumbnail).

![Iris panel after a task](docs/screenshots/agent-panel.png)

### What Iris can do

Iris works like a person: it looks at a screenshot of the tab and uses the mouse and keyboard.
It never runs scripts inside the sites you visit.

- **Pages:** click, double-click, hover, drag, scroll, type (replaces the field's text), keys,
  ⌘A/C/V/X/Z, find on page (⌘F), zoom into a small area before clicking
- **Several actions per step:** fill a whole form in one go
- **Tabs:** follows links that open new tabs, closes ad pop-ups, switches and opens tabs
- **Browser UI pages cannot draw:** dropdowns are drawn inside the page so Iris can see them;
  alert / confirm / prompt dialogs and the file picker are answered like a person would
- **Downloads** go straight to `~/Downloads`; **uploads** pick from your recent files
- **Accounts:** logs in with **My info**, or signs up when you allow it; with permission it opens
  your inbox to read a verification code; every account it creates is listed in Settings
- **Memory:** notes and a downloaded-files list survive long runs; old steps are compacted in
  chunks so the server's prompt cache keeps working
- **Skills:** shortcuts it learns about a site (for example a direct search URL) are reused next time

### Settings → Iris AI

- model server (any OpenAI-compatible `/v1` URL), model, API key, thinking level
- steps and minutes per task (Once mode), seconds to wait for each answer, screenshot size
- **When a site needs an account:** log in only, or log in / sign up with My info
- **Usage:** tasks, requests, input and output tokens, time per step — today, 7 and 30 days, all time
- **Rules:** things Iris must always or never do
- **My info:** your details for forms and logins. Secret fields are encrypted with the macOS
  keychain and never shown to the model: it types `{{Password}}` and Iris fills in the real value
- **Accounts Iris created**, **Skills**, and a **Schedule** for tasks that start on their own

![Iris settings](docs/screenshots/settings.png)

---

## How the agent works

Iris is deliberately **vision-only**. The model gets screenshots and nothing else; actions are
real operating-system input events, not DOM calls.

```
                 ┌──────────────────────────────────────────────┐
                 │                  agent loop                  │
  goal ────────▶ │  1. OBSERVE   screenshot + page state         │
                 │  2. THINK     model call (vision in, JSON out)│
                 │  3. ACT       strict parse → input events     │
                 │  4. VERIFY    did the page change as claimed? │
                 └──────────────────────────────────────────────┘
                          │            │            │
                     safety gate   marker overlay  timeline → panel
```

**See.** `webContents.capturePage()` for the tab; on macOS that is unreliable for a
`WebContentsView` (it can hang or reject with a viz error before first paint), so Iris falls back
to grabbing the window's composited image through `desktopCapturer` and cropping it to the tab's
bounds. Screenshots are downscaled to the configured longest edge and encoded as JPEG.

**Think.** One OpenAI-compatible `chat/completions` request per step with the current screenshot,
the page URL/title, a compact history of prior steps, and the instruction. `keepImages` bounds how
many screenshots remain in context; older steps keep their text.

**Act.** Model output is parsed against a strict action grammar (`actionSchema.js`) — unknown keys,
malformed coordinates, or an out-of-range value are rejected with a specific reason, and the parser
can also recover the intent from sloppier prose-ish output. Actions: `navigate`, `click`,
`double_click`, `right_click`, `hover`, `type`, key press, hotkey, `scroll`, `drag`, `wait`,
`answer`, `done`. Each becomes a sequence of native `mouseMouseUp/mouseDown/mouseMove/keyDown/
keyUp` events (`inputPlan.js`), including modifier spellings and key codes.

**Coordinates are never guessed.** Image pixels and view CSS pixels are carried as independent
sizes (`coordinateMapper.js`), so 2×/3× Retina captures, downscaled images, and a panel that
shifts the page all map correctly. Values are clamped to the viewport, and the panel reports both
the image point and the CSS point it turned it into.

**Stop conditions.** `safety.js` answers "why did the agent stop?" with one of: step budget, wall
clock budget, per-step model timeout, retries for a step, consecutive failures, a repeated-action
loop, a blocked URL scheme/host, or a sensitive action that needs your approval. Money, credential
and destruction phrasings (`purchase`, `pay`, `checkout`, `delete`, `sign out`, `submit … otp`) are
refused by default.

**Takeover.** Input events injected by the agent are timestamped; any real user input in the page
outside that window increments a takeover counter, which pauses the run instead of fighting you.

---

## Layout of the code

| Path | What it is |
| --- | --- |
| `iris/agent/actionSchema.js` | Strict action grammar + recovery parser, human-readable summaries |
| `iris/agent/coordinateMapper.js` | Image px ⇄ view CSS px, per-axis, clamping, fit dimensions |
| `iris/agent/agentLoop.js` | observe → think → act → verify, pause/stop/resume, auto-wait on loading |
| `iris/agent/safety.js` | All stop conditions and the sensitive-action gate |
| `iris/agent/inputPlan.js` | Actions → native mouse/keyboard event sequences |
| `iris/agent/history.js` | Step history with an image budget |
| `iris/agent/prompts.js` | System/user prompt construction |
| `iris/agent/modelClient.js` | OpenAI-compatible client (fetch), timeouts, error normalisation |
| `iris/agent/fakeModel.js` | Scripted model for tests and the offline demo |
| `main/irisAgent.js` | The only Electron-facing part: `IrisComputer`, capture, injection, IPC, overlay |
| `js/iris/layout.js` | Brand, two-row command bar, shortcut, heights shared with the webview layer |
| `js/iris/omnibox.js` | Title + URL pill that focuses Min's real address input |
| `js/iris/agentPanel.js` | Side panel: goal box, controls, step timeline, settings link |
| `css/iris.css`, `css/irisAgent.css` | Design tokens and all Iris chrome styling |
| `pages/irisOverlay.html` | Transparent click-through marker window |
| `pages/welcome/index.html` | First-run welcome page |
| `test/*.test.js` | 90 unit tests for the Electron-free core |

The agent core is Electron-free on purpose: it is pure logic, so it is unit-testable in seconds and
reusable outside this browser. Only `main/irisAgent.js` touches Electron.

---

## Tests

```bash
node --test test/*.test.js      # 90 tests, no Electron, no network
npm run test:agent              # same thing, as an npm script
```

Covered: the action grammar (valid, malformed, recovered), coordinate mapping on 1×/2×/3× and
after downscaling, every safety stop, input planning for clicks/typing/keys/scrolls/drags, the
fake model, and the loop itself (happy path, pause, stop, retry, verification, blocked actions).
No test ever talks to a real model server; `test/fakes.js` supplies scripted computer and model
doubles.

---

## Branding and attribution

Iris' look is independent: its own icon (`icons/source/iris.svg`, rasterised by Chromium via
`scripts/renderIcon.js`, assembled by `scripts/buildIcons.js`), its own typography (Space Grotesk +
Inter, bundled in `ext/fonts/`), a violet-to-cyan token palette (`--iris-*`), a two-row glass
command bar, card tabs, and an Iris-specific welcome and settings surface. Min's `LICENSE`,
copyright notices and attribution remain in place, and the welcome page credits Min as the
foundation.

## Known limitations

See [REPORT.md](REPORT.md) for the honest status list: what is verified on a real Mac, what is
verified only by unit tests (because it needs a real vision model), and what is queued next.

## License

Apache-2.0, same as Min. See `LICENSE` and `docs/UPSTREAM.md`.
