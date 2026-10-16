# Iris: overnight report (Oct 15–16, 2026)

Everything below was built and tested between 22:40 and 04:15 on your Mac against your Qwen server.
All code is pushed to GitHub (`Amuo007/Iris`, branch `main`); the packaged app is in `dist/app/mac-arm64/Iris.app`.

## What I built

### 1. Look-ups outside the browser (new)
- `iris/agent/lookup.js`: web search (DuckDuckGo, with Bing as a fallback), papers with abstracts and
  citation counts (OpenAlex), newest arXiv preprints, Wikipedia summaries, and the text of one public page.
- They go through an **empty, in-memory session**: never your tabs, cookies or logins. They never
  contact LinkedIn, Facebook, Instagram, X, TikTok, Threads, Snapchat or Pinterest, nor any site where Iris
  made an account for you, nor sites you list in Settings. One request at a time per site, cached for an
  hour, and bot walls ("Just a moment…") are recognised and reported instead of read.
- Smart planning uses them before the first click; during a run Iris may use a few (default 6).

### 2. Smart mode: Quick and Deep
- Smart now: questions (if the request is unclear), then look-ups, then a plan with **Start at** URLs.
- **Quick**: one round of up to 3 look-ups, light thinking for the plan. **Deep**: two rounds (up to 8),
  careful thinking, check-ins every 15 steps, twice the steps and time.
- Each step repeats the plan's goal and finish line ("Remember the plan — Goal: … | Done when: …").
- A run that is about to hit its step limit is told to report what it has; a last-steps answer is no
  longer thrown away by the "did you judge anything?" check.

### 3. Not going in circles
- Each step lists the sites already tried with the last thing Iris thought there, so it doesn't walk
  back into a login wall or a site with no results.
- A click that changes nothing gets a hint: you probably missed, zoom in or aim at the centre.
- "Verifying you are human" pages: wait up to ~10 s, else use another site, else ask you.

