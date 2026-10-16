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
- **Adaptive thinking.** Mechanical steps (click the download button, scroll, type into a known field)
  don't need thinking; reading and judging pages do. Switching to "off" for the mechanical ones could
  make research loops ~30% faster. Needs a reliable way to tell the two apart.
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
- **Job alerts.** A scheduled daily run ("find new matching jobs and apply") with the per-day limit is
  already possible with Schedule + Jobs; a one-click "every morning" toggle in Settings → Jobs would
  make it obvious.
- **Answers learned from forms.** When a form asks something new and you answer it (ask_user), offer to
  save the answer in Settings → Jobs → Answers so the next form fills it alone.
