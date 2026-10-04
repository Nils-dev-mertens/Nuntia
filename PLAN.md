# Lumen — MVP Plan

Chat-style Gmail client. Read email like chat, send email like email. Gmail stays the
source of truth; Lumen is a presentation + composition layer.

---

## Stack

| Layer             | Choice                                                                                            | Rationale                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Framework         | TanStack Start 1.x (`1.168.60`, v1 stable)                                                        | Server Functions keep OAuth tokens + Gmail calls off the client. Requires Node >= 22.12.                                    |
| UI                | React 19                                                                                          | Hard requirement from ReUI.                                                                                                 |
| Styling           | Tailwind CSS v4                                                                                   | Hard requirement from ReUI.                                                                                                 |
| Components        | **ReUI registry over shadcn/ui**                                                                  | See "ReUI notes" below. Radix UI as the primitive layer (ReUI ships both Radix and Base UI variants; Radix is more mature). |
| DB                | SQLite via **`@libsql/client`** + Drizzle ORM                                                     | Single-user, local-first. **Changed from the original `better-sqlite3`** — see below.                                       |
| Auth              | Google OAuth 2.0, refresh token AES-encrypted at rest                                             | Gmail is the only provider in MVP.                                                                                          |
| Mail              | `googleapis` — `threads.get`, `messages.attachments.get`, `history.list`; inbox polling           | Gmail API is the source of truth. Push watch is not implemented in the MVP.                                                 |
| AI decisions      | `DecisionLayer` interface; rule-based/no-op implementation for MVP, structured-output LLM planned | See "Deviations".                                                                                                           |
| AI generation     | LLM API, invoked on demand only                                                                   | Phase 2. Draft-only, never auto-send.                                                                                       |
| Runtime / tooling | bun 1.3.10, TypeScript 6.x (`^6.0.2`)                                                             | Matches the `forma` project conventions.                                                                                    |

### Why libSQL instead of better-sqlite3

`better-sqlite3` is a native node-gyp module. Installing it on this machine fails:

```
gyp ERR! find VS could not use PowerShell to find Visual Studio 2017 or newer
gyp ERR! Could not find any Visual Studio installation to use
```

Visual Studio 2022 is present but without the "Desktop development with C++" workload, so
there is no VC++ toolset to link against. `@libsql/client` ships prebuilt binaries for the
same SQLite dialect and talks to a local `file:` URL, so the schema, queries, and Drizzle
code are unchanged — only the driver swapped. Revisit if the C++ workload gets installed.

### Why sanitize-html rather than a hand-rolled allowlist

Email HTML is untrusted and rendered in a sandboxed iframe, so it still needs
server-side filtering before storage/rendering. `sanitize-html` is pure JS and runs during
sync, so the sanitiser never reaches the client bundle. It is also far more likely to be right about
edge cases than a hand-written tag list.

---

## ReUI notes

ReUI is **not** a replacement for shadcn/ui. It is a shadcn **registry**. Stock shadcn
components keep their bare names (`npx shadcn@latest add button`); ReUI items install
under an `@reui/` namespace.

```jsonc
// components.json
{
  "style": "radix-nova",
  "registries": {
    "@reui": "https://reui.io/r/{style}/{name}.json",
  },
}
```

**Style matters.** The registry path is `https://reui.io/r/{style}/{name}.json` and `style`
selects the primitive layer. `radix-nova` pulls the `radix-ui` package; `base-nova` pulls
`@base-ui/react`. We use `radix-nova`. Verified against the live registry — a wrong style
still returns 200 and installs fine, it just silently swaps your primitive library.

Pricing reality for MVP:

- ~1,100 shadcn components + 22 ReUI primitives are **free / MIT**. No account needed.
- Premium **blocks and icons** require a one-time license (`REUI_LICENSE_KEY`, $249
  all-access). Switch the registry to the authenticated object form to use them.
- The components Lumen actually wants — `timeline`, `kanban`, `icon-stack`,
  `file-upload`, `data-grid` — are in the free `c-*` tier. **MVP should not need the
  purchase.**

ReUI adds semantic tokens beyond stock shadcn that map onto Lumen's conversation states.
Single source of truth: `src/lib/conversation-state.ts`.

```
--success / --success-foreground  needs action
--warning / --warning-foreground  waiting for reply
--info / --info-foreground        informational
--muted (stock)                   low priority
```

Tailwind v4 only emits these as utilities once something references them, so the
tokens look "missing" from the built CSS until the badge component exists. Verified end
to end: `.bg-success { background-color: var(--success) }` with
`--success: oklch(55% .13 152)` in `:root` (and a dark-mode variant).

---

## Deviations from chatmail.md

**1. Do not build on Jev yet.**
Jev shipped 15 Sep 2026 — roughly two weeks old at time of writing. The fit is genuinely
good (typed structured decisions, cannot hallucinate prose), but betting the decision layer
on a two-week-old closed service is the single riskiest dependency in the plan. Ship the
MVP with cheap structured-output calls (Gemini 2.5 Flash / GPT-4.1 mini with a JSON
schema) behind a `DecisionLayer` interface. Jev then becomes a drop-in swap, not a rewrite.

**2. Drop Convex.**
Listed as optional in the spec. Inbox freshness currently comes from periodic polling and
Gmail `history.list` when the stored cursor is stale. Gmail push notifications are not
implemented; a second backend watching the same data would still be wasted MVP surface.

