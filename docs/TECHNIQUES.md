# How Iris works — every technique, in plain words

One entry per technique: **what it does**, **before**, **now**, **how** (the actual steps), and the
**result** we measured. The model (Qwen on your Lemonade server) is the brain: it looks at a
screenshot and says what to do. Everything below is Iris's own code — the hands, eyes and memory
around that brain. Most speed and accuracy gains come from here, not from the model.

Updated 2026-10-16.

---

## The basics

### 1. Seeing and acting like a person
- **What:** each step, Iris takes a screenshot of the tab, sends it to the model, and carries out
  the model's answer with real mouse and keyboard events.
- **How:** `webContents.capturePage()` makes the screenshot (JPEG, longest side 1280 px). The
  answer is a small JSON (`{"action":{"type":"click","x":412,"y":388}}`). Iris turns it into real
  input events (`sendInputEvent`) — the same events a mouse and keyboard produce. It never runs
  code inside the page.
- **Why it matters:** sites see trusted input, not script. Nothing in the page can tell the
  difference from a person using the browser.

### 2. Screenshot pixels → page pixels
- **What:** the model answers in pixels of the screenshot; the page uses CSS pixels.
- **How:** Iris keeps the screenshot size, the page size and the screen's pixel ratio, and converts
  every coordinate (`coordinateMapper.js`). On a Retina screen 1280 screenshot px ≈ 1000 CSS px.

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

### 6. "Did my last action do anything?"
- **What:** after each action, a 32×20 grey thumbnail of the page is compared with the last one.
- **How:** if nothing changed, the next step is told so ("you probably missed: zoom in or aim at
  the centre"), so the model does not repeat the same miss.

### 7. Zoom
- **What:** the model can ask for a 2× close-up of part of the page to read small text before
  clicking. Coordinates in the close-up are mapped back to the page.

### 8. Find on page
- **What:** Cmd+F, used the way a person does: jump to "Directions", "Price", "Apply".
- **Fix today:** the first search on a page that has only just loaded sometimes got no answer
  from the browser; Iris now asks once more after 2 s.

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

### 20. Using your own LaTeX resume
- **How:** Iris finds each `\section`, the command that starts every entry (e.g.
  `\resumeSubheading{…}{…}{…}{…}`), and the bullet command (`\resumeItem{…}`). It works out which
  argument is the title, company, dates, location (dates and places by pattern, titles by role
  words, schools by "University/College"), marks the template with comments, and reads your
  content into the profile. **Check:** each section, refilled with its own content, must read the
  same as before; any section that does not is left exactly as you wrote it.
- **Result:** a Jake-style resume: Education, Experience, Projects and Skills all mapped.

### 21. Applying
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
- `bin/iris-mcp.js` gives a coding agent 29 tools: screenshot, click (with the aiming of 4), type,
  keys, scroll, zoom, tabs, upload, dialogs, look-ups, bookmarks, My info (placeholders only),
  accounts, downloads, the career profile, building a resume from its own picks (3.4 s, no model
  in Iris), and the applications log. Iris's own model does not run, so your server only ever
  serves one model call at a time.
