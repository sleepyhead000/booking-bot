# booking-bot

A portal-agnostic web booking & slot-monitoring bot: it logs into an appointment
portal, watches for availability that matches your criteria, and books it the
moment it appears.

Built with **Node.js 24 + TypeScript + Playwright**. Everything that is
portal-specific (selectors, page order, API shapes) lives in a small
**adapter**; session handling, adaptive polling, OTP entry, notifications and
anti-bot handling are shared and stay unchanged when you add a portal.

```
┌────────────┐   ┌──────────────┐   ┌──────────────┐   ┌────────────┐
│  notifier  │◄──│ BookingRunner│──►│ PortalAdapter│──►│  Chromium  │
│ console /  │   │  (core loop) │   │  (your site) │   │ (Playwright)│
│  telegram  │   └──────┬───────┘   └──────────────┘   └────────────┘
└────────────┘          │
                 ┌──────┴───────┐
                 │ session · OTP│
                 │ poller · lock│
                 └──────────────┘
```

---

## Quick start

```bash
npm install
npx playwright install chromium

cp .env.example .env          # then fill it in
cp config/applicant.example.json config/applicant.json   # then fill it in

npm run doctor                # verify the stealth surface
npm run demo &                # optional: start the bundled demo portal
npm run inspect               # authenticate + list matching slots, no booking
npm run monitor               # poll until something matches, then book it
```

### The bundled demo portal

`npm run demo` starts a local, self-contained appointment portal
(`http://127.0.0.1:4173`) with login, OTP, a calendar of slots that trickle
in over time, a file-upload form and a confirmation page. It exists so the
whole pipeline can be exercised — and regression-tested — without touching a
real site, and so you have a worked example when writing a new adapter.

Demo knobs (env vars): `DEMO_PORT`, `DEMO_FIXED_OTP`, `DEMO_SLOT_RELEASE_MS`,
`DEMO_INITIAL_RELEASES`, `DEMO_CHALLENGE=1` (injects a fake anti-bot overlay
that clears itself after `DEMO_CHALLENGE_AUTOCLEAR_MS`).

---

## Commands

| Command | What it does |
| --- | --- |
| `doctor` | Launch a browser, run the automation-detection probes, print a verdict. |
| `login` | Authenticate interactively (OTP included) and persist the session. Never books. |
| `inspect` | Authenticate and print the currently matching slots, then exit. Exit code `2` when none. |
| `run` | One pass: check availability once, book if something matches. |
| `monitor` | Poll until a matching slot appears, then book it. |
| `info` | Print the resolved config plus available adapters and solvers. |

Global flags (before or after the subcommand):

```
-c, --config <path>        config file (default: config/default.yaml)
-s, --set <path=value>     override any config value, repeatable
--headed                   show the browser window
-a, --adapter <id>         adapter to use (default from config)
--date-from / --date-to    YYYY-MM-DD window
--weekdays 1,2,3,4,5       0=Sunday … 6=Saturday
--log-level debug|info|…
--no-lock                  allow a second concurrent instance
```

Examples:

```bash
npm run dev -- inspect --headed --log-level debug
npm run dev -- monitor -s monitor.minIntervalMs=2500 -s booking.dateTo=2026-11-30
npm run dev -- doctor --url https://example.com
```

Exit codes: `0` success · `1` runtime failure · `2` nothing matched · `64` bad
configuration · `130` cancelled (Ctrl+C).

---

## Configuration

Three layers, later wins: **`config/default.yaml` → environment → CLI flags**.
Secrets never live in YAML; they are read from `.env` / the environment only.

| Source | Good for |
| --- | --- |
| `config/default.yaml` | Non-secret tuning: polling cadence, viewport, timezone, date window. |
| `.env` | Credentials, proxy, Telegram, solver keys. |
| `-s path=value` / flags | One-off experiments without editing files. |

### Secrets (`.env`)

```bash
BOT_USERNAME=            # portal login
BOT_PASSWORD=            # portal password
BOT_PROXY_URL=           # http://user:pass@host:port or socks5://host:port
TELEGRAM_BOT_TOKEN=      # from @BotFather
TELEGRAM_CHAT_ID=        # from @userinfobot
SOLVER_PROVIDER=manual   # manual | <your provider id>
SOLVER_API_KEY=
OTP_CODE=                # optional: pre-fetched one-time code (SMS hook, tests)
TARGET_ADAPTER=reference
TARGET_DATE_FROM=
TARGET_DATE_TO=
TARGET_WEEKDAYS=
LOG_LEVEL=info
HEADLESS=true
```

### Applicant data (`config/applicant.json`)

