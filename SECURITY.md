# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue:

- Use **Report a vulnerability** on the repository's **Security** tab (GitHub
  private vulnerability reporting).
- If that option isn't available, open an issue that only asks for a private
  contact, without any details of the problem.

You'll get an answer within a week. Fixes land on `main` and ship in the next
`ghcr.io/ackervekenbm/skin-hq:latest` image; there are no older release lines
to patch.

## Scope and design notes

SkinHQ is built for one person on a home network. Keep that in mind when
judging impact:

- **No login of its own.** Anyone who can reach the app acts with the stored
  Steam session: they can see the inventory and create or cancel market
  listings (a new listing still needs a confirmation in the Steam Mobile app).
  Keep it on your own machine or home network; for anything reachable from
  outside, put it behind a reverse proxy with authentication and HTTPS.
- **Other websites can't use it through your browser.** The app refuses
  changes (sell, cancel, log out, sync) that a page on another site tries to
  send through your browser.
- **Steam credentials** are sent only to Steam; the password is never stored.
- **Session cookies** are encrypted at rest with `SKINHQ_SESSION_KEY`, which
  lives only in the environment (`.env`), never in the repo or the image.
- **The database** (SQLite in `/app/data`) holds the inventory, listing and
  price cache and the encrypted session.

Reports about exposing the app to the internet without authentication are
expected behaviour, not vulnerabilities; reports about leaked session cookies
or keys, decrypting the stored session without the key, or listings changed
without the owner's action in the app are very welcome.