**3. The hard part is quote stripping, not the AI.**
The display layer (detect greetings, signatures, quoted reply blocks; re-add them on send)
is deterministic string work against `text/plain` vs `text/html` MIME. Budget most of MVP
effort here. `html-to-text` plus a custom quote-stripping pass gets ~80%; the remainder is
per-sender signature heuristics.

---

## MVP scope

In scope:

- Gmail-only, Google OAuth 2.0
- Chat-style thread view
- Media + attachment overview per conversation
- Four conversation states: needs action / waiting for reply / informational / low priority
- User-editable current topic and user goal
- Basic importance + urgency
- Conversations grouped by state, not chronology

Cut (Phase 2+): suggested reply generation, AI-generated topics, real-time push, contact
enrichment, user-defined organization rules, other providers.

---

## Build order

1. **Scaffold** — TanStack Start + React 19 + Tailwind v4 + ReUI registry + Drizzle schema.
2. **Mail parser** — MIME walk, `text/plain` vs `text/html`, quote/signature/greeting
   stripping, and the inverse re-add-on-send transform. Everything else depends on this.
3. **Auth + Gmail sync** — OAuth, token storage, thread fetch, attachment fetch.
4. **Conversation model** — threads as conversations with state, topic, goal.
5. **Decision layer** — `DecisionLayer` interface + rule-based implementation for MVP; structured-output LLM remains planned.
6. **UI** — chat timeline, state badges, attachment rail, grouping.

---

## Setup

Full Google Cloud walkthrough — including the console step order and the failure modes each
mistake produces — is in [`docs/google-setup.md`](docs/google-setup.md).

```bash
bun install
cp .env.example .env.local   # fill in Google OAuth + TOKEN_ENCRYPTION_KEY
bun run db:migrate          # creates data/lumen.db from drizzle/
bun run dev                 # http://localhost:3000
```

Generate an encryption key with `openssl rand -hex 32`. It is required, not optional —
`encrypt()` throws rather than falling back to a default key, since a shared default would
mean every install uses the same key.

In the Google Cloud console, add `http://localhost:3000/auth/google/callback` as an
authorized redirect URI.

Component installs go through the normal shadcn CLI:

```bash
bunx shadcn@latest add button badge          # stock shadcn → src/components/ui/
bunx shadcn@latest add @reui/timeline        # ReUI      → src/components/reui/
```

Useful checks: `bun run typecheck`, `bun run lint`, `bun run build`.

---

## Status

- [x] Stack decisions made
- [x] ReUI registry evaluated; `radix-nova` style confirmed against the live registry
- [x] Scaffold — TanStack Start 1.168.60, React 19, Tailwind v4, bun
- [x] ReUI + shadcn install both verified end to end
- [x] Drizzle schema (6 tables) — migration generated, applied, verified in SQLite
- [x] ReUI semantic tokens wired to conversation states, verified in built CSS
- [x] **Mail parser** — MIME parse, DOM-based HTML stripping, compose
- [x] **Conversation model** — pure domain layer, rule-based decisions, repository
- [x] **Auth** — Google OAuth 2.0 + PKCE, AES-256-GCM tokens at rest
- [x] **Gmail sync** — thread fetch, message parsing, attachment download, incremental cursor
- [x] **Inbox wiring** — session-guarded loader, staleness policy, conversation list grouped by state
- [x] **Machine-mail detection** — no-reply senders render as compact non-interactive cards, same feed and state
- [x] Derived-column backfill (`DERIVED_VERSION`) — new columns recompute instead of sitting at their default
- [x] **Conversation view** — chat timeline, day separators, attachment chips, composer for human threads only
- [x] **Reply path** — greeting/signature restored, thread quoted, `In-Reply-To`/`References` set, thread refreshed after send
- [x] Test isolation fixed — `bunfig.toml` preload + a fatal guard against tests hitting `data/lumen.db`
- [x] **Rich email bodies** — HTML captured for every message, sanitised at parse time, rendered in a sandboxed iframe
- [x] **Reply quoting** — replies quote the original as HTML in a `blockquote` instead of a wall of `>` lines
- [x] 224 tests passing; typecheck and lint pass; production build succeeds (TanStack `inputValidator()` deprecation warnings remain)
- [x] **Attachments on send** — composer upload, bounded server-side validation, and `multipart/mixed` MIME with base64 attachment parts
- [x] **Topic / goal editing UI** — authenticated editor with validated saves and database persistence
- [x] **Per-sender parsing controls** — account-wide defaults plus per-sender overrides for quotes/greetings/signatures, removed text shown per message, settings re-parse the open thread on save
- [x] **Reply style per sender** — account-wide greeting/signature defaults with per-sender overrides that fall back to the user's own most recent message
- [x] **Reconnect after revoked Google access** — a rejected/expired grant surfaces a "Reconnect Google" action instead of only a sync error
- [ ] LLM decision layer behind the existing interface

## Mail parser

`src/lib/mail/` — pure functions, no Gmail types leak in, so the Gmail adapter is the
only thing that changes when the API does.

| Module        | Role                                                                    |
| ------------- | ----------------------------------------------------------------------- |
| `types.ts`    | `MailPart`, `ParsedMessage`, `CleanedMessage`                           |
| `parse.ts`    | raw RFC822 → `ParsedMessage` via postal-mime; body/attachment selection |
| `strip.ts`    | quote / signature / greeting detection                                  |
| `html.ts`     | DOM-based HTML extraction (htmlparser2)                                 |
| `compose.ts`  | the inverse: `composeReply`, `buildMimeMessage`, quoted-printable       |
| `fixtures.ts` | raw emails in each client's format                                      |