Your details, kept out of git and out of the YAML:

```json
{
  "fields": {
    "surname": "NOWAK",
    "givenName": "ANNA",
    "passport": "XA1234567",
    "email": "anna@example.com"
  },
  "documents": [
    { "path": "docs/passport.pdf", "target": "#passport-pdf" },
    { "path": "docs/photo.jpg", "target": "input[name='photo']", "mimeType": "image/jpeg" }
  ]
}
```

`fields` keys are whatever your adapter's `fillApplication` maps to (the
reference adapter uses `surname / givenName / passport / email`). `target` is
the CSS selector of the upload input for each file.

---

## OTP, when the portal asks for a code

The bot never guesses. It notifies you on every enabled channel and waits:

1. **Terminal** — type the code and press Enter (works everywhere).
2. **Telegram** — reply to the "OTP required" message with the code; the bot
   picks it up from your reply. This is how you approve a booking from your
   phone while the bot runs on a server.
3. **`OTP_CODE`** — set it in `.env` and the bot uses it directly. Useful for
   SMS-forwarding hooks and for tests.

`otp.timeoutSec` (default 180) is how long it waits; `otp.maxAttempts` (3) is
how many rejections to tolerate before giving up.

---

## Anti-bot handling

Real portals fight automation. Four layers, in order of cost:

1. **Fingerprint hygiene (free, on by default).** A pre-page-load init script
   removes the cheap tells: `navigator.webdriver`, a missing `window.chrome`,
   zero plugins, an empty `languages` list, a short `Error.stackTraceLimit`,
   a canvas noise pattern. On top of that the context claims a real Chrome UA
   for the exact Chromium build in use (no `HeadlessChrome` marker), consistent
   `accept-language`, locale, timezone, viewport and platform.
2. **`bot doctor`.** Probes all of the above against a live browser and prints
   pass/fail. Run it after any Playwright upgrade or stealth change; it is the
   smoke test for the stealth layer. Add `--url <page>` to probe a real site
   too. The E2E suite runs it as well, so a regression fails CI.
3. **Proxies.** Set `BOT_PROXY_URL` to a residential or mobile proxy. One
   browser/context per run keeps the IP-to-fingerprint association stable.
4. **Challenge resolution.** When a Cloudflare/Turnstile-style interstitial
   appears, the bot detects it (`ChallengeGuard`), notifies you, and either:
   - waits it out (the default, `solver.provider: manual` — most interactive
     challenges clear themselves), or
   - hands the task to a **solver provider** you implement.

   Only the interface ships — no paid solver is wired in, so you choose the
   trade-off. Add one in `src/solver/`:

   ```ts
   import type { SolverProvider } from '../types.js';

   export const provider: SolverProvider = {
     id: 'acme',
     async solve(task, timeoutMs) {
       const token = await callYourSolverApi({ sitekey: task.sitekey, action: task.action });
       return { provider: 'acme', token, elapsedMs: 0 };
     },
   };
   ```

   Then register it in `src/solver/registry.ts` and set
   `solver.provider: acme` (or `SOLVER_PROVIDER=acme`).

> If a site proves too aggressive, the honest answer is usually a better proxy
> and slower polling — not more stealth. `monitor.minIntervalMs` defaults to
> 4–12 s with jitter and exponential backoff on empty cycles precisely so the
> traffic does not look like a metronome.

---

## Porting to a real portal

Copy the reference adapter, rename the folder, and replace the page knowledge:

```bash
cp -r src/adapter/reference src/adapter/yoursite
```

`src/adapter/yoursite/index.ts` must export `adapter` (or default) implementing
`PortalAdapter` (`src/adapter/types.ts`). The **folder name must equal
`adapter.id`** — the session file is named after it. That's the whole
integration: the registry resolves `src/adapter/<id>/index.ts` automatically,
no core edits and no registry change required (built-ins are listed in
`src/adapter/registry.ts` only so `tsc` sees them eagerly).

```ts
export const adapter: PortalAdapter = {
  id: 'yoursite',
  displayName: 'Example appointment portal',
  baseUrl: 'https://appointments.example.gov',

  async prepare(page) {
    // Once per page: dismiss cookie banners, close popups.
  },

  async login(page, creds) { /* fill credentials, submit, wait for the next step */ },
  async isLoggedIn(page) { /* markerPresent(page, '#calendar') */ },
  async isOtpPromptVisible(page) { /* ... */ },
  async submitOtp(page, code) { /* ... */ },
  async getSlots(page) { /* scrape the calendar or sniff its API → Slot[] */ },
  async selectSlot(page, slot, timeoutMs) { /* click the slot; false if it vanished */ },
  async fillApplication(page, app) { /* map app.fields onto the form */ },
  async attachDocuments(page, docs) { /* attachAll(page, resolveDocuments(docs), verify) */ },
  async submitApplication(page) { /* submit + assert the confirmation is visible */ },
  async isChallenged(page) { return (await detectChallenge(page)) !== null; },
};
```