### 3b. Answers you can trust
- **Final-answer check**: before a long task's answer is shown, one quick call (no thinking) compares it
  with what Iris noted, thought and sees, and takes out details it never saw. The panel says what was
  left out. (Found because Iris invented train times on a booking page that didn't show them.)
- New rule: details that will leave the screen (times, prices, codes) are saved with "remember" when seen.
- A calendar hint (the coming Mondays) so weekday sums stop going wrong.
- More forgiving reply parsing: actions nested one level too deep, "remember" written as an action, and
  `"y="329` typos no longer make a step fail.
- After typing into a field with suggestions, Iris waits a moment and checks the list matches before
  choosing (Google Flights had picked "New Denver" from a stale list).

### 4. Research memory across chats
- Every keep/skip judgement is saved permanently (`iris-seen.json`). A page or search result Iris judged
  before is flagged ("you skipped this on Oct 14: …"), so research doesn't re-read the same paper.
- Look-up results are searchable with `recall`.
- Downloads: also skipped when the same file (name and size) is already in the download folder.
- PDFs: Iris knows exactly where the download button of its own PDF viewer is.
- A research run that kept 2+ things saves `Iris report - <task>.md` next to the downloads (kept items
  with links and reasons, files, the answer).

### 5. Long runs that look after themselves
- Non-stop runs: if Iris asks you something and nobody answers in 10 minutes, it skips that item and
  carries on (normal runs still wait for you).
- Repeat/Non-stop chats keep only their newest 6 follow-up messages pinned; older ones are summarised
  (they used to grow forever).
- macOS notification when Iris asks you something, waits for your OK, or finishes, but only while
  you're not looking at Iris. A Non-stop run restarting itself after an error doesn't notify.
- Non-stop tasks that say "keep going / until I stop you" carry on after the model calls it done.
- The status bar shows what a run has produced so far (kept items, files) next to its clock.
- The panel keeps at most 400 items, so a run of many hours stays fast.

### 6. Coding agents (MCP)
- `bin/iris-mcp.js` + `main/irisBridge.js`. Turn on Settings → Iris AI → Coding agents, paste the
  snippet into your coding agent's MCP config. Tools: screenshot, click, type, key, scroll, hover, drag,
  navigate, back, tabs, new/switch/close tab, find, wait. Iris's own model does not run.
- 127.0.0.1 only, secret token in a file only you can read, off by default, Iris's pointer is shown
  while a coding agent acts, and a green dot on Ask Iris says a coding agent is connected.

### 7. Skills
- **Plans that worked**: a finished Smart task keeps its plan and the sites that worked; a similar task
  later starts from it.
- **Your skills**: "when the task mentions X, do Y", written in Settings; only matching ones enter the
  prompt.
- Site tips (from before) remain.

### 8. Accounts, bookmarks
- Accounts Iris creates keep the link, page title and *why* they were made (the task).
- The agent can bookmark any URL and remove bookmarks.

### 9. Settings and UI
- New: Downloads (newest files, Show in Finder).
- New: History (search, remove, clear), Cookies & site data (per site, remove all), Look-ups,
  Smart mode default, Coding agents, Your skills, Plans that worked, Look-ups column in Usage.
- Fixed: the Quick button that ran off the panel (Smart and its level are now one control),
  descriptions aligned with headings, narrow My info fields, long skill URLs running out of the card,
  underlined history rows, the heavy content-blocking box. Checked in dark and light mode.
- Fixed: Min's "Save password?" bar was hidden behind the taller Iris toolbar and left an empty black
  gap above the page; it now shows under the toolbar in Iris colours, and is dismissed while Iris works.
- Fixed: the downloads card covered the panel's message box; it now sits left of the panel.
- New README screenshots (`docs/screenshots/agent-panel.png`, `settings.png`).

## Ideas taken from coding harnesses (Claude Code, Codex, OpenCode, Manus)

| Harness idea | What Iris does now |
| --- | --- |
| **Skills** that load only when relevant (progressive disclosure) | Site tips appear only on that site; "plans that worked" and "your skills" only when the task matches. Nothing else enters the prompt. |
| **MCP** tools | Iris *is* an MCP server for coding agents (screenshots + mouse/keyboard). Iris itself keeps a fixed tool set so the prompt cache stays warm. |
| **Todo list recited at the end of the context** (Manus) | The plan's Goal and Done-when lines are repeated on every step; check-ins every 15–20 steps. |
| **Compaction** | Old steps fold into a one-line-per-step digest in chunks (cache-friendly); the plan, the newest follow-ups, notes, decisions and files survive. With a 262K window Iris never comes close: a step is ~4–10K tokens. |
| **Memory outside the context** | Notes, a permanent research log (keep/skip), downloads, projects, `recall` search. Duplicate checks are done by code (IDs, URLs, file size), not by the model. |
| **Restorable compression** (keep URLs, drop content) | The digest and the "sites tried" list keep URLs, so Iris can go back if it needs to. |
| **Sub-agents / planner** | Smart mode's planner is a separate, screenshot-free call with its own look-ups; the final-answer check is another small call. |

## Tests

- Unit tests: 151 → **191**, all passing.
- Live (your Qwen, Balanced thinking unless noted):

| Test | Result |
| --- | --- |
| 3 remote junior frontend jobs (Smart Quick) — before fixes | failed: 40 steps, kept returning to a login-walled site |
| same — after fixes | **done**, 37 steps, 9 min, 3 verified jobs with links |
| 4 vision-only GUI-agent papers, judged + PDFs (Smart Deep) — before fix | stuck: missed the PDF viewer's download button |
| same — after fix | **done**, 14 steps, 4 min 17 s, 4 papers kept and downloaded |
| Coding-agent bridge via MCP (type, type, click on a login page) | **works**, each action < 1 s |
| Train booking (local site: autocomplete, date, seat map, upsell pop-up, cookie bar) | **done**, 12 steps, 2 min 21 s; right train, seats 2A+2B, declined insurance, stopped at payment. One misread: arrival 07:32 instead of 07:39 |
| Dentist appointment (local site: calendar, slots, chat pop-up) | **done**, 15 steps, 3 min 41 s, right day/slot and reference. Asked you for a phone number (not in My info); got confused about weekdays once → added a calendar hint |
| Cheapest one-way flight Chicago → Denver next Friday (Google Flights, Smart Quick) | **done**, 32 steps, 6 min 23 s: Frontier 6:30 AM ORD–DEN nonstop $183, checked against the screenshot. Lost time to stale autocomplete lists ("New Denver") → added a pause after typing + a rule |
| Download the latest LTS Node.js macOS installer from nodejs.org | **done**, 6 steps, 54 s, 90 MB `node-v24.22.0.pkg` |
| Amazon: USB-C hub under $30 with 4.5★, add to cart (Smart Quick) | found Anker 7-in-1 $19.99 4.5★ in 4 steps; Amazon then showed "I am human" → Iris **stopped and asked you** (correct: never solves those) |
| Train booking again, with a stale suggestion list like Google's | first try: failed on 4 malformed replies → parser fix; then **done** but with invented train times → final-answer check; last try **done**, 9 steps, 1 min 51 s, no invented details |
| Schedule: a task every 3 minutes (Tokyo time) | **fired twice on its own**, correct answers both times |
| Long Non-stop research, part 1 (34 min) | 84 steps, 20 papers kept and downloaded, **0 duplicate files**. Survived a server watchdog reset (llama-server unresponsive → model reloaded, Iris waited and carried on). Found: it re-judged one paper 55 steps later → every step now lists all judged paper IDs |
| Long Non-stop research, part 2 (new chat, 21 min) | 62 steps, 9 more kept, the cross-chat "you kept this before" warning fired; it still re-downloaded once (thought the file was missing) → the warning now says whether the file exists; it wrote long progress notes every step → told not to (Iris tracks that itself) |
| Long Non-stop research, part 3 (new chat, 30 min) | 95 steps (~13 s each, down from ~20 s once the progress notes stopped), 14 kept, 5 skipped, 0 re-judged within the chat; it re-judged 2 papers from earlier chats → earlier chats' IDs now go into the instructions up front |
| Long Non-stop research, part 4 (new chat, final build, 26 min) | 85 steps, 18 kept, 1 skipped, **0 re-judged — in the chat or from earlier chats** |
| **Final regression, 14 tasks on the final build** | **14/14 done**: date field (3 steps), hover menu, slider, confirm dialog, file upload, sign-up with email code (11 steps), GitHub trending, YouTube channel, OpenStreetMap directions (143 km, 1 h 53), Google Translate, a real form on httpbin, banana bread on allrecipes (18 steps, ads), Tokyo population/area on Wikipedia. Found one problem: on the sign-up Iris picked a country the site suggested instead of asking → rule fixed, re-checked: it now asks |
| **All parts together** | **59 PDFs, 59 different papers — zero duplicate files** over ~2 hours and 4 chats, one server reset survived |
| Long Non-stop research, run 5 (new topic: memory for LLM agents, final build, 90 min) | **225 steps, 46 kept, 1 skipped, 0 re-judged, 45 files, 0 duplicates**; memory steady at ~1.2 GB for all Iris processes; prompt stayed ~11–14K tokens |
| Follow-up chat: "find 3 good papers about agent memory that I don't have yet" (Smart Quick) | **done**, 11 steps, 3 min 40 s: 3 papers, **none of them among the 47 judged in run 5**; saved `Iris report - … .md` |
| Starting a task on a tab whose last address was a download | failed ("can't see this page") → fixed: a blank tab that isn't loading counts as empty |

## Fast vs Balanced thinking (same tasks, final build)

| Task | Balanced | Fast (no thinking) |
| --- | --- | --- |
| Weather in Chicago | 35 s | 29 s |
| Open the report from a link that opens a new tab | 58 s | 24 s |
| Date field | 39 s | 24 s |
| Slider to 75 (needs precise dragging) | 37 s, 3 steps | **1 min 40 s, 14 steps** |
| Confirm dialog | 24 s | 25 s |
| GitHub trending top 3 | 43 s | 24 s |

Fast is up to 2× quicker on simple tasks but thrashes on fiddly ones. Balanced stays the default; Fast is
fine for quick look-ups and simple forms.

## Your server (amd-halo) overnight

- At 00:14 and 00:31 Iris lost the server for about a minute; at 00:31 Lemonade's watchdog reset an
  unresponsive llama-server and the model was unloaded. This happened while **two** Iris windows were
  sending screenshots at once (I was running two test suites in parallel). Iris waited, the next request
  reloaded the model, and the runs carried on by themselves. I went back to one agent at a time.
- My guess: memory. The server was already near its limit (model ~94 GB + KV cache for 262K + up to
  8 GB of prompt cache). The `--cache-ram 2048` change we discussed would leave more headroom. I did
  not change anything on the server.
- Ping from the Mac to the server was 20–110 ms all night (Wi-Fi); a cable would make each step a bit faster.

## Blocked / needs you

- **Paying with a saved card** — refused twice by my safety checks; not worked around. See ON-HOLD.md.
- **Test project clean-up** — the jobs tests ran inside the "Harness research" test project (dev
  profile) and replaced its plan. Restoring the plan was refused as an irreversible change. A backup of
  that profile's project files is in my scratchpad. The plan to restore is in the chat
  `mv6rrjbl-a0fdya` (the "find 3 more good ones" chat). All later tests run in a separate test profile.
- All tests after 23:30 used a separate test profile and a scratch download folder (59 PDFs + the
  Node.js installer). Your real Iris profile was not used.
- Files the early tests downloaded into your real `~/Downloads`: `2608.24848v1.pdf`, `2601.05787v2.pdf`,
  `2606.29705v1.pdf`, `2610.05185v1 (1).pdf` (a duplicate). Later tests download into a scratch folder.

## How to try it

1. Open Iris, press **Ask Iris**.
2. Switch on **Smart** (bottom right of the panel); click **Quick** to change it to **Deep**.
3. Try: *"Find 4 good 2026 papers about web agents that act only from screenshots. Judge each by
   its abstract, download the PDFs of the ones you keep."* You'll see the look-ups, the plan, ✓ Kept
   notes, the downloads, and at the end a report file `Iris report - … .md` in Downloads.
4. Settings → **History**, **Cookies & site data**, **Look-ups**, **Skills** (Your skills, Plans that
   worked), **Coding agents**.
5. Coding agents: turn it on, press **Copy**, paste into your coding agent's MCP config (Claude Code:
   `.mcp.json` or `claude mcp add`), restart the agent, then ask it to "take a screenshot with Iris".

