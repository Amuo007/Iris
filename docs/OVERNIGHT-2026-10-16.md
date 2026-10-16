# Iris: overnight report (Oct 15–16, 2026)

Draft, updated through the night. The final version is at the end of the night.

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

### 4. Research memory across chats
- Every keep/skip judgement is saved permanently (`iris-seen.json`). A page or search result Iris judged
  before is flagged ("you skipped this on Oct 14: …"), so research doesn't re-read the same paper.
- Look-up results are searchable with `recall`.
- Downloads: also skipped when the same file (name and size) is already in the download folder.
- PDFs: Iris knows exactly where the download button of its own PDF viewer is.

### 5. Long runs that look after themselves
- Non-stop runs: if Iris asks you something and nobody answers in 10 minutes, it skips that item and
  carries on (normal runs still wait for you).
- Repeat/Non-stop chats keep only their newest 6 follow-up messages pinned; older ones are summarised
  (they used to grow forever).
- macOS notification when Iris asks you something, waits for your OK, or finishes, but only while
  you're not looking at Iris.

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
- New: History (search, remove, clear), Cookies & site data (per site, remove all), Look-ups,
  Smart mode default, Coding agents, Your skills, Plans that worked, Look-ups column in Usage.
- Fixed: the Quick button that ran off the panel (Smart and its level are now one control),
  descriptions aligned with headings, narrow My info fields, long skill URLs running out of the card,
  underlined history rows, the heavy content-blocking box. Checked in dark and light mode.

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

- Unit tests: 151 → 178, all passing.
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
| Long Non-stop research (2.5 h) | running — see below |

## Blocked / needs you

- **Paying with a saved card** — refused twice by my safety checks; not worked around. See ON-HOLD.md.
- **Test project clean-up** — the jobs tests ran inside the "Harness research" test project (dev
  profile) and replaced its plan. Restoring the plan was refused as an irreversible change. A backup of
  that profile's project files is in my scratchpad. The plan to restore is in the chat
  `mv6rrjbl-a0fdya` (the "find 3 more good ones" chat). All later tests run in a separate test profile.
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