Run `bun test` (bun's built-in runner — no jest/vitest dependency).

### HTML extraction is DOM-based, not regex

`html.ts` walks the parsed tree and marks any text inside a quote container as quoted.
Container detection covers `blockquote`, `gmail_quote`, `divRplyFwdMsg`, `appendonsend`,
`O365Note`, and `yahoo_quoted`. A `depth` counter makes arbitrarily nested replies work.

The regex version could not: Outlook wraps quotes in three nested `div`s, so a non-greedy
match either stopped at the first closing tag (leaving quote text visible) or ran to the
end (eating real content). One subtlety that cost a debugging round — **depth must be
computed before the block-element branches**, because a `gmail_quote` div is _also_ a block
element and was taking the early-`continue` path without ever incrementing.

### Detection rules worth knowing

- **Quotes** are found by _strong_ markers (`-----Original Message-----`,
  `---------- Forwarded message ----------`, `On <date> <person> wrote:`) which match
  anywhere, and _weak_ markers (bare `From:`, long dash runs) which only match past the
  first 40% of the body. A `>` prefix counts anywhere.
- **Never return an empty body.** If stripping would leave nothing (an all-quote
  forward), the original is kept — a blank chat bubble is worse than a long one.
- **Order is quote → signature → greeting.** A reply puts the signature _above_ the
  quoted history, so stripping quotes first leaves the signature intact.
- **Signatures** need an explicit closing (`--`, `Sent from my iPhone`, `Best regards,`,
  `Met vriendelijke groet(en)`, `mvg`, `Cordialement`, …) within the last 12 lines, matched
  as a whole line so a sentence that merely mentions the word never starts a signature.
  Mid-body text is never touched. Like the greetings, the closing list is **multi-lingual**
  — the Dutch standard was missing, so `Met vriendelijke groeten,\nNils` stayed in the
  bubble.
- **Greetings** must be the first non-empty line, under 70 chars, matching a known
  opener. "Hi, I was wondering whether we could push the launch" is content, not a
  greeting. The opener list is **multi-lingual** (`hi`, `hey`, `dag`, `hoi`, `beste`,
  `geachte`, `hallo`, `guten tag`, …) because the mailbox is Dutch: an unknown opener is
  not stripped, and the greeting sits in the bubble — the exact failure the parser exists
  to prevent. A word-boundary match keeps `Dag` from matching `Dagelijks`.
- **Quoted-printable encodes UTF-8 bytes**, not code points: an em dash is `=E2=80=94`.
  Encoding the code point directly produces `=2014`, which decodes as a space + "14".

### Known gaps

- Parsing is configurable per sender (`sender_profiles`): account-wide defaults for
  quote/greeting/signature stripping, overridable per sender. A sender can also inherit the
  account defaults. Signature _text_ is still stored per message, not learned per contact;
  only the classification of what to strip is per sender.
- `buildMimeMessage` nests `text/plain` or `multipart/alternative` inside
  `multipart/mixed` when a reply includes files. The composer caps uploads at 10 files,
  25 MiB per file, and 18 MiB combined to leave room for MIME/base64 overhead.

## Parsing preferences are per sender

The parser is conservative by default, but "what counts as a greeting" differs by
correspondent: a colleague's `Hey,` is a greeting, a newsletter's is content. So the
decision of _what to strip_ is a user setting, not a fixed rule.

Two layers, matching how people actually know their contacts:

- **Account-wide defaults** (`accounts.default_strip_quoted_history` / `_greeting` /
  `_signature`). Applied to every sender without a profile.
- **Per-sender overrides** (`sender_profiles`). A sender either **inherits** the account
  defaults (`use_account_parsing_defaults`) or sets its own three toggles.

`getParsingProfileContext` loads the defaults and every profile once per sync, and
`buildConversation` resolves `sender override → account default → strip` per message, so a
single lookup serves the whole run. The same profile also carries the per-sender reply
style (greeting/signature restored on send, falling back to the user's own most recent
message in the thread).

What the user can do in the chat header ("Tune parsing & reply style"):

- Toggle quotes, greetings, and signatures for the account or for one sender.
- Set the account-wide greeting/signature and an optional sender-specific pair.
- See exactly what was removed from each message under _"View text removed by parsing"_ —
  the greeting, signature, and (when retained) quoted history are stored on the row
  (`detected_*` / `stripped_*`), so the disclosure works without re-fetching.

Saving a profile **re-fetches and re-parses just that thread** with the new context, so the
effect is immediate rather than waiting for the next sync. `saveParsingProfile` writes the
account defaults and the sender profile in one transaction under the write lock, and it
refuses to create a profile for the account owner (their own mail is never "stripped" as a
sender).

### When stripping is off, nothing is lost

Disabling a toggle does not discard the text — it stops removing it. `cleanMessage` always
detects the greeting/signature/quote; the flags only decide whether they are cut from the
body (`stripped*`) and whether they are re-attached on send. For quote handling specifically,
`findQuoteStart` is consulted separately from `stripQuotedText`, because the latter keeps an
all-quote forward intact by design — without that guard, turning quote-stripping off would
duplicate the body.

## Conversation model

`src/lib/conversation/` — `model.ts` is pure and dependency-free, which is where the rules
live and where every test points.

| Module          | Role                                                                |
| --------------- | ------------------------------------------------------------------- |
| `model.ts`      | `buildConversation`, message cleaning, `deriveState`, `inferIntent` |
| `decision.ts`   | `DecisionLayer` interface + rule-based and no-op implementations    |
| `repository.ts` | Drizzle persistence — the only part that touches the DB             |

Key rules:

- **Messages are sorted by date first.** Gmail does not guarantee thread order, and every
  downstream rule (who spoke last, do we await a reply) depends on it.
- **`state` is rule-derived, and deliberately conservative.** It only claims a state it
  can justify from message flow. `deriveState` recognises three cases: they asked us a
  direct question (`needs-action`), we spoke last (`waiting-for-reply`), otherwise
  `informational`. Urgency decays with message age; importance is a placeholder that
  scales with thread length.
- **A question mark alone is not a request.** "Wondering how the weather is?" must not
  become `needs-action`, so a modal verb is also required.
- **`topic` starts null.** Deriving it from the subject produces "Re: Project launch"
  noise, so it is left to the user and the future decision layer.
- **`goal` is user-owned and never written by the decision layer.** `applyDecision`
  copies it through untouched; there is a test asserting exactly that.

### The decision-layer seam

`DecisionLayer` has one method, `decide(input) -> Decision`. `RuleBasedDecisionLayer`
wraps `deriveState` today; swapping in an LLM-backed or Jev-backed implementation must not
touch `model.ts` or anything upstream. `NoopDecisionLayer` keeps the app working with no
API keys configured.

## Auth

`src/lib/auth/` — Google OAuth 2.0 with PKCE.

| Module        | Role                                              |
| ------------- | ------------------------------------------------- |
| `crypto.ts`   | AES-256-GCM token encryption at rest              |
| `session.ts`  | HMAC-signed cookie holding only an account id     |
| `google.ts`   | OAuth2 + PKCE, token exchange, Gmail client       |
| `accounts.ts` | persistence — the only place tokens are decrypted |

Routes: `GET /auth/google`, `GET /auth/google/callback`, `GET /auth/logout`.

Security decisions:

- **Refresh tokens are encrypted before they touch the database.** Anyone with the
  database file gets permanent mailbox access otherwise. `encrypt()` is called inside
  `upsertAccount`, so the plaintext token never crosses the persistence boundary.
- **The session cookie holds only an account id**, HMAC-signed. A stolen cookie grants
  nothing without the server's encryption key.
- **GCM gives authenticated encryption.** A tampered ciphertext fails to decrypt rather
  than yielding garbage — covered by tests for a modified ciphertext, a modified auth tag,
  a wrong key, and an unknown envelope version.
- **Scopes are minimal**: `gmail.readonly` + `gmail.send` + `userinfo.email`. No
  modify/delete scope, so a bug cannot destroy mail.
- **CSRF state and PKCE verifier live in 10-minute cookies**, verified on return.
- **OAuth errors are logged server-side but never echoed to the user**, since they can
  contain token material.
- **`prompt: 'consent'`** forces a refresh token each time; Google omits it when a grant
  already exists, and `upsertAccount` keeps the stored one rather than overwriting with
  null.

Verified end to end against the dev server:

| Request                                            | Response                           |
| -------------------------------------------------- | ---------------------------------- |
| `GET /`                                            | 200                                |
| `GET /auth/logout`                                 | 302 → `/`                          |
| `GET /auth/google` (no client id)                  | 500, "GOOGLE_CLIENT_ID is not set" |
| `GET /auth/google/callback?code=fake&state=forged` | 403, state mismatch                |
| `GET /auth/google/callback?state=x`                | 400, no authorization code         |
| `GET /auth/google/callback?error=access_denied`    | 400, user denied                   |

### Re-authenticating after the grant dies

Google refresh tokens can be revoked by the user or expire. Until this was handled,
that state was invisible: every sync failed, `runSync` collapsed the error to a string,
and the only thing the user saw was "Sync failed: …". There was **no way back in** — the
app had no re-login path once a session cookie already existed.

`GmailAuthError` (raised by `wrapGmailError` on `invalid_grant`/401) is now recognised in
`service.ts`, as is the "stored refresh token could not be decrypted" case. `loadInbox`
carries an `authRequired` flag through the loader payload, and the inbox renders a
**Reconnect Google** button pointing at `/auth/google`. Because a failed sync never
advances the cursor, the account stays stale, so the prompt reappears on every load until
the user signs in again.

### Known gaps

- Single-user: no session table, and the session cookie is not revocable server-side
  (signing out clears the cookie, but a stolen cookie stays valid until expiry).
- `SESSION_SECRET` falls back to `TOKEN_ENCRYPTION_KEY` for local convenience.
- Reconnect is surfaced on the inbox only. The conversation view still shows the raw
  `GmailAuthError` message on a failed send rather than an inline re-login action.
- `prompt: 'consent'` is sent on every `/auth/google` visit, so reconnecting asks for
  consent again rather than silently reusing the grant. That is intentional — it is what
  makes the reconnect button reliable — but it is a second consent screen.

## Gmail sync

`src/lib/gmail/` — the adapter between Gmail's API and the conversation model. Nothing
above this layer imports a Gmail type, so swapping the transport touches only this folder.

| Module           | Role                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `client.ts`      | `GmailClient` interface (6 methods), the `googleapis` implementation, and typed errors (`GmailAuthError`, `GmailRateLimitError`, `GmailNotFoundError`) |
| `message.ts`     | Gmail message → `ParsedMessage`; walks the MIME tree for `text/plain`, `text/html`, and attachment parts                                               |
| `attachments.ts` | `safeFilename`, `downloadAttachment`, on-disk cache                                                                                                    |
| `sync.ts`        | `backfill`, `syncIncremental`, and the `sync` entry point that falls back to backfill on a dead cursor                                                 |
| `fake.ts`        | `FakeGmailClient` — records calls so tests assert _how_ sync ran                                                                                       |

### `format: 'full'`, not `'raw'`

Thread fetches use `format: 'full'`. Attachment bodies are not inlined in the structured
payload, so they are fetched on demand by part id. That keeps thread responses small, and
it maps onto the schema's nullable `localPath` — an attachment row with no cached file is
one that has not been downloaded yet, not a broken one.

### `messages` keeps both halves of the envelope

The parser returns a `ParsedMessage` with the greeting and signature separated from the
body, and sync persists both — `greeting_text` and `signature_text`. The greeting column
was added in migration `0001` after the first version stored only the signature: without
it, a reply would re-add the signature and silently drop the opener, which is exactly the
kind of small loss that makes generated mail feel wrong.

### The incremental cursor dies, and that is normal

`listHistory` is given the stored `historyId`. Gmail expires history ids (usually after
about a week), and once it does the API returns a 404 for that start id. So `sync` catches
the failure and re-backfills instead of surfacing an error — a stale cursor is an expected
state, not a bug.

A single failing thread also does not abort the run: `backfill` catches per thread, so one
malformed message cannot cost the user the other 200.

### Parallelise the network, serialise the write

The rule that cost the most time to learn: **fetch threads concurrently, write them one at
a time.**

Fetching four threads at once and writing them concurrently produced
`SQLITE_BUSY: database is locked`. `busy_timeout` does not help here — the problem is a
_deferred_ transaction that starts reading and then tries to upgrade to a write lock while
another connection already holds it. Two fixes, both kept:

1. `initDatabase()` in `src/db/index.ts` sets `journal_mode = WAL`, `busy_timeout = 5000`,
   and `foreign_keys = ON`. (Pragmas only apply to file-backed URLs, not `:memory:`.)
2. `withWriteLock()` in `src/lib/db/write-lock.ts` is a promise-chain mutex used by
   `saveConversation`, `recordDecision`, and `setAttachmentLocalPath`.

### Gmail API shapes that cost a bug each

- `users.messages.attachments.get` takes `id`, not `attachmentId`.
- `Schema$History.messages` entries carry `id` and `threadId` directly — there is no
  `.thread` object to unwrap.
- `Schema$MessagePartBody.size` is `number | null`.
- A `From` header holds `"Name" <a@b.com>`; running `stripAngleBrackets` over the whole
  value mangles it. `extractAddress` pulls the address out first.
- Header lookups need `root?.headers?.[name]` — the payload and its `headers` map are
  independently optional, and guarding only the first level throws on a malformed message.
- Part headers are sparse. The tree walkers take a `LooseGmailPart` view
  (`children?`, `headers?: Record<string, string | undefined>`) because Gmail omits
  `children` on leaves and the declared part type claims otherwise.

## The inbox seam

Everything above this point was a library with no entry point. `sync.ts` takes an
injected `GmailClient`, and nothing knew how to build one from a stored account. `service.ts`
is that missing seam: account id in, list of conversations out.

| Module                 | Role                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `service.ts`           | `loadInbox()` — builds the client, applies the freshness policy, returns a serializable payload |
| `freshness.ts`         | `isCursorStale()` — the policy, dependency-free so it can be tested on its own                  |
| `routes/index.tsx`     | `createServerFn` loader + the two-minute revalidation timer                                     |
| `components/inbox.tsx` | The list, grouped by state                                                                      |

### Sync is not an action

Every load asks for the inbox, and `loadInbox` decides whether the cursor is stale
enough to warrant talking to Gmail. There is no separate "sync" button in the path. Putting
the policy in one place beats letting whichever component triggered a refresh also decide
how often to refresh.

- **The UI polls every 2 minutes; the cursor threshold is 90 seconds.** Deliberately not
  equal — the poll almost always just re-reads the database. Syncing on every poll would
  burn Gmail quota on a cursor that has not moved.
- **A tab left in the background also re-checks on `visibilitychange`.** Background tabs
  have their timers throttled, so without this a tab restored after lunch is minutes stale.
- **A failed sync is reported, not thrown.** The conversations already in the database are
  still worth showing, and a transient 503 should not blank the inbox.
- **Concurrent syncs are deduplicated per account, not locked.** A slow first backfill
  overlaps the next poll; the second caller waits for and reuses the first one's result.

### `history_cursors` was dead schema, and it is now the staleness clock

The table shipped in migration `0000` with the comment _"this records where each account's
cursor is"_ — and nothing ever wrote to it. `setHistoryId` was only bumping
`accounts.updatedAt`, which is **also** bumped when the OAuth token refreshes, so it cannot
answer "when did we last sync?".

The split is now: cursor id on `accounts`, timestamp in `history_cursors`. The freshness
check needs an answer to exactly that question, and conflating it with token refresh would
make the threshold meaningless.

### Never-synced is stale, and a future timestamp is stale

Both are easy to get wrong in the direction of never syncing again:

- A `null` timestamp means the account has never synced. Read it as fresh and a new
  account has a permanently empty inbox with no error to explain it.
- A timestamp in the _future_ means clock skew or a corrupted value. `now - t` is negative,
  which a naive `age >= threshold` reads as fresh — suppressing syncing for an unknown
  stretch. Both cases are covered in `freshness.test.ts`.

## Machine mail is not a chat

A no-reply address is not a conversation. Rendering "build #881 failed" as chat bubbles is
misleading — it implies turn-taking with a human, offers a reply box that goes nowhere, and
files a receipt under "waiting for reply".

`src/lib/conversation/automated.ts` answers one question: **is there a human on the other
side?**

### Strict markers only, and why

No list of "known" services, no inference from volume or tone. A false positive hides a real
person's mail from chat view, which is worse than showing a robot as a chat. The cost is that
some automated senders stay in chat view — visible, just not ideal.

Matching is on **separator boundaries**, which is the detail that matters:

- `no-reply`, `no_reply`, `no.reply` and `noreply` all collapse to the same entry.
- `github-noreply`, `stripe-no-reply` and `noreply+ci` match on a prefix or suffix boundary.
- `nora.reilly@` does **not** match, because matching anywhere in the string would flag it.
- Bare `reply` and bare `auto` are deliberately **not** markers — they appear in real
  personal addresses. `do-not-reply` is listed as a compound instead.
- The domain is ignored. `no-reply.github.com` is an outbound bounce domain Gmail uses, not
  a sender; matching on it would flag unrelated human mail.

In display names, only unambiguous phrases count. An early version included bare `alert` and
`notification` and a test caught it: "Alerts Department" is an ordinary company name.

### Derived per thread, so it self-corrects

> A conversation is automated when **every** message came from either you or a marked sender
> — **and** at least one came from a marked sender.

The "at least one" guard stops a thread you only ever wrote yourself from being called
automated. The "every" guard is the useful one: if a human ever replies to
`noreply@github.com`, the thread becomes a chat again on the next sync. Nothing needs
overriding or undoing, because nothing is persisted as a permanent label — it is re-derived
from the messages every time.

**This is orthogonal to state, not a fifth state.** A failed build is still `needs-action` and
still counts there; it just renders as a compact non-interactive card tagged "no reply".
Same feed, same grouping, different presentation.

### Adding a derived column needs a version bump

Caught the hard way: `is_automated` shipped, the migration set every existing row to `false`,
and **nothing ever recomputed it.** Incremental sync only revisits threads Gmail reports as
changed, so already-synced conversations keep the migration default until that specific
thread changes — silently, with no error.

The evidence, from the live database:

```
max(decided_at)  1791052611958   ← conversations last written
cursor updated   1791054222179   ← sync ran 27 min later, wrote nothing
```

Fix: `accounts.derived_version` plus `DERIVED_VERSION` in `repository.ts`. `loadInbox` compares
them and runs `backfillDerivedFields` when they lag. The recompute reads only the local
`messages` table — no Gmail round trip — and is idempotent, so it costs one extra query per
load and a local pass once per version bump.

**Bump `DERIVED_VERSION` whenever a derived column is added to `conversations`.** Otherwise
the same silent-staleness bug returns.

## The conversation view

`/conversations/$gmailThreadId` — the thread as a chat. Owner messages right, everyone
else's left, greetings and signatures absent because the parser stripped them.

### The greeting and signature never appear in chat

The chat must read like a chat: a salutation and a sign-off at the top and bottom of every
bubble are the tell that this is email pretending to be messaging. So the greeting and
signature are **scratched from the conversation view entirely** — the body a message shows
is only what the person actually said.

They are not thrown away, though. They are the text the user would otherwise have to
retype, so they are detected, stored per message (`greeting_text` / `signature_text`, plus
the `detected_*` copies), and **restored only on send** (`composeReply`). Each message is
therefore shown stripped and sent whole, which is the point of parsing at all: the greeting
and signature exist for the outgoing email, not for the chat.

The `stripped_*` fields back the _"View text removed by parsing"_ disclosure, so a user who
wants to check what was taken — or turn a category back on for one sender — can see it
without it being part of the conversation. Turning a toggle off is the one deliberate
exception: that is the user explicitly asking to keep the text inline.

### The ReUI Timeline is the wrong component

`@reui/timeline` was installed early with the idea of using it here. It is a **progress
stepper**: every `TimelineItem` requires a `step: number` and draws a connector from
`activeStep` in the context. Messages have no step number, so using it means inventing
one per message and fighting connector lines. The view is plain markup instead.

### Email HTML is kept, sanitised, and rendered in an iframe

Two bugs shared one root cause: Lumen flattened HTML mail to text and then treated that
flattening as the message. Emails looked unformatted on screen, and replies quoted the
flattened text back at the sender as a wall of `>` lines describing a newsletter layout
instead of showing the newsletter.

**HTML is now captured for every message that has it**, not only HTML-only mail. That was
the actual defect: `cleanMessage` set `bodyHtml` only in the `else` branch when no
plain-text part existed, so on a real mailbox — where almost everything arrives as
`multipart/alternative` — the column was populated for 2 messages out of 31. Plain text
still wins for _deciding_ what the user wrote, because `strip.ts` is tuned on its quoting
markers; HTML is kept alongside purely for rendering.

**Sanitising happens once, at parse time** (`src/lib/mail/sanitize.ts`), not at render
time. What lands in `messages.body_html` is already an allowlist-filtered fragment, so no
component has to remember to clean before injecting. The allowlist drops `script`,
`style`, `iframe`, `object`, `form` and event-handler attributes, and checks schemes on
`href`/`src`. Two things it cannot see: a `style` attribute is opaque, so
`background:url(javascript:…)` survives the attribute pass and is scrubbed separately;
and the sanitiser is not the only layer — the iframe below has no script permission, so a
future bypass of the allowlist still cannot execute.

**The order in `prepareHtmlBody` is load-bearing:** strip quotes, then greeting and
signature, then sanitise. Quote-stripping keys off the `class`/`id` attributes clients
put on quote containers, and the allowlist keeps both, so sanitising first would destroy
the evidence before using it.

**Greeting and signature are trimmed from the HTML by consuming characters off the text
node list** (`stripHtmlGreeting` / `stripHtmlSignature`), not by matching elements. A
salutation can be split across nodes — `<b>Hi</b> Sarah,` — so any element-level approach
has to guess where the phrase starts. The trim is planned in full before anything is
written: if the phrase turns out not to reach the end of the node list, the original HTML
is returned untouched, because a half-applied trim mangles a real message and a
still-visible greeting does not. Emptied elements are pruned too, because an empty
`<div>` still occupies its margin.

**The body renders inside an `<iframe sandbox="allow-same-origin">`.** Email HTML is a
foreign layout language — fixed 600px tables, inline styles, its own fonts — and injected
into the app's DOM it escapes the bubble and its `position: absolute` rules can cover the
composer. `allow-same-origin` is what lets the parent measure the height; `allow-scripts`
is withheld deliberately. Remote images are allowed, per the user's preference; this means
opening a message can contact image hosts (and potentially reveal that the message was
viewed). `referrerPolicy="no-referrer"` suppresses the app URL but does not block those
requests. Verified against real mail: a newsletter renders with its gradient headline,
pricing card and icons intact.

**The frame is only used for mail that actually uses layout** (`isRichHtml`). Almost every
`multipart/alternative` message carries an HTML part, and most of them are the same
sentences wrapped in a `div` — rendering those in their own document gave the chat a white
box with its own fonts and margins for what should have been an ordinary bubble, which
looked worse than the plain text it replaced. `isRichHtml` lives beside the other HTML
helpers and treats only structural/formatting tags (tables, headings, lists, images,
`blockquote`, a `style` attribute) as rich; a `div`/`p`/`span`/`br`/`a` wrapper is not, so
that message falls back to the same text bubble as everything else. When the frame _is_
used, the bubble drops its own padding so the mail fills it edge to edge, and the document
resets `html,body{margin:0}` — the browser default 8px margin was showing up as a white
inset inside the bubble.

### Invisible characters

Newsletters pad with `U+2007 U+034F` pairs — figure space plus combining grapheme joiner
— and those survive every filter that only targets Unicode category Cf. They defeated
signature detection and were copied out of the app into whatever the user wrote next.
`stripInvisibleCharacters` removes them along with BOMs, soft hyphens and zero-width
marks, and collapses a line left with nothing but spacing, since that filler was faking
vertical space and keeping the empty line would render a gap the sender never asked for.

### A parsing change is not a derived column

`DERIVED_VERSION` (now 2) covers a new _column_ that can be recomputed from the local
`messages` table. This change is different: the HTML was never stored, so there is
nothing local to recompute from. `scripts/rebackfill.ts` re-fetches threads **by id**, not
by search query — a `newer_than:30d` query returns whatever is still inside the window (6
threads out of 31 on this mailbox, because mail ages out of a date range whether or not
the app still shows it), whereas ids come from the database, so every conversation already
in the inbox is fixed and nothing else is pulled in.

Worth remembering: `--missing-html` is _not_ sufficient after this change. It skips
threads that already had a `body_html` value, which is exactly the ones holding the old
unsanitised markup. Run the full re-fetch.

The same applies to the greeting fix. `messages.body_text` stores the body _after_
stripping, and the raw MIME is never kept locally, so rows parsed before the multi-lingual
opener list still contain their `Dag …` greeting and cannot be corrected from the
database alone. Re-run `bun run scripts/rebackfill.ts <account-email>` to re-fetch and
re-parse them.

### Replies

`src/lib/gmail/send.ts`. The composer hands over a bare body; `composeReply` restores the
greeting and signature the user actually uses with these people — taken from their own
most recent message in the thread, which beats guessing. Then `buildMimeMessage` and
`users.messages.send`.`composeReply` returns **both** representations — `{ text, html }` — rather than a
string. The HTML part is only produced when there is HTML to quote, so a short
text reply still goes out as plain `text/plain` instead of a message with an empty rich part.

The composer accepts up to 10 files, with an 18 MiB combined cap (25 MiB per-file
hard ceiling). Uploads are revalidated server-side, decoded to bytes, and emitted as
base64 parts inside `multipart/mixed`; the body is a nested `multipart/alternative`
when quoted HTML is available. File names use an ASCII fallback plus RFC 2231 UTF-8
`filename*`, and the encoded payload is wrapped at 76 columns.

Decisions worth keeping:

- **Recipients come from `conversation.participants`, not the newest message's `To:`.**
  If the most recent message is the user's own and they replied to just one person,
  reading that message's header silently drops everyone else still on the thread.
- **`In-Reply-To` and `References` are set** from the stored RFC Message-IDs. Gmail
  threads by `threadId` alone, but Outlook and Apple Mail need the headers, and a reply
  that arrives as a loose message is the most visible possible bug in a mail client.
  This is what the `messages.internetMessage_id` column is for — it existed and was never
  written to.
- **The signature goes above the quoted history, not below it.** The composed reply is
  `greeting → body → signature → quote`. Putting the signature last (below the quote)
  read as if it belonged to the other person, and it broke the round trip: re-parsing the
  sent mail only inspects the text _above_ the quote, so the signature was never found and
  the next reply silently dropped it.
- **The quoted original is the original's HTML, inside a `<blockquote>`.** Quoting
  `last.body` is what produced the `> On … wrote:` walls: that value is the _stripped_
  body, already flattened, so the recipient got a transcription of a newsletter's layout
  rather than the newsletter. `originalHtml` is the sanitised, quote-stripped body the
  message was stored with, which is both accurate and safe to embed verbatim.
- **`multipart/alternative` puts plain text first and HTML second.** RFC 2046: clients
  pick the _last_ part they understand, so the rich part must come last or it is ignored.
  The boundary is derived from the content rather than randomised, so composing the same
  reply twice produces byte-identical output — which is what makes the composed message
  testable at all.
- **Subjects are RFC 2047 encoded.** Real subjects carry emoji and accents
  (`Re: 🖤 LAATSTE KANS`), and a raw UTF-8 header is not legal RFC 5322. ASCII-only
  subjects pass through untouched so they stay readable when debugging a send.

After a send, `refreshThread` re-fetches that one thread. Sending does not touch our
database and the sync cursor has already moved past it, so without this the user would
send a reply and watch it not appear until some later sync happened to cover it.

Automated threads render a read-only notice instead of a composer, and `sendReply` refuses
server-side too — a stale UI cannot send into a void.

## Tests must never touch the real database

**This went wrong and it cost a real synced mailbox.** Worth reading before adding a test.

`sync.test.ts` used to isolate itself by setting `process.env.DATABASE_URL` before its
first `await import('#/db/index.ts')`. That only works if it happens to be the _first_ file
to load the database module — not a property you can rely on. Adding `send.test.ts`, which
statically imports the conversation layer, re-ordered the module graph. `#/db/index.ts`
bound to `.env.local`, every test shared that one client, and sync's `beforeEach` deletes
wiped the real account and replaced it with `me@example.com`.

Two layers of fix, both in place:

1. `test/setup.ts`, preloaded via `bunfig.toml`, points `DATABASE_URL` at a temp file
   before any module loads. Isolation no longer depends on file ordering.
2. `#/db/index.ts` **throws** if `LUMEN_TEST=1` and the resolved URL is still
   `data/lumen.db`. Deliberately fatal: a loud crash beats a destroyed mailbox.

**When adding any test that touches the database, remember `#/db/index.ts` resolves its URL
once at module load.** The guard is the backstop, not the mechanism.

## Notes for future sessions

- `.cta.json` is TanStack's scaffold manifest (read by the CLI only, not at runtime).
  Keep it accurate — stale values make later `create` commands re-apply old config.
- Root is `lumen` (not the `lumen-tmp` the CLI generated it as; files were moved up
  from a temp dir because the CLI wants an empty target).
- `src/routes/index.tsx` is the real inbox now (loader + server fn). The scaffold
  verification page is gone.
- Server functions are `createServerFn` from `@tanstack/react-start`, not `@tanstack/start`.
- The loader returns ISO strings, never `Date`s. Loader data crosses a serialization
  boundary, and an explicit DTO keeps the client bundle free of the Gmail and DB types.
- Verify googleapis stays server-only after touching route code:
  `grep -rl googleapis dist/client/assets/*.js` should print nothing. (`dist/` CSS will
  match on `fonts.googleapis.com` — that is the Fraunces import, not a leak.)
- `timeAgo()` in `components/inbox.tsx` reads `Date.now()`, so its output differs between
  the server render and the client's first paint. That is why the `<time>` element sets
  `suppressHydrationWarning`.
- `tsconfig.json` pins `types: ["vite/client", "bun"]` — dropping `"bun"` breaks the
  test typecheck.
- postal-mime v4 is a CommonJS default export (`export =`), and its `Email.html`/`.text`
  are single strings, not arrays.
- htmlparser2 v12 moved node types to `domhandler` and `isTag` to `domelementtype`.
  Import the guards from `domhandler` — `domelementtype`'s `isTag` uses its own `Node`
  type and will not narrow correctly against domhandler types.
- Server route handlers return plain `Response` objects rather than `redirect()`.
  `redirect({ to })` expects an internal route path, and passing an external URL makes
  TypeScript infer the handler circularly (TS7022/TS7023).
- Route files use explicit return types (`GET: async (): Promise<Response>`) for the same
  reason.
- `Array.prototype.at(-1)` over `[length - 1]` where a value may be absent: the index
  form is typed `T` without `noUncheckedIndexedAccess`, which hides the empty case from
  both the type checker and `@typescript-eslint/no-unnecessary-condition`.
- If the dev server 500s with `ConnectionFailed ... ./data/lumen.db`, the database file is
  missing — `bun run db:migrate` recreates it. Do not `rm -rf data` casually.
- Never write two rows from concurrent requests without `withWriteLock`. See the Gmail sync
  section for why `busy_timeout` alone does not save you.
- Bump `DERIVED_VERSION` when adding a derived column to `conversations`. Incremental sync
  will not revisit unchanged threads, so without it the new column stays at its migration
  default forever and nothing reports a problem.
- `from` is a reserved word in SQLite — quote it (`"from"`) in raw queries, or select the
  column and parse the JSON in JS.
- `sync.test.ts` sets `DATABASE_URL` to an isolated temp file _before_ importing `#/db/index.ts`,
  because that module creates the client at import time. Keep that ordering if you add tests.
  (This is also why `freshness.ts` has no imports — a test for it needs no database at all.)
- `GmailApi` in `client.ts` is `Awaited<ReturnType<typeof createGmailClient>>` — an inline
  `import()` type annotation trips `@typescript-eslint/no-import-type-side-effects`.
- Non-breaking spaces in source trip `no-irregular-whitespace`. Write `\u00a0`.
- shadcn's generated `button.tsx` / `badge.tsx` needed `eslint --fix` for
  `import/consistent-type-specifier-style`. Expect the same on any newly added ui/ file.
