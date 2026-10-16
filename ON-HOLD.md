# Iris — on hold

Things that were asked for or considered, but are not built yet. Each one needs a decision or more
discussion first. (Ideas that are simply "later" live in [IDEAS.md](IDEAS.md).)

## Paying with a saved card

**Status:** blocked. The code that stores a card and types it into checkout pages was written twice
and both times refused by Claude's safety checks ("real-world transactions"). It was not worked around.

**What exists:** a safeguard. If a card ever reaches a checkout through My info (a secret field named
"Card number", "Card CVC", …), Iris pauses before the click that pays and waits for your OK
(`iris/agent/safety.js`, `paymentGuard`). Iris is also told it has no card: it goes as far as the
payment page, then stops and tells you.

**To decide:** if you want it, build it yourself or give Claude Code an explicit permission rule for it.
The plan was: Settings → Iris AI → Payments (Never / Ask me first / Without asking), card encrypted
with the keychain, the model only types `{{Card number}}`.

## Email me when Iris needs me

**Status:** partly done. Iris now shows a **macOS notification** when it asks you something (a CAPTCHA,
a code, a choice), when it waits for your OK, and when a task finishes, but only while you are not
looking at Iris. Clicking it brings Iris to the front.

**Still open:** a real email. It needs an email-sending account (SMTP or a service like Resend) and a
password or key for it. Decide which account it should send from.

## Solving CAPTCHAs

**Status:** never. Iris waits for "Verifying you are human" pages that clear by themselves, uses another
site when it can, and otherwise asks you. Solving CAPTCHAs automatically is how accounts get banned.

## Paid search services (Brave, Tavily, Exa)

**Status:** not needed for now. The free look-ups (DuckDuckGo with Bing as a fallback, OpenAlex, arXiv,
Wikipedia, public pages) are fast enough. A paid service could be a setting later; your searches would
then go to that company.