## Where Iris still falls short (honest list)

- **Small targets.** It sometimes misses small buttons by a few pixels (a chat pop-up's ×, a calendar day).
  The hint after a missed click and `zoom` help; it recovers, but it costs steps.
- **Weekday and date sums.** Better with the calendar hint, not perfect.
- **Lenient judging on broad topics.** On "memory for LLM agents" it kept 46 of 47 papers it opened;
  its search already filters, but a stricter "Good result means" would make it more selective.
- **Bot checks.** Amazon's "I am human" box, Indeed's Cloudflare wall: Iris stops and asks you (or
  uses another site). That is deliberate.
- **Sites that hide details behind sign-ups** (job boards). Iris works around them by reading
  listing cards, or by using another board.
- **Speed.** About 7–12 s per step with Balanced thinking on your server; Smart Quick planning adds
  15–35 s, Deep about 1–1.5 min. Fast (no thinking) is ~5 s per step but makes more mistakes.
- **Things Iris cannot see**: Min's own bars ("Save password?"), native right-click menus.
- **One bridge per Mac.** If the dev build and the packaged app both run, only the first one can
  serve coding agents (the second says so in Settings).
- The last fix (never guess personal details) was re-checked on a fresh profile: Iris asked "What country should I select?".

## Next steps I'd suggest

1. Decide on payments (ON-HOLD.md) and email notifications (needs a sending account).
2. Let Iris create throwaway accounts on sites that hide details behind a sign-up, when a task allows it.
3. Try Fast thinking for simple tasks automatically (navigation, typing) and Balanced for reading pages.
4. Package and sign the app with a valid Apple certificate (yours has expired; builds are ad-hoc signed).