### Porting checklist

- [ ] **Page order.** Note every page transition (`/login → /otp → /calendar`).
      Anything that navigates after the challenge guard has run should call
      `waitForChallengeClear(page, ms)` first.
- [ ] **`getSlots` must be cheap and side-effect free.** It runs every poll
      cycle. Prefer the portal's own XHR: `ApiSniffer` (`src/monitor/api-sniff.ts`)
      captures the JSON for you — that is what the reference adapter does — and
      falls back to a DOM scrape when there is no API.
- [ ] **`Slot.id` must re-select the slot later.** Store whatever you need in
      `slot.meta` (DOM index, API id, day + time).
- [ ] **Human timing.** Use `humanType` / `humanClick` / `think` from
      `src/core/human.ts` instead of raw Playwright actions — real people do
      not type in 0 ms with zero pauses.
- [ ] **Errors.** Throw `new BotError('auth' | 'otp' | 'challenge' | 'form' |
      'config' | 'unknown', message, { retryable })` so the runner can classify
      and retry. A generic `Error` is treated as `unknown` and retried once.
- [ ] **Verify each upload** in `attachDocuments` (check the file name or a
      "1 file attached" counter) — silent upload failures are the most common
      reason a booking dies at the last step.
- [ ] **Test it** against the demo portal first (`npm run demo`), then against
      the real site with `--headed --log-level debug` and a single `inspect`.

`config/applicant.example.json` and the reference adapter are the two places
that show the expected shapes.

---

## Docker

```bash
cp .env.example .env      # fill it in
docker compose run --rm bot doctor
docker compose run --rm bot run       # single attempt
docker compose up -d bot              # long-running monitor
```

The image is a multi-stage build (`node:24-bookworm-slim` → Chromium with its
system deps). Your local `./config` is mounted read-only over the image's copy
and `./storage` holds sessions, artifacts and logs, so configuration changes
never need a rebuild. Secrets still come from `.env` via `env_file`.

Need the browser visible for debugging? `docker compose run --rm --service-ports
bot run --headed` on a machine with a display, or use VNC/X11 forwarding.

---

## Testing

```bash
npm test           # unit + end-to-end (real headless Chromium)
npm run lint
npm run typecheck
```

The E2E suite boots the demo portal in-process and drives the **real** core
through it: session restore, OTP, adaptive polling, slot selection, form fill,
PDF attach and submit — plus a second run with `DEMO_CHALLENGE=1` that proves
the bot detects an anti-bot interstitial, refuses to click through it, waits it
out and still completes the run. `bot doctor` is asserted to pass inside the
same suite, so stealth regressions fail the build.

---

## Project layout

```
config/            default.yaml + applicant.json (your data, gitignored)
demo/              self-contained demo portal + sample PDF generator
src/
  adapter/         the multi-portal seam
    types.ts       PortalAdapter contract
    registry.ts    loads src/adapter/<id>/index.ts
    reference/     worked example (drives the demo portal)
  config/          schema (zod), loader, applicant file
  core/            browser, stealth, session, human timing, auth/OTP,
                   challenge guard, doctor, runner (the loop)
  documents/       PDF/doc upload helpers
  monitor/         slot filter, adaptive poller, XHR sniffer
  notify/          console + Telegram + fan-out hub
  otp/             terminal / Telegram / env code acquisition
  solver/          solver provider interface (+ manual implementation)
  util/            logging, retry, errors, lockfile, artifacts
  cli.ts           commander entry point
test/              vitest unit tests + Playwright E2E
storage/           runtime state: sessions, logs, artifacts (gitignored)
```

---

## Notes & caveats

- **Respect the portal's terms and rate limits.** Polling defaults are
  deliberately gentle; do not point this at a site that forbids automation.
- **Secrets** stay in `.env` (gitignored). `config/applicant.json` holds
  personal data and is gitignored too — keep it out of screenshots and issues.
- Logs are written to `storage/logs` with credentials, tokens and document
  paths redacted.
- A lock file (`storage/*.lock`) prevents two instances booking the same slot
  at once; `--no-lock` opts out.
- Sessions persist to `storage/sessions` for `session.maxAgeMinutes`
  (12 h by default) so a monitor run does not re-login on every restart.
