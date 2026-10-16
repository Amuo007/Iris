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

## Blocked / needs you

- **Paying with a saved card** — refused twice by my safety checks; not worked around. See ON-HOLD.md.
- **Test project clean-up** — the jobs tests ran inside the "Harness research" test project (dev
  profile) and replaced its plan. Restoring the plan was refused as an irreversible change. A backup of
  that profile's project files is in my scratchpad. The plan to restore is in the chat
  `mv6rrjbl-a0fdya` (the "find 3 more good ones" chat). All later tests run in a separate test profile.
- Files the early tests downloaded into your real `~/Downloads`: `2608.24848v1.pdf`, `2601.05787v2.pdf`,
  `2606.29705v1.pdf`, `2610.05185v1 (1).pdf` (a duplicate). Later tests download into a scratch folder.
