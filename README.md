# Jobly

Multi-source job-application bot for Kenyan job boards.

This is **Phase 1**: skeleton + Career Point Kenya RSS adapter + cron poller +
SQLite storage with deduping. All other adapters (Corporate Staffing,
MyJobsInKenya, Opened Career, BrighterMonday/Fuzu/LinkedIn IMAP, Kontaken
Telegram) are listed in `config/sources.json` but disabled, and the parser /
matcher / tailor / emailer / digest pipeline arrives in Phases 2–5.

A note on the branch name: this repo lives on `claude/build-apk-gm9Md`. The
spec is a Node.js bot, not an Android APK. There are two ways to run it on a
phone, both supported here:

1. **VPS / Linux / macOS** — `npm install && npm start`, or `pm2 start ecosystem.config.js`.
2. **Android via Termux** — see [Run on Android (Termux)](#run-on-android-termux). No APK build; the bot runs as a userland Node.js process under termux-services.

## Project layout

```
jobly/
├── .env.example
├── ecosystem.config.js           # pm2 config
├── package.json
├── config/
│   ├── sources.json              # which sources are enabled + their settings
│   └── settings.json             # thresholds, target roles, locations
├── data/
│   ├── jobs.db                   # SQLite (created at runtime)
│   └── outputs/                  # tailored docs (Phase 4+)
├── src/
│   ├── index.js                  # entrypoint
│   ├── poller.js                 # cron loop + per-adapter run
│   ├── check.js                  # `npm run check` self-test
│   ├── db.js                     # better-sqlite3 wrapper
│   ├── logger.js                 # pino, daily file in logs/
│   ├── ratelimit.js              # token bucket + per-key throttle
│   └── sources/
│       ├── _base.js              # fetchHtml / fetchRss / makeId helpers
│       └── careerpoint.js        # Phase 1 reference adapter
├── scripts/
│   └── termux-setup.sh           # one-shot install for Termux/Android
├── termux/service/jobly/         # runit unit for termux-services
└── logs/                         # daily-rotated log files
```

## Quick start (VPS / desktop)

Requires **Node.js 22.13+** (Node 24 LTS recommended). No native modules — the bot uses Node's built-in `node:sqlite`, so no Python/clang/make required.

```bash
git clone <this-repo> && cd jobly
cp .env.example .env             # edit values; for Phase 1 only TIMEZONE / POLL_CRON / SCRAPER_CONTACT_EMAIL matter
npm install
npm run check                    # self-test, no network
npm run once                     # one poll cycle, then exit
npm start                        # cron loop, polls every 30 min
```

Run with pm2:

```bash
npm i -g pm2
pm2 start ecosystem.config.js
pm2 logs jobly
pm2 save                          # persist across reboots
```

## Run on Android (Termux)

The bot runs as a Node.js process inside [Termux](https://termux.dev). No APK
is built — Termux itself is the app, and Jobly runs inside it. This means you
get the same code on Android as on the VPS.

```bash
# Install Termux from F-Droid (the Play Store version is outdated). Then:
pkg install -y git
git clone <this-repo> ~/jobly
cd ~/jobly
bash scripts/termux-setup.sh
cp .env.example .env             # edit values
sv-enable jobly                  # start in the background under runit
sv status jobly
tail -f ~/jobly/logs/jobbot-$(date +%F).log
```

Battery / background gotchas:

- Android aggressively kills background apps. In **Settings → Apps → Termux →
  Battery**, set to **Unrestricted**.
- Install **Termux:Boot** (also F-Droid) if you want the bot to start
  automatically after a reboot.
- The setup script tries to acquire `termux-wake-lock`; this keeps the CPU on
  but slightly impacts battery life.
- The `t.me/s/` Telegram preview shows only ~20 most recent posts, so a phone
  that is offline for a day will miss older posts on busy channels. For
  Kontaken (~1 post/day) the default 30-min poll is fine.

## Configuration

| File | Purpose |
|---|---|
| `.env` | Secrets (Anthropic key, SMTP/IMAP creds, contact email for UA). |
| `config/sources.json` | Which sources are enabled. Career Point on; everything else off until its adapter ships. |
| `config/settings.json` | Match thresholds, target roles, locations, exclude keywords. Used by Phase 3+. |

## Verifying Phase 1

```bash
npm run check    # imports every module + opens the DB; no network calls
npm run once     # runs one poll cycle and exits with non-zero on adapter failures
sqlite3 data/jobs.db 'SELECT id, source, raw_title, posted_at FROM raw_jobs ORDER BY id DESC LIMIT 5;'
sqlite3 data/jobs.db 'SELECT source, ok, new_count, dupe_count, error FROM poll_runs ORDER BY id DESC LIMIT 5;'
```

Run `npm run once` twice in a row. The first run should report `added: N,
dupes: 0`; the second should report `added: 0, dupes: N` — that proves the
`(source, external_id)` UNIQUE constraint is doing its job.

## Generating a Gmail App Password

The bot sends application emails and the daily digest from your Gmail account
via SMTP. Google does not let third-party apps use your normal Gmail password —
you need an **App Password**, which is a one-off 16-character secret tied to
this specific use.

1. **Enable 2-Step Verification** on the Google account (required before App
   Passwords appear): https://myaccount.google.com/security → 2-Step
   Verification → ON.
2. Visit https://myaccount.google.com/apppasswords.
3. App: pick **Mail**. Device: pick **Other** and name it `Jobly`.
4. Google shows a 16-character password like `abcd efgh ijkl mnop`. Copy it
   exactly (the spaces are cosmetic — paste it without spaces into `.env`).
5. In `.env`:
   ```
   SMTP_USER=youremail@gmail.com
   SMTP_PASS=abcdefghijklmnop      # the 16 chars, no spaces
   DIGEST_TO=youremail@gmail.com   # usually same as SMTP_USER
   ```
6. App Passwords can be revoked at any time from the same page. Generate a new
   one if you ever suspect leakage; the old one stops working immediately.

If you ever see `Username and Password not accepted` from the emailer, the
most common causes are: 2-Step Verification not enabled, app password typed
with spaces, or the app password was revoked.

## Queue-only mode (recommended starting state)

`config/settings.json` ships with **`auto_apply_threshold: 99`**, which means
**no emails are auto-sent** regardless of match score. Every actionable match
gets tailored docs in `data/outputs/<date>__<employer>__<title>/` and ends up
in the queue for you to review.

To verify the docs look professional:

```bash
npm run apply             # tailor + render docs for matched jobs
npm run queue             # tabular view of what's waiting for you
ls data/outputs/          # browse the generated .docx files
```

Once you trust the output, edit `config/settings.json` and lower
`auto_apply_threshold` to `8.5` (the spec default). From then on, matches
with score ≥ 8.5 AND application_method == "email" AND no blockers will
actually send via Gmail SMTP, BCCing you on every send.

## What Phase 1 does and does not do

Does:
- Polls Career Point Kenya RSS feed on a cron schedule.
- Inserts new posts into SQLite, deduped by `(source, external_id)`.
- Records every poll attempt in `poll_runs` for diagnostics.
- Polite scraping: real `User-Agent`, 1 req/sec per host, exponential backoff on 429/5xx (max 3 retries).
- Per-adapter error isolation: a failing adapter does not stop the others.

Does NOT (yet):
- Call the Anthropic API (Phase 2 = parser, Phase 3 = matcher, Phase 4 = tailor).
- Send any email (Phase 5).
- Read IMAP mailboxes (Phase 6).
- Generate `.docx` resumes/cover letters (Phase 4).

## Adding a new source (template)

A new adapter is one file at `src/sources/<name>.js` exporting:

```js
module.exports = {
  name: 'mysource',
  type: 'rss',           // 'rss' | 'html' | 'imap'
  enabled: true,
  fetchNewJobs: async ({ logger, config }) => [
    {
      source: 'mysource',
      external_id: '<URL or hash>',
      url: '...',
      fetched_at: new Date().toISOString(),
      posted_at: '...',
      raw_title: '...',
      raw_text: '...',
    },
  ],
};
```

Then add an entry to `config/sources.json` and flip `enabled: true` once the
adapter has run cleanly for 24 h.

## Logs

- Daily file at `logs/jobbot-YYYY-MM-DD.log` (JSON lines from pino).
- Pretty-printed stdout when `NODE_ENV !== 'production'`.
- Termux service logs go to `$PREFIX/var/log/jobly/` (managed by `svlogd`).
- Production log retention belongs in Phase 7 hardening; for now use OS
  logrotate or a periodic `find logs -mtime +14 -delete`.

## License

Private project — no license declared.
