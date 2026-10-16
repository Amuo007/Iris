# Iris — ideas

Ideas for later. Not built yet.

## Notify me when Iris needs me

When Iris gets stuck on something only a person can do — a CAPTCHA ("I'm not a robot"),
a code sent to my phone, a question it has to ask — it should **send me an email** (or a phone
notification) so I know to come back and take over, instead of the task silently waiting.

- Say what it needs and on which site, e.g. "Iris needs you: CAPTCHA on example.com".
- Include a link or a short way back to the paused task.
- Useful most for long Non-stop and scheduled runs when I'm away from the computer.

## Things noticed overnight (Oct 16)

- **Browser bars Iris cannot see.** Iris sees only the page. Min's own bars ("Save password?", site
  permission requests) and native right-click menus are outside its screenshot. They don't block pages,
  but Iris could be told about them (for example "Min asks whether to save this password: ignore it").
- **Date picking.** The model is weak at weekday arithmetic. *Done Oct 16:* it now reads the next 14
  days with their weekdays from the prompt.
- **Partial answers on hard real sites.** Job boards and shops hide details behind sign-ups. With
  "log in or sign up" on, Iris could create a throwaway account on such sites when the task allows it,
  then record it under Accounts (already supported, just not tried on real sites).
- **Research report file.** At the end of a research run, save the kept items (title, link, why) as a
  Markdown file next to the downloaded PDFs.
- **Adaptive thinking.** *Tried Oct 16 ("Auto"): no gain* — at Balanced this model already writes only
  ~80 tokens a step; the time is in reading the prompt and screenshot.
- **One agent at a time on the server.** *Done Oct 16:* a lock file per model server; a second Iris
  window waits its turn (`iris/agent/modelLock.js`).

## Ideas from Oct 16 (Jobs day)

- **Replay a learned form instead of asking the model each field ("agentic compilation").** Research
  (e.g. "Agentic Compilation: Mitigating the LLM Rerun Crisis", 2026; "Agent JIT Compilation", 2026)
  records the action sequence of a repetitive task once and replays it, asking the model only when the
  page differs. For Iris: Greenhouse/Lever/Ashby application forms look the same at every company, so
  after one successful application the field order could be replayed with screenshot checks between
  groups — maybe 11 steps → 4. Needs care: a replay must stop the moment the page looks different.
- **Iterative zoom for tiny targets.** Zoom-in grounding (AdaZoom-GUI, "Zoom Consistency", 2026) is
  more accurate but costs a model call per click. Iris now snaps near-misses with the pointer shape and
  marks missed clicks with a red ✕; zoom refinement could be added only for repeated misses.
- **Job alerts.** *Done Oct 16:* "Every day" in Settings → Applying.
- **Answers learned from forms.** *Done Oct 16:* answers you give during an application are saved with a
  short label and used on the next form.

## Ideas from the evening of Oct 16

- **Posting text from Workday.** Workday postings are built by JavaScript, but each tenant has a public
  JSON endpoint (`/wday/cxs/<tenant>/<site>/job/<path>`) with the description — the same trick as Ashby.
- **Tick-box lists in one look.** Six tick boxes 25 px apart is the hardest target left. Clicking the
  option's text instead of the box, or a close-up before clicking, would trade one step for fewer fixes.
- **Smaller screenshots.** Each step's fresh tokens are mostly the screenshot; 1024 px instead of 1280
  could cut a step by a second or two if aim holds (being measured).
- **Bigger forgetting chunks in long runs.** The cache starts over every 6–8 steps (when half the window
  is forgotten); a 40-message window in non-stop runs would make that every ~10 steps at a cost of
  longer prompts — worth an A/B.
- **A "why not applied" view.** Applications already keep fit, focus and what was missing; a column for
  the gaps would show which skills keep costing jobs.
