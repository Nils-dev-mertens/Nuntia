# Nuntia

A chat-style mail client. Threads read like conversations, replies are composed
with the greeting, signature and quoting rules Nuntia learned from your own mail,
and Gmail stays the source of truth.

Nuntia is currently a **private beta**: sign-in is replaced by an invite, and the
operator approves people from `/admin`. The design decisions behind that (and
everything else) are in [PLAN.md](./PLAN.md); provider setup guides are in
[docs/](./docs), and the direction for shared workspaces is in
[docs/organizations.md](./docs/organizations.md).

## What it does

- Gmail and Outlook (Microsoft 365 / outlook.com) through one sync pipeline,
  merged into a single inbox.
- Deterministic rules classify each thread; **Jev** (optional, your key) scores
  importance/urgency; an **LLM** (optional, your key) names topics and drafts
  replies. Drafts are text in the composer — Nuntia never sends without you.
- Reply composition that restores the greeting and signature the parser stripped,
  with per-sender overrides.
- Attachments, contact context, organisation rules, and a beta funnel with
  first-party feedback.

## Requirements

- [Bun](https://bun.sh) 1.3+
- Node 22.12+ for tooling that expects it
- SQLite (bundled via `@libsql/client`) — no database server
- OAuth apps for Google and/or Microsoft — see [docs/google-setup.md](./docs/google-setup.md)
  and [docs/outlook-setup.md](./docs/outlook-setup.md)

## Setup

```bash
bun install
cp .env.example .env.local     # then fill in the values below
bun run dev                    # http://localhost:3000
```

The database file and its migrations are created on first boot
(`data/lumen.db`), and existing databases are migrated at startup.

### Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | yes | `file:./data/lumen.db`, or a libSQL URL |
| `TOKEN_ENCRYPTION_KEY` | yes | 32 bytes hex/base64 (`openssl rand -hex 32`). Encrypts OAuth tokens, AI keys and invite codes. Changing it makes stored secrets unreadable |
| `LUMEN_APP_URL` | in beta | Public origin used in invite links (`https://mail.example.com`) |
| `LUMEN_ACCESS_MODE` | no | `invite` (default) or `login` |
| `LUMEN_ADMIN_EMAILS` | no | Comma-separated operator addresses — break-glass access to `/admin` |
| `LUMEN_BOOTSTRAP_INVITE` | first boot | A 12-char code that may sign the first user in on an empty install. Ignored once a user exists |
| `LUMEN_INVITE_SENDER` | no | Which connected mailbox sends approval emails (defaults to the operator's first) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Gmail | OAuth app credentials |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` / `MICROSOFT_TENANT` | Outlook | Microsoft identity app |
| `GOOGLE_PUBSUB_TOPIC` / `GMAIL_PUSH_TOKEN` | no | Gmail push; polling is used without it |
| `APP_LOG_DIR` | no | Where `app.log` is written (default `data/logs`) |
| `BACKUP_DIR` / `BACKUP_KEEP` | no | Backup destination and retention (default `data/backups`, 14) |

Redirect URI for both providers in development is
`http://localhost:3000/auth/google/callback` and
`http://localhost:3000/auth/microsoft/callback`.

## The beta, end to end

1. Someone asks at `/request-access`. The answer is the same sentence whatever
   happens, so the form cannot reveal who already has an account.
2. The operator opens `/admin`, reads the note, and approves. That creates a
   single-use invite bound to the address and emails the link **from the
   operator's own connected mailbox** — no email service is involved. With no
   mailbox connected the approval still stands and the link is shown to copy.
3. `/join/<code>` creates the user with the password they choose, starts a
   session, and lands on a first-run screen: connect a mailbox, then
   (optionally) add AI keys in Settings. From then on `/sign-in` with that
   address and password is the way back in — the invite link is not needed
   again, and neither is the email it came in.
4. `/admin` shows the funnel — requested → approved → redeemed → activated →
   used → returned — plus people, invites, feedback and the AI call log.

On an empty install nobody can open `/admin`, so the first user comes from
`LUMEN_BOOTSTRAP_INVITE`: set it, visit `/join/<code>`, and that user is an
admin. Remove the variable afterwards.

`/admin/sign-in` keeps the password form even in invite mode — otherwise an
expired operator cookie would lock you out of the only page that can issue an
invite. An account created before invites asked for a password (the first admin
on an existing install, most of all) gets one from the operator:

```bash
bun run scripts/set-password.ts you@example.com 'a long enough password'
# in Docker, where the image has no source:
#   docker compose exec app bun dist/set-password.js you@example.com '...'
```

## Scripts

```bash
bun run dev              # dev server on :3000
bun run build            # client + server bundles in dist/
# production entry (deployment config is still manual):
#   bun dist/server/server.js
bun run typecheck        # tsc --noEmit
bun test                 # 590+ tests
bun run lint             # eslint
bun run format           # prettier --write + eslint --fix
bun run db:generate      # new migration from schema.ts
bun run db:studio        # inspect the database
bun run scripts/beta-report.ts            # funnel in the terminal
bun run scripts/beta-report.ts --prune    # drop declined requests older than 90 days
bun run scripts/set-password.ts <email>   # give an existing account a password
bun run scripts/backup-db.ts              # consistent database snapshot
bun run scripts/diagnose-sync.ts          # why mail is missing from the inbox
```

## Backups

Everything lives in `data/lumen.db` — including encrypted refresh tokens — so a
lost file means every user re-authenticates and re-syncs. `scripts/backup-db.ts`
writes a `VACUUM INTO` snapshot (consistent, includes the WAL), verifies it with
`PRAGMA quick_check`, and prunes to the newest `BACKUP_KEEP` files.

```bash
bun run scripts/backup-db.ts
```

Schedule it (cron example is in the script header) and keep `BACKUP_DIR` on a
different disk. Restoring is: stop the app, replace `data/lumen.db` with a
backup, start the app.

## Logging

Two files under `data/logs/`, both JSON lines, both rotated at ~1–2 MB with one
previous file kept:

- `app.log` — one line per request (`method`, `path`, `status`, `ms`) and every
  thrown handler with its message. Invite codes are collapsed to
  `/join/[code]` and query strings are dropped, so a code cannot leak into a log
  that outlives the invite. Assets and dev-server internals are skipped.
- `ai.log` — every Jev/LLM call: service, outcome, status, duration, model, URL,
  and a truncated error. No prompt, no body, no key. Readable at `/admin`; it is
  operator-only because records carry no user id.

Warnings and errors also go to stdout, so a foreground dev server or a
container's output shows them without tailing the file.

## Tests

```bash
bun test
```

The suite uses a temporary database per run (`test/setup.ts` refuses to run
against `data/lumen.db`). Coverage is heaviest where a mistake is expensive:
sync and parsing, the decision pipeline, send paths, invite redemption (every
refusal), and the access-mode gates. There is no DOM harness, so UI behaviour is
covered by typecheck plus server-side checks against a running instance.

## Layout

| Path | What lives there |
| --- | --- |
| `src/routes/` | File-based routes, including `/join`, `/request-access`, `/admin`, `/feedback` |
| `src/components/` | UI. Components may only import browser-safe modules; server-only code stays behind server functions |
| `src/lib/auth/` | Users, sessions, OAuth, per-user mailbox ownership, access mode |
| `src/lib/invites/` | Codes, invites, redemption, access requests, approval email |
| `src/lib/mailbox/`, `src/lib/gmail/`, `src/lib/microsoft/` | Provider adapters behind one `MailboxClient` seam |
| `src/lib/conversation/`, `src/lib/ai/` | Classification, drafts, Jev/LLM clients and logs |
| `src/db/` | Drizzle schema and connection; migrations in `drizzle/` |
| `scripts/` | Operator scripts (report, backup, sync diagnostics) |
