# How Iris works — every technique, in plain words

One entry per technique: **what it does**, **before**, **now**, **how** (the actual steps), and the
**result** we measured. The model (Qwen on your Lemonade server) is the brain: it looks at a
screenshot and says what to do. Everything below is Iris's own code — the hands, eyes and memory
around that brain. Most speed and accuracy gains come from here, not from the model.

Updated 2026-10-16 (evening).

---

## The basics

### 1. Seeing and acting like a person
- **What:** each step, Iris takes a screenshot of the tab, sends it to the model, and carries out
  the model's answer with real mouse and keyboard events.
- **How:** `webContents.capturePage()` makes the screenshot (JPEG, longest side 1024 px — 1280 until
  Oct 16, see 1b). The
  answer is a small JSON (`{"action":{"type":"click","x":412,"y":388}}`). Iris turns it into real
  input events (`sendInputEvent`) — the same events a mouse and keyboard produce. It never runs
  code inside the page.
- **Why it matters:** sites see trusted input, not script. Nothing in the page can tell the
  difference from a person using the browser.

### 1b. A smaller screenshot (changed today)
- **Why:** each step's model call is mostly the server reading the prompt and the new screenshot; the
  screenshot is the biggest fresh part.
- **Test:** the 10-task regression suite at 1280 and at 1024 px (server to itself), plus the
  Greenhouse- and Lever-style applications at 1024.
- **Result:** the same 35 steps and 10 / 10 passed; model call median 9.0 → 7.8 s, mean 10.1 → 8.2 s;
  fresh tokens per call 1,413 → 994. Both applications at 1024: every field right (tick boxes too).
  Research (the 5-hour task, first 12 minutes, fresh profile): call median 10.1 → 8.6 s; 55 steps,
  20 kept, 15 PDFs (at 1280: 52 steps, 15 kept, 11 PDFs) — titles, IDs and abstracts still read fine.
- **Now:** 1024 px is the default. A stored 1280 (the old default) moves to 1024 once; a size you choose
  later in Settings → AI is kept.

### 2. Screenshot pixels → page pixels
- **What:** the model answers in pixels of the screenshot; the page uses CSS pixels.
- **How:** Iris keeps the screenshot size, the page size and the screen's pixel ratio, and converts
  every coordinate (`coordinateMapper.js`). On a Retina screen 1024 screenshot px ≈ 1000 CSS px.

### 3. Several actions in one step
- **What:** the model can send a list (`"actions":[…]`, up to 6) when it can see everything it
  needs — e.g. fill a whole form.
- **How:** Iris runs them in order and stops early after anything that changes the page (opening
  a link, uploading a file), because the next action would be planned on a stale picture.
- **Result:** a 4-field form in 1 step instead of 4 (each step is ~7–12 s of model time).

---

## Accuracy

### 4. Aiming with the pointer's shape (new today)
- **What:** a click that lands a few pixels beside a link, button or text field moves onto it.
- **Before:** the model's aim is close but sometimes 3–10 px off on small targets (icons, "×",
  small links). The click hit empty space, the page did not change, and a whole step (7–12 s) was
  spent trying again — often more than once.
- **Now:** before clicking, Iris moves the pointer to the spot and looks at the **pointer's shape**,
  which the browser reports for real mouse moves: a **hand** over links and buttons, an **I-beam**
  over text fields, the plain **arrow** elsewhere. If it shows the arrow, Iris checks 8 points on
  small circles around it (3, 6 and 10 px) for the nearest hand or I-beam and clicks there instead
  (2 px further in, so not on the edge). That is what a person does: move until the hand appears.
- **Safety rules:** never when the step says it is clicking a checkbox, radio button, dropdown,
  slider, map or image (those show the arrow on purpose — a checkbox next to a "Terms" link must
  not become a click on the link); and never when clickable things are found on **two sides**
  (the aim was between two buttons: guessing could hit the wrong one).
- **No model involved:** this is pure Iris code, ~30 ms per look, only when the aim missed.
- **Result** (252 clicks aimed deliberately 0–9 px off at 36 small targets):
  without it 160 would hit; with it **229 hit**, 0 checkbox slips, 1 wrong target (a toolbar with
  4 px gaps). Small "×" buttons: 12/42 → 42/42.

