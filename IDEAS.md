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
- **Date picking.** The model is weak at weekday arithmetic. It now gets the coming Mondays. A small
  "what day is <date>?" helper could make bookings safer still.
- **Partial answers on hard real sites.** Job boards and shops hide details behind sign-ups. With
  "log in or sign up" on, Iris could create a throwaway account on such sites when the task allows it,
  then record it under Accounts (already supported, just not tried on real sites).
- **Research report file.** At the end of a research run, save the kept items (title, link, why) as a
  Markdown file next to the downloaded PDFs.