### 4b. A red ✕ where a click did nothing (new today)
- **What:** if a click changed nothing on the page, the next screenshot has a small red ✕ drawn
  exactly where the click landed, with a note saying so.
- **Why:** the model then *sees* how far off it was and corrects in one go, instead of guessing
  again. Research calls this closed-loop grounding (e.g. "LookAgain", 2026); doing it with a drawn
  mark costs no extra model call. Not drawn on zoomed close-ups.

### 5. Dropdowns in one step (new today)
- **What:** a "Select…" dropdown is filled by typing its option, not by opening it.
- **Before:** click to open the list (1 step), look, click the option (another step). Lists that
  opened upwards covered other fields and confused the model.
- **Now:** the rule tells the model to type the **option's own words** into the dropdown
  (`{"type":"type","text":"Yes","clear":false,"enter":true}`); typing picks the matching option,
  Enter confirms. It can fill text fields and dropdowns of a form in one list.
- **A lesson:** the first wording let the model type its *own* answer ("Canadian citizen") —
  nothing matched and it took 27 steps. Saying "the option's own words, not yours" fixed it.
- **Result:** one job application: 21 steps / 5:43 → **11 steps / 2:45**.

### 5b. Enter never sends a form early (fixed today)
- **Found in a live test:** after the dropdown rule, the model also typed `1` into the "years of
  experience" box **with Enter** — and Enter in a text box sends the whole form. The application
  went out without the "Ask me first" pause.
- **Now:** the rule says Enter only picks a dropdown option or runs a search, never in a form's
  text box. And with "Ask me first", Enter in a form pauses too, unless the step says it is a
  search or a dropdown pick (dropdown picks are typed with `clear:false`).
- **Retest:** the form was filled completely and Iris stopped at "Submit Application" — nothing sent.

### 5c. Lists that search as you type (Greenhouse-style forms, tested today)
- **The test:** a local copy of a Greenhouse application form — type-to-search dropdowns, a city and a
  school list that load after you type ("Loading…" for 0.6 s), an "Attach" button that opens a hidden
  file chooser, range answers ("Less than 1 year", "1-2 years"), voluntary self-identification.
- **Found:** (1) Enter came 8 ms after the last letter, while the list still said "Loading…": nothing
  was picked, and a click planned in the same step landed on the open list ("Toronto, Ohio" chosen).
  (2) For "years with an RTOS" the model typed `1`; the first option containing "1" was "Less than
  1 year" (wrong — FreeRTOS since Jul 2025).
- **Now:** (1) a dropdown pick (`clear:false` + Enter) waits 1.2 s before Enter, as a person waits for
  the list; searches keep a 150 ms pause. (2) Options that are ranges or numbers: open the list first
  and type the whole option; if the field shows another option than meant, pick again. Years with a
  skill are counted from the dates of the jobs that mention it.
- **Result:** run 1: 20 steps, one wrong answer. Run 2 (range rule): every field right, RTOS "1-2
  years". Run 3 with the pause: see the day report.

### 5e. Where the clicks landed (new today)
- **Found:** a "select all that apply" list of 8 tick boxes, 25 px apart. Six clicks in one step landed
  a row off (Rust and Zephyr instead of C and Python); fixing them by guessing again took 9 steps,
  since every click toggles. Pointer-shape aiming cannot help: tick boxes show the plain arrow.
- **Now:** after a step with two or more clicks, the next screenshot shows a small blue ring where each
  click landed (hollow, so the page shows through), with a note: check each is on the option you meant;
  a tick box clicked twice is unticked again. Anything that moves the page in between (scroll, key,
  navigation, a close-up) drops the rings, since they would be in the wrong place.

### 5d. Replies that are almost JSON (new today)
- **Before:** a reply like `{"thought":"the list shows "Toronto, Ontario" first", …}` — quotes the model
  forgot to escape inside its own sentence — was refused and the model asked again (a lost step,
  7–30 s). Same for `"x":295,y":828` and `"x":141,896`.
- **Now:** after a plain read fails, Iris repairs: a double quote ends a string only where JSON can go
  on after it (a colon, a comma and the next value, a closing brace); any other one is text and is
  escaped. A key that lost its opening quote gets it back; a lone number after x becomes y.
- **Result:** of 16 replies refused as broken JSON in today's logs (1,886 model calls), 15 now parse.

### 6. "Did my last action do anything?"
- **What:** after each action, a 32×20 grey thumbnail of the page is compared with the last one.
- **How:** if nothing changed, the next step is told so ("you probably missed: zoom in or aim at
  the centre"), so the model does not repeat the same miss.

### 6b. Menus that open on hover (new today)
- **Before:** after clicking an item in a hover menu, the pointer stayed on the menu, the menu stayed
  open over the result, and Iris clicked the item again and again to "make sure" (9 steps, 5:24).
- **Now:** one rule: a hover menu stays open while the pointer rests on it; if it covers what you need
  to see, move the pointer to an empty spot — do not click the item again.
- **Result:** the same task in 4 steps, 2:33 (one run).

### 7. Zoom
- **What:** the model can ask for a 2× close-up of part of the page to read small text before
  clicking. Coordinates in the close-up are mapped back to the page.

### 8. Find on page
- **What:** Cmd+F, used the way a person does: jump to "Directions", "Price", "Apply".
- **Fix this morning:** the first search on a page that has only just loaded sometimes got no answer
  from the browser; Iris now asks once more after 2 s.
- **The real cause (found this evening):** Electron's `findNext` option means "start a new search
  session" when true — not "find the next match". Iris sent `false` for every new search, so Chromium
  took it as a follow-up to a session that did not exist and never answered; finds only worked when some
  earlier search happened to be open. On a recipe page Iris then scrolled up and down past the directions
  for 8 steps (22 steps, 3:36). Now a new search starts a session and a repeat goes to the next match:
  every find answers at once, right after a page loads too (Wikipedia, allrecipes). The same recipe
  task: **10 steps, 1:16**.

---

## Speed

### 9. Server prompt cache: fixed part first, changing part last (new today)
- **What:** your server (llama.cpp) remembers the start of the last prompt and skips re-reading it
  if the next prompt starts the same way.
- **Before:** Iris's instructions sat at the very top and included things that change during a run
  (the list of jobs handled so far, a project's latest notes). When they changed, the start of the
  prompt changed, so the server had to re-read everything: a normal step took ~7 s, the step after
  logging an application took **22.6 s** (log: `cached=0`).
- **Now:** the instructions are split. The **stable** part (rules, your profile, how to apply) opens
  the prompt and never changes during a run. The **live** part (jobs handled, today's count,
  project notes) is attached to the newest screenshot at the end.
- **Result** (the same 7-job board run, 47 steps): the server re-read the whole prompt only on
  step 1. Before, it had to after every job logged (that step took 22.6 s instead of ~7 s). Every
  ~8 steps it still re-reads the conversation part once, when Iris forgets older steps in a chunk
  (technique 11) — by design, and much cheaper than every step.

### 9a. The summary of older steps sits where the cache keeps it (found in the 5-hour run)
- **Found:** in the long run, of ~11,500 prompt tokens per step only ~5,000 were reused; ~6,500 were
  read again every step (about 22 s per step). The 40-line summary of steps Iris had forgotten rode on
  the newest screenshot, so ~2,000 tokens of it were re-read each time although it only changes when
  Iris forgets another chunk of steps.
- **Now:** that summary is a message right after the task and plan. It changes only when a chunk of
  steps is forgotten — which changes the prompt right there anyway — so between those times the server
  reuses it from its cache.
- **Result:** measured after the 5-hour run (section in the day report).

- **Measured after the move (same task, 35 minutes, server to itself):** cached part 51 % → 70 %,
  tokens read fresh per step 4,754 → 2,524. The cache now grows step by step and starts over only when
  a chunk of old steps is forgotten (every 6–8 steps); before, the summary rode on the newest step and
  was read fresh every time.

### 9b. One model call at a time, across every Iris window (new today)
- **What:** two copies of Iris (or Iris plus a test copy) never send your server two requests at
  the same time — that is what made llama-server stop answering on Oct 16 at 00:31.
- **How:** before each request Iris creates a small lock file for that server
  (`$TMPDIR/iris-model-<server>.lock`) holding its process ID and a timestamp it refreshes every
  30 s. A second Iris finds the file, shows "Waiting for another Iris window to finish with the
  model…", and retries every 0.25 s. A lock whose owner quit, or that was not refreshed for 90 s,
  is taken over, so a crash can never block Iris forever.

### 10. Only the newest screenshot is sent
- **What:** older screenshots are replaced by "[older screenshot omitted]".
- **Why:** images are the biggest part of the prompt; the model acts on the current page anyway.

### 11. Forgetting in chunks
- **What:** when the conversation gets long, Iris drops the older half of the steps at once (and
  keeps a one-line digest of each) instead of one step at a time.
- **Why:** dropping one step per step would change the start of the prompt every time and defeat
  the cache (technique 9). The task, the plan and your messages are never dropped.

### 11b. Auto thinking (new today, experimental — measured: no gain)
- **What:** Settings → Thinking → *Auto*. Iris thinks (Balanced) on the first look, on a new page,
  after a miss, an error or an unusable reply, and when it has a note about the page; on routine steps
  on the same page (scrolling on, filling the rest of a form, after an upload) it answers straight away
  (Fast) — at most 4 quick steps in a row.
- **Why:** thinking costs most of each step's time but routine steps don't need it; Fast for every step
  made more mistakes (night test).
- **Result (A/B, the same application twice each, server to itself):** Balanced 11 steps 2:54 and
  12 steps 2:52; Auto 11 steps 3:04 and 11 steps 2:51 — **no gain**. The reason is in the calls: at
  Balanced this model writes only 70–100 tokens a step (it hardly thinks), and a call's 8–9 s go to
  reading the prompt and the screenshot. There is nothing for Auto to cut, so Balanced stays the
  default. Where time can still be won: the part of the prompt that is read fresh each step (75 % of
  it was cached in these runs; the new screenshot is most of the rest).

### 12. Tailoring without "thinking"
- **What:** picking what goes on a resume runs with the model's thinking off.
- **Result:** ~25 s per job instead of 50–100 s, with picks just as good in our tests
  (Settings → Jobs → Tailoring has "Careful" if you want it).

---

### 12b. Weekdays are read, not computed (new today)
- **Before:** the prompt listed the coming Mondays; the model still had to count ("next Friday is
  Mondays + 4 days") and sometimes got it wrong.
- **Now:** the prompt lists the next 14 days with their weekdays ("Sat Oct 17, Sun Oct 18, …"),
  plus later Mondays, and says "read weekdays from this list, never work them out."

### 12c. A higher bar when everything gets kept (new today)
- **Before:** on broad research topics Iris kept almost every paper it opened (46 of 47 in one run):
  "related to the topic" was enough.
- **Now:** after 10 or more judgements, if 85 % or more were kept, Iris is told (once every 15
  judgements) to keep only what clearly meets every point of its plan's "Good result means" and is
  strong on its own, and to skip what is merely on the topic, surveys, or small variations.
- **Result (same research task, 35 minutes):** 72 judged, 50 kept (69 %) — the 5-hour run with the old code
  kept 97 %. 10 of 10 kept before the first note, 40 of 62 (65 %) after it.

## Memory

### 13. Notes that survive
- The model can add `"remember": "…"` to any step; notes are shown on every later step and survive
  forgetting (technique 11).

### 14. Never the same paper or job twice
- Every judgement (kept/skipped, with paper IDs) and every download is logged. When Iris opens a
  page it judged before — in any chat — the first line it reads is "STOP — you already judged
  this". Downloads of the same file (same ID, URL, or name and size) are skipped by code.
- Jobs: every application is logged with its link; the same posting reached by another link
  (tracking parameters, "/apply" suffix) is recognised.

### 15. Learned shortcuts, plans that worked, your skills
- Site tips the model learns ("this search URL goes straight to results"), plans of finished Smart
  tasks, and instructions you write — each shown only when the task is about that site or topic.

---

### 15b. A long run stays flat in memory (fixed today)
- **Found in the 5-hour run:** the browser window's memory grew about 0.2 MB per step. The panel shows
  the newest 80 steps and hides older ones, but it still held each hidden step's record — with its
  screenshot (a few hundred KB of image data).
- **Now:** when steps are hidden, their records and look-up rows are let go too.
- **Result:** 300 steps with screenshot-sized images: 119 MB → 36 MB in the window after a garbage
  collection (that is the 80 visible steps). History still has every step on disk.

## Look-ups (quick text searches outside the browser)

### 16. A separate, empty browser session
- **What:** for planning, Iris can search the web, papers, arXiv and Wikipedia, or read one public
  page, as text — without using your tabs.
- **How:** a separate in-memory session with no cookies or logins. Never LinkedIn, Facebook,
  Instagram, X, TikTok, Threads, Snapchat, Pinterest, or sites where Iris made you an account.
  One request at a time, 1.5 s between requests to the same site, results cached for an hour.
- **Measured today (22 look-ups):** normal web searches 0.7–2 s with relevant results; papers and
  arXiv 0.4–1.5 s; Wikipedia 3–4.5 s; public pages 0.05–1.6 s.
- **Fixed today:** when DuckDuckGo refused, Bing results came back as Bing redirect links — now
  decoded to the real addresses. `site:` searches (e.g. `site:jobs.lever.co …`) only keep results
  from that site (Bing ignores `site:` for simple clients and returned unrelated pages).
  DuckDuckGo gets a second try after 2.5 s before falling back.
- **Limits:** Reddit now needs a login to read threads, so look-ups cannot read Reddit (search
  results still show Reddit threads; Iris can open them in its own browser tab). Search engines
  refuse bursts of automated queries (DuckDuckGo Lite, Mojeek and Brave all did during testing),
  so look-ups stay a few per task.

---

### 16b. More look-ups that work (added this evening)
- **Standalone, as before:** an empty session with none of your logins or cookies; never LinkedIn, Facebook,
  X or a site with an account saved in Iris. No tricks to avoid detection — only sources that answer plain
  requests.
- **New:** Hacker News discussions (`hn`, its public search API); Workday boards searched and Workday/Ashby
  postings read (their public JSON); a search for one job board keeps other boards' postings when that board
  has none; Reddit through `site:reddit.com` searches (Reddit itself refuses requests without a login, and
  adding the word "reddit" brought dictionary pages on Bing).
- **Measured (16 look-ups about Reddit, X, job postings and everyday facts, same network, alternating):**
  before **7 / 16**, now **13 / 16**. Still failing: some `site:` searches neither search engine answers for a
  plain request (X above all — almost nothing there is visible without logging in).

## Jobs (new today)

### 17. The career profile ("bank")
- Everything you have done: skills in groups, every job with every bullet, projects, education,
  certifications — far more than fits on a page. Settings → Jobs → Career profile.
- Saved only on your Mac (user-only file).

### 18. Tailoring: the model picks, code checks
- **How:** the model gets the job's requirements and the bank with IDs (E1 = a job, E1.3 = its
  third bullet, P2 = a project). It answers with IDs in order of relevance, a fit score 0–100, and
  optional rewordings.
- **The checks (code, not the model):**
  - unknown IDs and skills are dropped; a bullet of one job cannot be moved to another;
  - a reworded bullet is **undone** if it adds a number, a tool or name, or more than two new
    content words that are not in that job's own bullets ("…through low-power design
    optimizations" was caught and undone);
  - a summary with numbers is refused (they are easy to twist: "crashes reduced by 99.6%" when
    the bank said "99.6% crash-free");
  - a short work history stays complete (a missing job reads as a gap).
- **If the model fails:** Iris ranks bullets by words shared with the posting, so a resume is
  still made.

### 19. Exactly one full page
- **How:** Iris fills the LaTeX template, builds it with pdfLaTeX (no shell access, 45 s limit) and
  reads two numbers from the log: pages, and how full the last page is (a `\pagetotal` probe at
  the end). Too long → cut the least important thing (the longest bullet list first, projects
  before jobs) and build again; room left → add the next best bullet or project while it fits.
- **Result:** 0.37 s per build; tailored resumes came out at 91–98 % of one page.
- **Fixed today — the right PDF:** every build writes the same `resume.pdf`. When the last "add one
  more bullet" try ran onto page 2, Iris kept the 1-page layout but copied the 2-page PDF on disk.
  Now each build's PDF bytes travel with that build's result, and the PDF saved is the one of the
  layout kept. (All 32 PDFs made today were checked with pdf.js: one page each, so it had not hit
  yet; a unit test now forces the case.)

### 20. Using your own LaTeX resume
- **How:** Iris finds each `\section`, the command that starts every entry (e.g.
  `\resumeSubheading{…}{…}{…}{…}`), and the bullet command (`\resumeItem{…}`). It works out which
  argument is the title, company, dates, location (dates and places by pattern, titles by role
  words, schools by "University/College"), marks the template with comments, and reads your
  content into the profile. **Check:** each section, refilled with its own content, must read the
  same as before; any section that does not is left exactly as you wrote it.
- **Result:** a Jake-style resume: Education, Experience, Projects and Skills all mapped.
- **Also read (added today):** Awesome-CV (`\cvsection`, `\cventry{…}{…}{…}{…}{\begin{cvitems}…}`,
  `\cvskill`) and moderncv (`\cventry` with the bullets inside its last argument, `\cvitem` skills),
  comments between arguments, and a lone city ("Ottawa") as the place. The header gives your name, email,
  phone and links, so the PDF is named after you. Tested through Settings: import → profile filled
  (3 jobs, 2 projects, 26 skills, 18 bullets) → a tailored resume in the imported layout.
- **Anything else:** sections Iris cannot follow stay as written; you can add markers by hand
  ([RESUME-TEMPLATES.md](RESUME-TEMPLATES.md)).
- **Your resume's own files (fixed today):** the `.cls`, `.sty`, fonts and pictures next to your
  resume are copied into a `files/` folder. Before, they sat next to Iris's marked-up copy, so a file
  of yours called `template.tex` (common in Overleaf downloads) replaced it. Copying is capped at
  80 files / 60 MB, the files the build needs go first (class, styles, a `fonts/` folder), and PDFs
  last — picking a resume straight out of a busy Documents folder no longer copies every PDF in it.

### 20b. Paste anything into the profile (new today)
- **What:** Settings → Career profile → "Add from text": paste an old resume, notes or an export;
  the model sorts it into skills, jobs, projects, education, extras and contact details.
- **Check:** the model is told to copy your words; code then drops any bullet whose content words
  are not ≥70 % in the pasted text, any number that is not in it, and any skill not in it.
- **Test:** a messy pasted resume → 2 jobs with their exact bullets, 2 projects, education,
  a certification and 2 languages; nothing invented.

### 20c. Cover letters (new today)
- **What:** `cover_letter` writes three short paragraphs (170–230 words) for one job from the
  profile, and builds a PDF next to the tailored resume; Iris uploads it when a form requires one.
- **Check:** every sentence that brings in a number, a tool or a name the profile does not have is
  taken out (the job's own company and title are allowed). Availability and location come only from
  your saved answers. "99.6 %" is not mistaken for the end of a sentence.
- **Test:** a job requiring a cover letter file: resume + letter made and uploaded, the site received
  both PDFs.

### 20d. Finding jobs: search in the browser, then read whole boards at once (new today)
- **Before (real boards):** look-ups were refused by search engines, so Iris guessed company board
  addresses from memory (Shopify, Spotify, Coinbase… mostly dead ends) and scrolled through boards with
  100+ openings: 20 minutes, 1 posting.
- **Now:** companies are found with a web search **in the browser tab** (a real browser, like a person);
  board addresses are never guessed. Then a **jobs look-up** reads that company's whole board in one
  request — Greenhouse, Lever and Ashby publish every opening as a public list for embedding on other
  sites — and returns the openings matching the role and place words (Ramp: 163 → 2 in 0.18 s).
- **Result (same task, real boards, sharing the server with the 5-hour run):** 3 real Toronto postings
  (Tenstorrent) read and tailored in 15 minutes, no forms opened.
- **Workday boards (added this evening):** a Workday board (e.g. 1,746 openings at NVIDIA) is searched
  through the site's own JSON search instead of its slow page. Workday wants every word to match, and a
  place often does not ("firmware Toronto" finds 0), so with no hits Iris drops words from the end and
  ranks the results by them instead. The look-up says what it ranked by.

### 20e. Filling spare room by relevance (fixed today)
- **Before:** when the model's picks left room on the page, Iris added the remaining bullets in profile
  order — a low-level C++ job got three Android-internship bullets while the skills section had two groups.
- **Now:** everything that could still go on the page is ranked by the words it shares with the posting:
  the model's own extra picks first, then matching bullets and skill groups, then matching projects;
  unrelated things only at the end.

### 20f. Answers learned from you (new today)
- When a form asks something only you know (a driver's licence, willingness to travel) Iris asks you;
  your answer is saved under Settings → Jobs → Answers with the form's own question, and the next form
  with that question is filled without asking. **Test:** asked once on job 1; job 2 filled it alone.
- "Do you have X?" for a professional credential the profile does not show (clearance, certification,
  degree) is answered "No"; personal facts are never assumed.

### 21. Applying
- **The posting's own words (new today):** Iris sees one screenshot at a time. By the time it called
  `tailor_resume`, the must-haves had scrolled away and its summary invented some ("JTAG", "Zigbee",
  "1+ years" where the posting said 2+) and dropped others (Python). Now (a) it saves must-haves with
  `remember` in the same reply as the scroll, and (b) when the posting's link can be read without the
  browser — a plain request in the empty look-up session, never LinkedIn and the like, never a site
  you have an account on — the page's text (up to 8,000 characters) goes to the tailoring next to the
  summary. Pages that need JavaScript, or whose text does not name the job, give nothing and are skipped —
  except Ashby and Workday postings, which are built by JavaScript but read from the same public JSON
  the page itself loads (Ashby's posting API, Workday's `/wday/cxs/…` endpoint). Checked on real
  postings: Greenhouse (Anthropic), Lever (Palantir), Ashby (Ramp), Workday (NVIDIA).
- **Years with each skill (new today):** "How many years have you worked with an RTOS?" was answered
  "Less than 1 year" because Iris only saw job titles and dates, not which job used FreeRTOS. Code now
  counts, for every skill in the profile, the dates of the jobs whose title or bullets mention it
  (overlaps once) and gives Iris the table ("FreeRTOS 1.3, STM32 1.3, Python 0.3 …").
- **Every log names its own job (fixed today):** logging a job ruled out from the list ("skipped:
  Senior PM") right after making a resume for another one gave the skipped job the other job's link,
  fit and resume, and cleared the job in progress — so its application was never logged, and its link
  now read "skipped". Now each job Iris makes a resume for is remembered with its own link, fit and PDF;
  a log by title gets that job's details; a job with no resume gets none; and any job with a resume but
  no log is pointed out on the next resume and after each log.
- **The new resume replaces the old one (fixed today):** a Workday-style site that remembers you showed
  the morning's resume already attached, under the same file name, and Iris kept it — the application
  went out without the resume tailored for it (checked by file size: 95,569 bytes sent, 95,495 made).
  Now Iris always uploads the tailored PDF, also over one that is already there; and an application
  logged as sent without that upload is flagged in its record and in the run's summary. Retest: the
  old file replaced (95,259 bytes = the new PDF), 11 steps, 2:32.
- **The answer ends with the records (new today):** a jobs run's final answer gets "From the
  Applications list (this run): Applied (2): …; Needs you (1): … — <reason>; Skipped (1): …" built by
  code from the log, because the model's own summary once gave the wrong reason for a *needs you* job.
- **Boards you name are the only ones (new today):** after finishing the two boards in the task, Iris
  went on to another board it had learned about. When the task names boards or links, it now finishes
  there.
- **Fit and years (new today):** the model rated a "3+ years on AWS" job 85 for a person with about 1.9
  years of work — while listing the years as missing. Now code reads the most years a posting asks
  for ("3+ years", "at least 5 years", "2-4 years", "3 years of experience"; "around for 10 years" is
  not a requirement), adds up the person's years from the job dates (overlaps once, internships
  included), and caps the fit: 65 when a year or more short, 50 when two or more. (A prompt rule
  "missing years keep it at 60 or below" was tried first and dropped: the model then gave 60 for a
  0.1-year gap, and with a cutoff of 60 Iris talked itself into skipping. The resume note now also says
  plainly when a fit is at or above the cutoff.)
- **When Jobs mode is on (fixed today):** only for job hunting. Before, any task with "apply" or
  "resume" in it switched it on — "apply the coupon at checkout" or "resume the download" would
  have got the job instructions and the pause before submitting. Now it needs job words around them
  ("apply … roles", "find … jobs", "a job in Toronto", "tailor my resume", "cover letter"); "papers
  about job scheduling", "the role of …" and "apply the admin role" stay out; "go through the openings …
  and apply" counts (a job word before "apply" — missed for an hour after the first fix, caught by a
  live run). 24 sentences in a unit test, and every task given to Iris today sorted correctly.
- Read the posting → `tailor_resume` → skip if below your cutoff (default 60) → fill from My info
  and your saved answers → upload "resume" (Iris picks the PDF it just made; long paths were
  mistyped once) → submit (or wait for your OK if you chose "Ask me first") → `log_application`.
- **Non-stop runs:** when only you can finish (a CAPTCHA that stays, a login, a missing file),
  Iris marks it **Needs you**, notifies you, and goes to the next job instead of waiting 10 minutes.
- **Results on the test board:** 7 openings in 3:18 (13 steps): no re-applying, poor fits skipped
  (Staff Frontend: fit 15), a job wanting a transcript marked Needs you without submitting.

---

### 21b. Sign-up with an email confirmation (tested today)
- **Flow:** fill the sign-up form (secrets typed from placeholders) → the site says "check your
  email" → Iris opens your inbox (the "Email inbox URL" in My info, if "Let Iris open my email"
  is on) in a **new tab**, signs in with your saved details if needed, opens the newest message from
  that site, clicks the link → records the account in Settings → Accounts → closes the mail tab.
- **Test:** a local fake site (Acme Notes) and a local fake webmail (Postbox): **11 steps, 1:53**,
  account confirmed. (I did not sign in to your real Gmail; with Gmail signed in inside Iris, it
  works the same way.)

### 21c. Workday-style applications (tested today)
- The hardest common flow: **create an account → confirm it by email → sign in → 4 pages**
  (My Information, My Experience with the resume upload, Application Questions with four required
  dropdowns, Voluntary Disclosures with a required "I certify…" checkbox) → Review → Submit.
- **First try:** account, email confirmation and sign-in worked (12 steps); then dropdowns cost 2–3
  steps each (the option list opened *upwards*, over the questions above it, and clicks seemed not to
  take), a question the profile already answers ("relocate to Toronto?" — the profile lives in Toronto)
  was asked, and the wait for that answer used up the 20-minute budget.
- **Fixes:** waiting for you no longer counts against Iris's time; an open option list is picked by
  typing the option and Enter (it always goes to the open box, wherever the list is drawn); what follows
  from the profile ("I already live there", years from job dates) is answered, not asked.
- **Second try:** signed in with the account it had made, kept the saved pages, answered all four
  questions, ticked the declaration, reviewed, submitted — **14 steps**, every field correct.

- **From scratch (with per-site passwords, below):** create account with a new password made for
  that site → confirm by email (inbox signed in with your own mail password) → account saved → signed in
  with the saved account → 4 pages → submitted: **30 steps, every field correct**, account stored
  encrypted.

### 21d. A strong password for every new sign-up (new today)
- **Before:** every sign-up used your one password from My info — job hunting on Workday means one
  account per company, so one leak would open all of them.
- **Now:** for a sign-up the model types `{{New password}}`. At typing time Iris makes a 20-character
  password (letters, digits, symbols almost every site accepts) for that one site — the same one again
  for "confirm password" — and saves it encrypted with the account in Settings → Accounts. The model
  never sees it. Saved accounts are listed in Iris's instructions with `{{account:site}}` placeholders,
  so the next visit logs in with them. Your inbox still uses your own password.

### 21e. Waiting for you is not Iris's time (fixed today)
- A question, an approval or a takeover pauses the run; that time is now added back to the task's
  time budget, so a 20-minute task is 20 minutes of Iris working, however long you take to answer.

## Safety

### 22. Pauses that cannot be talked around
- Payments pause before the paying click once card details were typed; with "Ask me first",
  submitting an application pauses for your OK. These checks are code that reads the step's own
  words ("Submit application"), not something the model can skip.

### 23. Secrets the model never sees
- Passwords and other secrets in My info are typed by Iris from placeholders like `{{Password}}`;
  saved account passwords as `{{account:site.com}}`. The model and coding agents only ever see the
  placeholder.

---

## Coding agents (MCP)

### 24. Iris's hands for your coding agent, no second model
- `bin/iris-mcp.js` gives a coding agent 30 tools: screenshot, click (with the aiming of 4), type,
  keys, scroll, zoom, tabs, upload, dialogs, look-ups, bookmarks, My info (placeholders only),
  accounts, downloads, the career profile, building a resume from its own picks (3.4 s, no model
  in Iris), and the applications log. Iris's own model does not run, so your server only ever
  serves one model call at a time.
