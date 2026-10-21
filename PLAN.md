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
| Mail              | `googleapis` for Gmail; plain `fetch` for Microsoft Graph — both behind the `MailboxClient` seam | Two providers, one sync/conversation pipeline. Push watch is not implemented for either.                                    |
| AI decisions      | Deterministic rules first, then **Jev** for importance / urgency / state-when-unset / replyability (a sender the user has marked outranks it) | See "Deviations".                                                                                                           |
| AI generation     | **LLM** (Gemini, OpenAI or Anthropic, BYO key): topic now, suggested replies / drafts in Phase 2                                                                   | Phase 2. Draft-only, never auto-send.                                                                                       |
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

**1. Jev and the LLM are two different services, not one.**
Jev (TypeSafe's System One) returns typed *decisions* — "a decision instead of a paragraph"
— and skips token-by-token generation entirely. A general LLM's job here is **prose**: the
topic label today, and Phase 2's suggested replies and drafts. Treating Jev as a drop-in
swap for a structured-output LLM, as this plan originally did, conflates the two. The split:

- **rules** decide the obvious state (e.g. you sent last ⇒ waiting for reply), and always win
  where they apply;
- **Jev** decides importance, urgency, the state the rules could not, and whether the mail is
  replyable at all — except for a sender the user has marked, which is an answer rather than a
  hint and is never put to the model;
- the **LLM** writes the topic (and later the drafts);
- **intent** is the user's — never AI-written.

Each service has its own bring-your-own key and degrades **independently**: a Jev key with no
LLM key still classifies, an LLM key with no Jev key still labels topics, and neither leaves
the app broken.

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

Shipped beyond the original cut: suggested replies, AI-generated topics, a second provider
(Outlook), and basic contact names/avatars. Cut (Phase 2+): real-time push, richer contact
enrichment (editable per-address context), user-defined organization rules, IMAP/SMTP.

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
mistake produces — is in [`docs/google-setup.md`](docs/google-setup.md). The Microsoft
counterpart, including the app-registration permissions and the Graph limits, is in
[`docs/outlook-setup.md`](docs/outlook-setup.md).

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
- [x] 262 tests passing; typecheck and lint pass; production build succeeds (TanStack `inputValidator()` deprecation warnings remain)
- [x] **Attachments on send** — composer upload, bounded server-side validation, and `multipart/mixed` MIME with base64 attachment parts
- [x] **Topic / goal editing UI** — authenticated editor with validated saves and database persistence
- [x] **Per-sender parsing controls** — account-wide defaults plus per-sender overrides for quotes/greetings/signatures, removed text shown per message, settings re-parse the open thread on save
- [x] **Reply style per sender** — account-wide greeting/signature defaults with per-sender overrides that fall back to the user's own most recent message
- [x] **Reconnect after revoked Google access** — a rejected/expired grant surfaces a "Reconnect Google" action instead of only a sync error
- [x] **Decision pipeline wired (rules-first)** — split into rules → decision-model (Jev) → topic (LLM) stages, run from `syncThread` and recorded on `decisions`; keyless defaults keep behaviour identical
- [x] **Jev decision model** behind the `DecisionModel` seam — importance, urgency, and a state to fill the rules' gap; configured in Settings, key encrypted at rest
- [x] **LLM topic generator** behind the `TopicGenerator` seam — Anthropic, OpenAI or Gemini, provider-agnostic; configured in Settings
- [x] **Replyability** — Jev asks "can this be replied to" and the answer is unified with machine-mail detection behind the schema column and composer behaviour; the user's own per-address list sits above both, is managed from Settings and can be added to from a thread or a picker of real senders (see "Can't reply to a sender")
- [x] **Decision trigger** — the sync-time path plus a manual re-analyse action on the conversation, which re-runs the pipeline over the stored row with no Gmail round trip
- [x] **Read and Done marks** — per-message "viewed" as a forward-only high-water mark set by opening a thread, and a Done mark only the user's own action sets; Done moves the thread out of the state groups into its own section, and both survive every rebuild — newer mail voids Done (see "Read is not doing")
- [x] **First sync runs in the background** — adding a mailbox no longer blocks the page on a 30-day backfill; the inbox shows per-mailbox progress and polls fast until it lands (see "A first sync is not something to wait for")
- [x] **Suggested replies** — a draft generated on demand for a thread that asks for a reply and clears an importance threshold, shown in the composer to edit or use; never stored and never sent (see "Suggested replies are drafts, not sends")
- [x] **Multiple accounts in one merged inbox** — mailboxes scoped per user, `loadInbox` fanning out across the signed-in user's mailboxes and merging by shared `Message-ID`, relation-aware ownership, per-account reconnect, reply sender shown and pickable (see "Multiple accounts, one inbox")
- [x] **A second mailbox service** — Outlook / Microsoft 365 through Graph, behind the same `MailboxClient` seam; `accounts.provider`, the `provider_*` rename and `sync_cursors(account, kind, value)` land together (see "Outlook is the second service")
- [x] **People, not one owner** — email/password sign-in (argon2id), revocable per-device
  sessions, and mailboxes, settings and contact context scoped by the signed-in user
- [ ] **Request-only beta** — the next release: sign-in disabled for now, a request form and
  an emailed invite, a six-step funnel, first-party feedback and a `/admin` view (see "Access is
  request-only, and the beta is measured")

## Remaining work and requested features

The MVP checklist above is complete. These are deferred or newly requested follow-ups; the
existing per-message attachment chips and mail-learned contact names are useful foundations,
but do not count as the consolidated media overview or editable contact context below.

- [ ] **Request-only beta access and measurement** — sign-in disabled for now, a public request
  form, an emailed single-use invite, a small event log, first-party feedback, and an operator page
  that answers "how many signed up, do they use it, what do they say" (see "Access is
  request-only, and the beta is measured").
- [ ] **Right-side thread media overview** — add a sidebar to the conversation view that
  collects media and attachments from every message in the thread, rather than making the
  user find each message's attachment chip. Show useful file details (name, type, size, and
  the message/date it came from), with previews or open/download actions where supported.
  Deduplicate copies introduced when mailbox threads are merged. Keep the panel usable on
  narrow screens (for example, as a collapsible drawer).
- [ ] **Editable context for an email address** — let the user save and edit a profile for a
  correspondent, with fields such as role/company (e.g. "CEO of Acme"), how they relate to
  the user, topics discussed, and what they are currently working on. Show the selected
  correspondent's context alongside the thread. Key profiles by normalised email address
  and signed-in user so the same profile is shared across that user's connected mailboxes,
  without exposing it to another user. Keep this context explicitly user-authored; incoming
  mail and AI decisions must not silently overwrite it.
- [ ] **Real-time mailbox updates** — replace or complement inbox polling with provider push
  notifications, while retaining a safe recovery path when notifications are missed.
- [ ] **User-defined organization rules** — let users define rules for grouping or organizing
  conversations beyond the current fixed state groups.
- [ ] **IMAP/SMTP provider** — add a provider that reconstructs threads from email headers
  and supports sending through SMTP; unlike Gmail and Graph, IMAP does not supply a thread id.

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
- **Signatures** are found two ways. A closing word (`--`, `Sent from my iPhone`, `Best
regards,`, `Met vriendelijke groet(en)`, `Groetjes`, `Bedankt`, `Take care`, `mvg`, …)
  within the last 12 lines wins; it is matched as a whole line, with an optional name after
  it on the same line (`Groetjes, Nils`), so a sentence that merely mentions the word never
  starts a signature. The closing list is **multi-lingual** — the Dutch standards
  (`groetjes`, `bedankt`, `groeten`) were missing, so `Groetjes,\nJan` stayed in the
  bubble.
- **The positional fallback for a signature** runs only when no closing word is found: it
  looks at the trailing block after a blank line, up to five lines, the first a name and
  the rest name/contact lines. A lone single word is deliberately **not** enough —
  `E-mailvoorkeuren` and `Unsubscribe` end newsletters the same way a first name ends a
  personal mail, so a real name left in the bubble is the cheaper error. Mid-body text is
  never touched.
- **Greetings** are the first non-empty line. A known opener (`hi`, `hey`, `dag`, `hoi`,
  `beste`, `geachte`, `hallo`, `guten tag`, …) with at most a short, punctuation-free tail
  is stripped whole, so `Dag Guillaume,` and `Hallo allemaal,` both qualify. The list is
  **multi-lingual** because the mailbox is Dutch: an unknown opener is not stripped and the
  greeting sits in the bubble — the exact failure the parser exists to prevent. A short
  opener that shares its line with the message (`Hi Sarah, how are you?`) loses only the
  salutation and keeps the question, but a **long** opener line (`Hi, I was wondering
whether we could push the launch`) is content and is left alone. A bare name plus comma
  (`Nils,`) is accepted positionally, with discourse words (`Anyway,`, `Sure,`) excluded,
  and a word boundary keeps `Dag` from matching `Dagelijks`.
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
message in the thread), and `replyable` — the user's own answer to whether a reply can reach
that sender at all, which is [a third kind of setting](#cant-reply-to-a-sender) on the same row.
Saving `replyable` writes only that column, and inserting the row for it inherits the account's
parsing defaults rather than pinning the schema's, so marking a sender never changes how their
mail is parsed.

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
- **`state` is user-overridable, and the user wins.** The label is picked on the thread —
  any of the four, or **Automatic** for the app's own answer — and stored on the row
  (`state_override`, with the activity it was said against in `state_override_message_at`),
  and `applyDecision` keeps it through every later re-decide — which is the only way it
  survives, because a sync rebuilds the thread from Gmail and would otherwise reach its own
  conclusion. A message newer than the call voids it: the judgement was about the mail that
  existed at the time.

  Two things the picker distinguishes that the original single button could not. **Only
  "Low priority" teaches the _sender_** (`sender_signals`), so the next one-off notice from a
  website is ranked low without being asked — and bringing one back switches that off again.
  The lesson used to be recorded for whatever the button sent, which was harmless while the
  button only ever sent "Low priority" and a quiet contradiction the moment it could send
  "Needs action": labelling one thread as work would have started ranking that sender's other
  mail low. And **Automatic is what an unmarked thread reads as**, even when the app happens
  to agree with the user, so the control never claims a call the user did not make.

### The decision layer is split by owner

The original `DecisionLayer` had one method returning `state`, `importance`, `urgency`,
`requiresReply`, `intent` and `currentTopic` together — the wrong shape, because the fields
have different owners:

| Field        | Owner                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------- |
| `state`      | the **user** when they have called it; otherwise **rules** when determinable (you sent last ⇒ waiting for reply), otherwise **Jev** |
| `importance` | **Jev**                                                                                  |
| `urgency`    | **Jev**                                                                                  |
| replyability | the **user** when they have marked the sender (their per-sender list); otherwise deterministic machine-mail marker **first**, Jev over everything else |
| `topic`      | **LLM**                                                                                  |
| `intent`     | the **user** — never AI-written                                                          |

Replyability is settled in that order of authority, and the user is at the top of it. Machine-mail
detection is **step 1**: an address that marks itself no-reply is settled, and Jev skips it rather
than spending a call. The user's own list — Settings → "Can't reply to" — is **step 0**, above
both; see _"Can't reply to a sender"_. It is the answer to a question the address and the
writing cannot settle, and it is typed rather than picked from a thread, so it can name a sender
before their mail exists.

**Built:** `decision.ts` is now the three-stage pipeline (`RuleClassifier` → `DecisionModel`
→ `TopicGenerator`), with `HeuristicRuleClassifier`, `PlaceholderDecisionModel` and
`NoTopicGenerator` as the keyless defaults. `syncThread` runs `decideConversation`,
`applyDecision` and `recordDecision`, so the seam is actually invoked — before this,
`buildConversation` called `deriveState` directly and **nothing ever called the decision
layer**. A keyless install is behaviourally identical to before; `intent` and `goal` are
never written by any stage (`applyDecision` no longer touches `intent`).

Where the answer is readable off the message flow the rules keep it: `waiting-for-reply` and
`low-priority` are never talked out of by the model. Everything else goes to it — a rule that
abstained (`informational` is reported as `null`), and a rule that claimed `needs-action`,
which is the claim most worth a second opinion because a false positive is filed as work. A
`null` verdict means "no opinion" and the rule stands. `merge.rebuildConversation` is the one
place the pipeline is not re-run: a merged thread reuses the stored decision of the row
holding the union's newest message, and re-reads only the message-flow facts.

**"You" stays the whole connected set** (see "Multiple accounts"). A thread between two of
the user's own addresses therefore still reads from the set, so a message from the other
address counts as the user's — even though the chat view draws sides from the owning mailbox
alone. That is a deliberate split between the classified semantics and the rendering, not an
oversight.

## AI services are configured in the UI, not the environment

`src/lib/ai/`. Both services are optional, per-install, and **bring-your-own-key**, and
the keys are set from a **Settings page**, not `.env`. A secret that lives in the
environment is a secret you cannot change without a redeploy, and this app is
local-first and single-user — the credentials belong with the data.

- **Storage.** One `app_settings` row (migration `0006`). The keys are encrypted with the
  same AES-256-GCM envelope as the OAuth refresh tokens (`auth/crypto.ts`).
- **The UI never sees a key.** `getAiSettings()` returns a summary only — configured or not,
  which model — and a stored key is shown as `••••••••`. A blank key field means "leave it as
  it is"; an explicit checkbox clears it. Only `getAiPipelineConfig()` decrypts, and only on
  the server while a client is being built.
- **Server-only, verified — with one caveat worth knowing.** `grep` over `dist/client/assets`
  finds no `TOKEN_ENCRYPTION_KEY`, no `api.typesafe.ai` and no request body, so no key, no prompt
  and no call can reach the browser. What it *does* find is the schema module's own metadata:
  `app_settings` and its column names are in `settings-*.js`, because a route imports
  `CONVERSATION_STATES` / the settings accessors and `db/schema.ts` is one module, so every table
  definition travels with it. That is column names, not credentials or queries — but the claim
  "no `app_settings` in the client bundle" is not what a grep shows. `googleapis` matches only
  `styles-*.css`, which is the `fonts.googleapis.com` import, not a leak.

| Module        | Role                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------- |
| `http.ts`     | shared JSON POST: exponential backoff + jitter, honours `Retry-After`, retries 429/5xx/529    |
| `jev.ts`      | `JevDecisionModel` — the `DecisionModel` seam                                                |
| `llm.ts`      | `LlmTopicGenerator` — the `TopicGenerator` seam — plus `completeLlm`, the shared transport    |
| `draft.ts`    | `LlmReplyDrafter` — the `ReplyDrafter` seam, on demand and never part of a sync              |
| `settings.ts` | persistence for `app_settings`, encryption at the boundary                                    |
| `index.ts`    | `pipelineFromConfig` / `loadDecisionPipeline` and `loadReplyDrafter` (both never throw)       |

**Jev's wire shape** (docs.typesafe.ai/api): `POST https://api.typesafe.ai/v1/systemone`
with `{ state, model, questions }`, where each question is a typed `noul` (yes/no),
`choice`, or `score` (an ordered rubric). It returns calibrated probabilities per answer.
Two consequences shaped the client:

- The two scores use a **ten-level rubric** so the probability-weighted value maps cleanly
  onto `importance`/`urgency` 1–10 (`round(score) + 1`).
- The **state question is only asked when the rule classifier abstained** (`facts.state ===
  null`). Asking it always would waste a call and invite the model to contradict a rule that
  is already certain.

**The LLM providers differ only in transport.** Anthropic (`x-api-key`), OpenAI (bearer), and
Gemini (`x-goog-api-key`, model in the path) each have one `complete` function, behind
`completeLlm` so the reply drafter reuses it rather than reimplementing three request shapes;
the prompt and the sanitiser are shared, and the *budget* stays with the caller — a label and a
reply want very different ones, and on OpenAI it has to cover hidden reasoning too. The sanitiser
matters more than it sounds: models wrap a short label
in quotes, a markdown fence, or a trailing period, and a chatty one adds a whole sentence —
all of that is stripped, and an empty result becomes `null` rather than an empty topic.

## Suggested replies are drafts, not sends

The spec's Reply Assistance, and the second half of the generation layer. A thread that asks for
an answer can have one drafted for the user to edit and send; nothing is ever generated for mail
that does not ask, and nothing generated is ever sent by the app.

Three properties shape the whole design:

- **The gate is one function, on both sides.** `replyDraftEligibility` in
  `conversation/draft.ts` is pure and answers one question with one sentence explaining itself.
  `loadConversation` uses it to decide whether to render the control — and, when a model *is*
  configured, to show *why not* — and `draftReply` re-runs it from the stored row before any API
  call. A button from a page rendered before the mail arrived cannot spend a call on a thread that
  no longer qualifies. The spec's four conditions are there (a reply is required, importance
  clears a threshold, the thread is actionable, a draft would help); so are the two the spec does
  not name and the app learned: nobody to reach (`replyable === false`) and the user spoke last
  (`awaitingReply`).
- **The drafter is a seam, and keyless means no call.** `ReplyDrafter` sits beside
  `TopicGenerator`, with `NoReplyDrafter` as the default and `replyDrafterFromConfig` returning
  null rather than a stub that fails. `loadReplyDrafter` reads the settings row once and never
  throws, so a broken settings read costs drafts and not the conversation being opened.
- **Nothing is persisted.** A draft is text in the composer. No column, no decision row, and no
  `router.invalidate()` — the only way it reaches the world is the existing Send, which is the
  point of "drafts for review".

### The threshold is a setting, not a constant

`app_settings.suggest_reply_min_importance` (migration `0011`), default 6, edited in Settings
under the LLM section. It is the same 1–10 the decision layer scores importance on, and
`normaliseMinImportance` clamps anything out of range on both read and write: 0 would make every
thread eligible and 99 none, and neither is a value the row should be able to hold. It travels on
the `ConversationDetail` payload as `suggestReply.minImportance` so the sentence the view shows
("Importance 4/10 — drafts start at 8") names the number it was actually compared against.

### The prompt is the whole conversation state

`buildReplyDraftPrompt` carries what the spec lists: the thread (newest last, capped at 8
messages and 1,200 characters each, so the newest — the one being answered — always survives),
the current topic, the user's goal, who the reply is going to, and any instruction the user typed
for this draft alone. It also carries the one thing the spec does not mention and the app has:
**the greeting and signature the send path is about to add**, which the model is told not to
write.

### The sanitiser reuses the parser

`sanitizeDraft` unwraps fences, quotes and a `Draft:` label, and strips a greeting or signature
the model wrote anyway — using `stripGreeting` / `stripSignature`, the *same* functions that clean
incoming mail. That is deliberately conditional, not unconditional: `composeReply` adds the
user's own pair, so a model-written one would be the second of each in the delivered mail, but
when the send path will add neither, a draft with no salutation is worse than one that repeats
itself. Hence the request carries the resolved pair, and `resolveReplyStyle` — the same function
the send path now uses — is what decides it.

### Budgets differ by provider, and Gemini is left uncapped

A draft gets 1,024 tokens, or 8,192 on an OpenAI reasoning model, since its budget also pays for
hidden thinking (the same reason the topic path sends 4,096 for a label). Gemini is the exception:
Gemini 2.5 counts thinking against `maxOutputTokens`, so capping it with a reply-sized budget
would spend it before writing anything. The prompt asks for something short and the sanitiser
enforces a 4,000-character ceiling, which is the cheaper guard there.

### In the UI

A control in the composer, and a panel once a draft exists. `Draft a reply` generates one;
`Edit` opens it for changes in place; `Use draft` puts the current text into the composer, which
refocuses; `Discard` closes the panel. **Neither action sends** — the composer's Send is still
the only thing that sends, and the draft is in the box to be reviewed before it is.

The instruction field appears *after* the first draft on purpose: asking for one should be a
single click, and "make it shorter" is something you only know once you have read what it wrote.
On an install with no LLM key the control is absent entirely; with a model configured but a
thread that does not qualify, the one-line reason is shown instead, which is what stops a missing
button from looking like a bug.

### The browser may only import the pure modules

`settings.tsx` takes the two importance limits from `conversation/draft.ts`, not from the
conversation barrel. The barrel also re-exports the repository and the decision pipeline, and the
pipeline imports the AI log, so a component that imported it pulled `node:fs/promises` into the
browser graph — Vite externalises that module and the first `appendFile` access throws. Server
functions are unaffected: the plugin strips their bodies and the imports only they use, which is
why every server-only module can still be imported at the top of a route file. Development does
not tree-shake, though, so anything a *component* names is loaded as written. The rule that
follows: if the JSX uses it, it must come from a pure module (`draft.ts`, `model.ts`,
`conversation-state.ts`); everything else belongs inside a handler.

### Verified, and what is not

Four service-level tests assert the gate **by its own sentence**: with a key stored, an
ineligible thread returns the gate's wording, and a call would have failed at the provider with a
different message — so the message is the proof no API call was made. The seam has 15 tests
(gating order, prompt contents, sanitiser edge cases), the drafter 8 against a fake fetch (each
provider's request shape, and the budget each model gets), and `resolveReplyStyle` 4.
What is *not* covered: the panel itself has no DOM harness, so its behaviour rests on typecheck
and on the server functions it calls.

## Access is request-only, and the beta is measured

The next round of work is not a feature. It is three questions: who wants in, do the people who
get in actually use it, and what do they say. Open registration answers none of the three —
there is no cap, no attribution, and no reason for anyone to tell you anything. So access
becomes **request → approval → invite**, sign-in is disabled for the beta, and the app keeps
just enough of its own data to answer those questions without a third-party analytics tool.

### The path in

1. **`/request-access`** — public, no account. Email, name, and one free-text field: "What are
   you trying to fix?" That sentence is the most useful thing a beta can collect. It is written
   before anyone has seen the product, so it cannot be reverse-engineered from behaviour, and
   it is what tells you whether the next twenty people are the right twenty.
2. **`/admin`** — the request lands in a pending queue. Approve or decline. Approving issues an
   invite bound to that address and mails the link.
3. **`/join/XXXX-XXXX-XXXX`** — the invite is the credential. Email prefilled and locked, name
   prefilled, one button.
4. **`/`** — the inbox, which asks for a mailbox. Connecting it is the first point the product
   can do anything at all.

`/request-access` is the only page a stranger can reach, and it is deliberately boring: four
fields, no marketing, no social proof. It answers with the same sentence every time — "Request
received. If it's a fit, you'll get a link by email." — whether the address is new, already
pending, already has an account, or was declined last week. Anything more specific turns the
form into an account oracle and gives a declined person something to argue with.

### Requests are rows, not an inbox

`access_requests`: `id`, `email`, `name`, `note` (the free-text answer), `source` (how they
heard, optional), `status` (`pending` | `approved` | `declined` | `redeemed`), `created_at`,
`decided_at`, `decided_by`, `invite_id`, `declined_reason`.

`redeemed` is written by the redemption itself, not by the approval, so "how many approvals
became users" is one join rather than a guess. `decided_by` is the operator's user id, for the
day there is more than one operator.

Rules:

- **One pending request per address** — a partial unique index on `email` where
  `status = 'pending'`. Submitting again returns the same sentence and writes nothing.
- **Throttled by IP in memory** (5 per hour) and a hidden field that must stay empty. This is a
  public form on a one-process install; the throttle is against scripts, not people.
- **Declining stores a reason and tells nobody.** A "you were declined" email costs a support
  conversation and gains nothing; the requester sees the same sentence they saw on submit.
- **Declined rows are pruned after 90 days** by `scripts/beta-report.ts --prune`, so the beta
  does not accumulate a permanent file of people who said no.

### Approving is one transaction and one email

Approval has a side effect that is allowed to fail:

1. Create the invite bound to the request's address (`max_uses = 1`, `expires_at = now + 14
   days`).
2. Point the request at it, set `status = 'approved'` and `decided_at`.
3. Send the email. **On failure keep the approval**, record the error, and show a "Resend"
   button beside the row. Rolling back a decision because the mail provider had a bad minute
   would throw away the decision, not the mistake.

The email is plain text and one link:

```
You asked for access to Lumen. It's ready:

https://lumen.example/join/XXXX-XXXX-XXXX

The link works for 14 days.
```

No tracking pixel, no HTML template, no unsubscribe footer — this is transactional, and a beta
invitation that reads like a marketing blast is a bad start. `LUMEN_APP_URL` supplies the
origin; a link built from `request.url` is wrong behind the reverse proxy that will host this.

Sending needs no provider at all: **the operator's own connected mailbox sends it.**
`sendNewMessage` in `src/lib/mailbox/send-new.ts` already does the whole job — ownership check,
address parsing, the operator's greeting and signature, Gmail or Graph, the contacted-address
book, and a thread refresh — so an invite is one more new message from a real address. No ESP,
no DKIM or SPF to arrange, no second bill, and a reply to the invitation lands in the inbox the
product is about.

What that costs: the operator needs a mailbox connected before approving sends anything.
`src/lib/invites/notify.ts` picks the sender — `LUMEN_INVITE_SENDER` when it names one of the
operator's addresses, otherwise the first connected mailbox — and when there is none, the
approve button still works and shows the link to copy. `invites.notified_at` records a send the
provider accepted, `notify_error` records the last failure, and Resend retries against the same
invite rather than minting a second code.

### Login is disabled for now

There is no sign-in form for beta users. An invite code is the credential, the address on
`/join` is the identity, and mailbox OAuth stays what it already is: the thing that proves the
address works and the source of the mail. Passwords, argon2 hashes, the sign-in throttle and the
30-day sessions all stay in the code. They are behind a mode, not deleted, because this is a beta
decision rather than an architecture one.

`LUMEN_ACCESS_MODE` selects the entry point:

| Value    | Entry                                                | For                |
| -------- | ---------------------------------------------------- | ------------------ |
| `invite` | `/join/…` — invite code, or `/request-access` to ask | the beta           |
| `login`  | `/sign-in` + `/sign-up` — the existing password flow  | opening the app up |

In `invite` mode:

- `/sign-in` and `/sign-up` redirect to `/request-access`. No route reaches a password form for
  an ordinary visitor.
- `/join` validates the invite, creates the user with a **random, unusable password hash**
  (`password_hash` is `NOT NULL`, so the column stays honest and nothing can ever match it),
  starts a session, and lands on the inbox, which asks for a mailbox.
- An address already in `users` **signs back in** instead of being refused as "already
  registered", but only through an invite bound to that address. That is the recovery path for
  a cleared cookie, and the reason the approval email's link keeps working for its 14 days.
- `LUMEN_DEFAULT_USER_*` bootstrap is ignored: it exists to seed a login install without
  visiting the form, and in invite mode it would create a user nobody asked for.
- Signing out still works — the session row is deleted and the browser returns to
  `/request-access`.
- **`/admin/sign-in` keeps the password form.** Disabling sign-in for testers must not disable
  it for the operator: a 30-day cookie that expires while an invite can only be issued from
  `/admin` is a lockout with no way back. It is the same argon2 verify, and an address that is
  not an admin gets the same "Email or password is incorrect." as a wrong password.

Before flipping the flag on an existing install, every current user needs an address-bound
invite. Without one, an expired session is a lockout — there is no password reset because there
is no password. That is the one migration cost of this decision, and it is a link per person
rather than a code change.

### The invite is a row, and the code is never stored

`invites`:

| Column         | Meaning                                                                     |
| ------------ | --------------------------------------------------------------------------- |
| `code_hash`    | SHA-256 of the code. The code is shown once, at creation.                   |
| `label`        | Who it is for, free text — "Ada, from the design meetup".                   |
| `email`        | Set for every approved request. When set, only that address may redeem it.  |
| `max_uses`     | Default 1. A redemption by a _different_ address consumes one.              |
| `use_count`    | Redemptions so far, kept as a counter rather than recomputed.               |
| `expires_at`   | Default +14 days. Null means no expiry.                                     |
| `revoked_at`   | Set from `/admin`; a revoked invite is refused exactly like an unknown one. |
| `notified_at`  | When a mailbox accepted the approval email. Null means nothing was sent.    |
| `notify_error` | The last send failure, cleared by a successful Resend.                      |
| `created_at`   | Also the "issued" end of the funnel.                                        |

`invite_redemptions` records every successful redemption: `invite_id`, `user_id`, `user_agent`,
`redeemed_at`. It is what makes "which invite produced which person" answerable later; the code
hash alone cannot say who used it.

Rules worth writing down before the code exists:

- **A 12-character code from an unambiguous alphabet** (Crockford base32: no `I`, `L`, `O`,
  `U`; uppercase in the link, case-insensitive on input). Read aloud and typed by hand are both
  real delivery methods for an invite.
- **Unknown, expired, revoked and exhausted return the same sentence** — "This invite is not
  valid." A distinct message per failure turns `/join` into an oracle for guessing codes and
  tells a terminated tester that they were terminated.
- **Constant-time compare**, the same shape as the session token: hash what was submitted and
  `timingSafeEqual` it against the stored hash.
- **Redemption is throttled in memory**, like the sign-in failure counter: 8 failures per 15
  minutes for the whole process, since this is one install on one Bun process. The code space
  does the rest — guessing is not the realistic attack, a leaked link is.
- **An address-bound invite is reusable by that address.** Each redemption by someone else
  consumes a use; the invited person can come back. Two rules, one code path.
- **Only the operator mints codes** — from the request queue, from the invite form on `/admin`,
  or from `LUMEN_BOOTSTRAP_INVITE` while the install is empty. There is no public endpoint that
  creates an invite; `/request-access` creates a _request_, never a code.
- **Redemption is one statement.** `UPDATE invites SET use_count = use_count + 1 WHERE code_hash
  = ? AND use_count < max_uses AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at >
  now)` then check that a row changed. Read-then-write would let two clicks on the same link
  exceed `max_uses`.

### Six steps, not one number

The funnel has six steps, and they are separate on purpose:

1. **Requested** — an `access_requests` row exists.
2. **Approved** — an invite was issued for it.
3. **Redeemed** — someone completed `/join`.
4. **Activated** — they connected a mailbox (`accounts` row), the first point the product can do
   anything at all.
5. **Used** — they opened a thread and/or sent a reply.
6. **Returned** — activity on a second day.

Two ratios matter more than any single count: **approval rate** (are you turning away the wrong
people, or the right ones?) and **approval → redemption time** (is the email arriving, and is it
being read?). An unopened link, an opened-but-abandoned code, and a connected mailbox nobody read
are three different problems. One "signed up" number hides all three, and the whole point of the
beta is knowing which one you have.

### Metrics come from tables the app already writes

| Question             | Signal                                                | Source                          |
| -------------------- | ----------------------------------------------------- | ------------------------------- |
| Is there demand?     | requests per week, approval rate                      | `access_requests`               |
| Did the invite land? | issued, redeemed, conversion, time to redeem          | `invites`, `invite_redemptions` |
| Did they sign up?    | `users.created_at` in invite mode                     | `users`                         |
| Did it work?         | first `accounts` row, first `sync_cursors.updated_at` | `accounts`, `sync_cursors`      |
| Did they use it?     | threads opened, replies sent, threads marked done     | `conversations`, `messages`     |
| Did they come back?  | distinct active days per user, after the first        | `product_events`                |
| What do they say?    | feedback rows and ratings                             | `feedback`                      |

No charts, no export pipeline, no warehouse. The numbers are one page of SQL against the same
SQLite file the app runs on.

### Only the gaps get an event log

Most of the funnel is already provable from rows written for the app's own reasons. A separate
analytics store would be a second copy of the same facts, and a second copy drifts.

A short, **closed** list of actions leaves no trace, so `product_events` holds exactly those:

| Event                | Why it cannot be derived                                   |
| -------------------- | ---------------------------------------------------------- |
| `active-day`         | `sessions.last_seen_at` is only the latest, not a history. |
| `draft-generated`    | drafts are deliberately never stored.                      |
| `draft-used`         | the draft becomes composer text; its origin is lost.       |
| `feedback-opened`    | "ignored" and "never saw it" are different answers.        |
| `invite-link-copied` | delivery friction, not observable from the server.         |

`name` is an enum in code, emitted from one helper, so this can never quietly become a
general-purpose tracker. Nothing in an event may contain a subject, a sender, a body, a topic, or
a third party's address: the row is `user_id`, the event name, a timestamp, and at most a
conversation id. `active-day` is written at most once per session per day, on the first request
that touches `getSession`.

### Feedback is a table, not an inbox you read later

`feedback`: `id`, `user_id`, `email` (optional, user-supplied), `rating` 1–5 nullable, `message`
not null, `context` (route plus conversation id when there is one), `created_at`, `status` (`new`
/ `read` / `planned` / `fixed` / `declined`), `resolution_note`.

- **Two entry points, one form.** A "Feedback" link in the inbox header, and a single prompt
  after the user marks a thread done — the moment they have just watched the product do its job.
  Never a modal on first load, never an NPS popup, never a third-party widget.
- **One question:** "What got in the way?" plus an optional rating. The thread id travels with
  it, so a complaint about the composer arrives attached to the thread it happened on.
- **No email required.** Filling the field in is permission to reply by mail; leaving it blank
  still counts.
- **`/admin` is the loop.** Newest first, status controls, no email digest and no syncing to
  another tool. The point of collecting feedback is to close it, not to route it.

### The operator view is one page

`/admin` belongs to `users.role = 'admin'`. **The first user created on an empty install is the
admin**, and `LUMEN_ADMIN_EMAILS` (comma-separated, case-insensitive) stays as a break-glass
override: it can restore access after a bad migration or a deleted row, and it is the only way
in before the first user exists. Anyone else gets **404**, not 403: an operator page should not advertise itself
to a beta user who guesses the URL.

- **Requests** — the pending queue, newest first, with the free-text answer shown in full.
  Approve (issues the invite and emails it) or decline (with a reason). Resend on a failed send.
- **Invites** — issue a manual invite (label, optional email, uses, expiry), copy the link,
  revoke, and per invite show redeemed and activated counts.
- **Funnel** — requested → approved → redeemed → activated → replied → returned.
- **People** — one row per user: signed up, mailboxes, threads, replies, last active, which
  invite brought them.
- **Feedback** — the list above.

`scripts/beta-report.ts` prints the same numbers in the terminal, for when opening the app to
read its own metrics is the wrong tool.

**An empty install has nobody who can open `/admin`.** `LUMEN_BOOTSTRAP_INVITE` solves it: set
it, visit `/join/<code>` once, and the user it creates is the admin. The variable is honoured
only while `users` is empty, and the code is compared constant-time like any other. After that
every invite comes from the request queue or the invite form.

### One app now, two when the database is not a file

`/admin` is a route group in the application, not a second site. Three reasons, in order of how
hard they are to work around:

- **The database is a file** (`DATABASE_URL=file:./data/lumen.db`). A second deployment on
  another host cannot open it; separating the admin is a migration to a network database first,
  not a UI decision.
- **The session cookie is the identity.** Same origin makes `requireOperator()` one function.
  A separate origin needs either a second auth system or cookie-domain work, for no extra
  safety — the boundary that matters is the server-side check, not the hostname.
- **One process, one deploy, one set of secrets.** At this size that is the difference between a
  tool you maintain and a tool you avoid touching.

So the boundary is drawn in code instead: `src/lib/admin/`, `src/lib/invites/`,
`src/routes/admin.*`, its own layout, and no component shared with the inbox.
Every admin server function calls `requireOperator()` itself rather than trusting the route
loader, because a server function is a public endpoint with a nicer syntax.

The layout that makes the split mechanical later is a workspace one, even while there is a
single app:

```
apps/web            the inbox, /join and /request-access
apps/admin          later; the operator page as its own deploy
packages/db         schema, client, migrations, and the one migrator
packages/core       auth, invites, email, metrics — no React
packages/ui         later, if the two apps actually share components
```

Moving to that is `git mv` and one alias change (`#/db/schema.ts` becomes `@lumen/db`), which is
cheap exactly as long as no inbox component imports an admin module. The rule that keeps it
cheap: **`src/lib/admin` and `src/lib/invites` may import from `core` and `db`, never from
`components`, and nothing in `components` may import them.**

The split earns its keep when the database stops being a file:

- **Redemption becomes genuinely concurrent.** The conditional `UPDATE … RETURNING` above is the
  whole guard in both engines — but SQLite serialises writers, so a read-modify-write bug would
  hide there and surface under Postgres. Keeping the single statement now is what makes the port
  uneventful.
- **In-memory throttles become wrong.** The sign-in failure map, the invite-failure counter and
  the request throttle are per-process. The moment two processes exist they need a table or a
  shared store; until then they are correct and free.
- **The schema port is mechanical but not small.** `sqliteTable` → `pgTable`, `integer` with
  `timestamp_ms` → `timestamptz`, `unixepoch() * 1000` defaults → `now()`, and the PRAGMA/WAL
  block in `db/index.ts` disappears in favour of a connection pool. Migrations start again: the
  data moves by dump and restore, not by `drizzle-kit push`.
- **`packages/db` owns the migrator**, and both apps import it. That is the real reason to split
  — one schema, one migration run, two consumers — and it is why the split waits for the
  database rather than the monorepo.

### What this deliberately does not do

- **No marketing or lifecycle email.** One transactional message per approval, and that is the
  whole list. No drip, no "you haven't tried drafts yet".
- **No third-party analytics**, session recording, or error tracking. The instrumentation is
  these five tables.
- **No self-serve approval and no invite requests by email.** A request is a row on
  `/request-access`; an email to you about it is a message you have to file.
- **No roles beyond admin.** One operator, one `role` value that matters.
- **No password reset**, because invite mode has no password for a tester.
- **No metrics for someone who never connected a mailbox.** They are a user with zero mailboxes,
  counted as redeemed and not activated — which is where the funnel says so.

### Prerequisites, and what is already true

- **Mailboxes are already per-user.** `accounts.user_id`, `listAccounts(userId)`,
  `assertOwnedAccount`, and the merge path all scope by the session's user, so inviting a
  stranger does not show them anyone else's mail. This had to be true first; it is.
- **One mailbox, one person.** `accounts_email_idx` is unique on email and `upsertAccount`
  refuses a mailbox owned by somebody else rather than reassigning it. For a beta that is
  correct, and it is why a second person connecting an already-connected address gets an error
  instead of the first person's history.
- **Removing someone is a delete.** Sessions, mailboxes, conversations and settings cascade from
  `users`, so "uninvite" is one row — which is the answer to a question every beta eventually
  asks.
- **Not yet true, and needed before the first invite goes out:** `users.role`, the mode flag,
  `/request-access`, `/join`, the request/invite/feedback/event tables, `/admin`, the invite
  notification, and the throttle. That is the build order below.

### Build order

1. **Migration** — `access_requests`, `invites`, `invite_redemptions`, `feedback`,
   `product_events`, plus `users.role` (default `member`; the first user is `admin`).
2. **`lib/invites/`** — `createInvite`, `revokeInvite`, `redeemInvite` (hashed lookup,
   single-use, address-bound reuse), `listInvites` with counts. Unit tests for every refusal:
   unknown, expired, revoked, exhausted, wrong address, reused by the right one.
3. **`LUMEN_ACCESS_MODE=invite`** — `/join`, the redirects on `/sign-in` and `/sign-up`, the
   random password hash, the existing-user path that signs an invited address back in, and
   `/admin/sign-in`.
4. **`/request-access`** — the form, dedupe, throttle, and the one refusal sentence.
5. **`lib/invites/notify.ts`** — send the invite through the operator's mailbox, the
   no-mailbox path that offers the link to copy, and the failure that keeps the approval.
6. **`/admin`** behind `requireOperator()` — the request queue, invites, and the funnel.
7. **Feedback** — the after-Done prompt, the header link, and the list in `/admin`.
8. **`product_events`** at the closed list of sites, with `active-day` on `getSession`.
9. **`scripts/beta-report.ts`** (with `--prune`) and `LUMEN_BOOTSTRAP_INVITE`.
10. **Tests** — redemption refusals, invite-mode signup (one user per redemption, never two),
    the admin gate (404 for a member, allowlist override), approval email failure, feedback
    validation, and a check that no raw code and no IP is stored.

## Auth

`src/lib/auth/` — people, sessions and provider OAuth. Google and Microsoft OAuth 2.0 with PKCE
sit alongside an email/password sign-in (`users.ts`, argon2id) and revocable server-side
sessions (`session.ts`). For the beta the password flow is switched off — see "Access is
request-only" above.

| Module        | Role                                                     |
| ------------- | -------------------------------------------------------- |
| `crypto.ts`   | AES-256-GCM token encryption at rest                     |
| `users.ts`    | people, argon2id hashes, bootstrap, sign-up rules        |
| `session.ts`  | one revocable row per device; cookie is `<id>.<token>`    |
| `google.ts`   | OAuth2 + PKCE, token exchange, Gmail client              |
| `accounts.ts` | persistence — the only place tokens are decrypted        |

Routes: `GET /sign-in`, `GET /sign-up`, `GET /auth/google`, `GET /auth/google/callback`,
`GET /auth/microsoft`, `GET /auth/microsoft/callback`, `GET /auth/logout`. In `invite` mode
the sign-in and sign-up pages redirect to `/request-access` (the operator's `/admin/sign-in`
stays), and the rest are unchanged.

Security decisions:

- **Refresh tokens are encrypted before they touch the database.** Anyone with the
  database file gets permanent mailbox access otherwise. `encrypt()` is called inside
  `upsertAccount`, so the plaintext token never crosses the persistence boundary.
- **The session cookie holds an opaque id and a random token**, and only the token's SHA-256
  is stored. Signing out deletes the row, so a copied cookie stops working on its next
  request — which a self-contained signed cookie cannot do.
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

On-demand actions need the same treatment, because they fail **outside** a sync: a reply
is sent with `users.messages.send` and the thread is re-fetched to make it appear, and
neither of those is covered by the inbox's staleness check. A rejected grant there used to
surface as the raw `GmailAuthError` text in the composer. `describeActionFailure(error,
fallback)` now classifies the failure: when a fresh login is the fix it returns a message
that names the action plus `authRequired: true`, and the composer renders a **Reconnect
Google** link beside the error; every other failure keeps its own message. It is the same
`needsGoogleLogin` predicate that `runSync` uses, so "this needs a re-login" is decided in
one place.

### Known gaps

- Multi-user, but one install: `users.role` is the only role (`LUMEN_ADMIN_EMAILS` is the
  break-glass override), and there is no password reset or email verification. An address is
  only proven when its mailbox is connected.
- Invite mode has no second factor: the code is the whole credential, so a forwarded invite
  link is access. That is why codes expire, are single-use by default, and are revocable.
- `SESSION_SECRET` falls back to `TOKEN_ENCRYPTION_KEY` for local convenience.
- Reconnect is surfaced on the inbox and on a failed send in the composer. The
  parsing-profile save in the conversation header still reports a re-parse failure as a
  plain message rather than offering the reconnect action.
- `prompt: 'consent select_account'` is sent on every `/auth/google` visit. `consent`
  forces a refresh token rather than silently reusing the grant, which is what makes the
  reconnect button reliable; `select_account` forces Google's account chooser, without
  which adding a _second_ mailbox would re-authorize the account the browser is already
  signed into. It costs a second consent screen.

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

### Quota errors are 403, not 429, and must be retried

A real mailbox hit this on first connect:

```
Sync failed: Gmail request failed (403): Quota exceeded for quota metric
'Total Query Cost' and limit 'Units per minute per user' of service
'gmail.googleapis.com'
```

Two bugs sat behind that one line. **`wrapGmailError` only mapped `429` to
`GmailRateLimitError`**, but Gmail reports an exhausted per-user rate limit or daily
quota as **`403`** with `reason: 'rateLimitExceeded'`/`'quotaExceeded'` — or, on the newer
quota model, only a message naming the metric and no reason at all. The typed error
existed but was effectively dead for real Gmail traffic, so the response fell through to
the generic `Gmail request failed (403)` and aborted the sync. Both the reason codes and a
message match (`/quota exceeded|rate limit exceeded|…/i`) are now classified, and a plain
403 is left alone.

**Nothing retried.** `createGmailApiClient`'s `req` wrapper now retries a
`GmailRateLimitError` with exponential backoff and full jitter (base 1.5s, cap 30s, four
retries), honouring Google's `Retry-After` header when it is present. Only rate limits are
retried — auth, 404 and real 5xx keep their existing behaviour. The policy is injectable
(`GmailRetryPolicy`) so the loop is tested without real timers.

`CONCURRENCY` also dropped from 4 to 2. Four concurrent `threads.get` calls is enough to
trip the per-minute cost limit on a fresh backfill, and retry only turns a fatal burst
into a recoverable one — the cheapest fix is to not create it.

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
| `routes/index.tsx`     | `createServerFn` loader + the revalidation timer (two minutes idle, three seconds while syncing) |
| `components/inbox.tsx` | The list, grouped by state, and the sync-progress banner                                        |

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

### A first sync is not something to wait for

Adding a mailbox used to look like a hang. The OAuth callback redirects to `/`, the loader
called `loadInbox`, and `loadInbox` **awaited** the sync — so the page did not render until a
30-day backfill, plus a decision (and possibly an LLM topic call) per thread, was finished.
Minutes of a blank screen, and nothing to say whether it was working.

A first sync is now started in the background and the request returns immediately with
progress instead of a result:

- **Never-synced is the trigger, not `full`.** The long run is the initial backfill; an
  incremental sync is a handful of threads and staying in line for it is correct. A
  deliberate Re-sync still awaits, so its button can report the outcome.
- **Progress is published, not guessed.** `runSync` keeps a `syncProgress` map — mode,
  threads processed, and the total — updated from `onProgress`. The total only exists after
  `threads.list` finishes paging, so the sync emits a `listed` event for it rather than
  pretending `start` knew.
- **The banner is fed by the payload, the polling by the sync.** `loadInbox` reports the
  in-flight runs as `syncing`, and the route drops its poll from two minutes to three
  seconds while any of them is running — which is also what makes mail appear in the list
  as it lands, since the backfill writes each thread as it goes.
- **A fire-and-forget run has no `await` to report a failure on.** So the outcome is kept in
  a `lastOutcome` map after the run ends, and the next load reports it. It deliberately
  does **not** restart on that next load: a retry that began immediately would overwrite
  the error before it was ever rendered, which is the silent hang all over again. The
  existing **Re-sync** button is the retry, and the existing reconnect banner still covers
  a revoked grant.

Both maps are process-local, like `inFlight`. The app is local-first and single-user, so
"the sync this install is running" and "the sync this process is running" are the same.

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

## Multiple accounts, one inbox

Accounts are **owned by a user**, not by a browser session: every mailbox a signed-in person
connects appears in one merged list, and no query reaches another person's row. There is no
account switcher — the mailbox set is the set. Two decisions shape the rest.

**1. Merge by shared `Message-ID`, always.** When both of your addresses are on a thread,
Gmail stores it as two threads with different ids and overlapping messages.
`messages.internet_message_id` is the RFC 5322 `Message-ID` — the _same string in every
mailbox that received that message_ — so "these two conversations are the same thread" is
exact rather than a subject/participant guess.

**2. What the thread _means_ depends on how your accounts relate to it.** Classified from
the stored `from` / `to` / `cc` of the cluster's messages:

| Relation                | Detection                                                  | Reply from (default)                            |
| ----------------------- | ---------------------------------------------------------- | ----------------------------------------------- |
| `between-your-accounts` | one of yours in `From`, another of yours in `To`/`From`    | the account the newest message was addressed to |
| `primary`               | exactly one of yours in `From`/`To`, the rest only in `Cc` | the primary account                             |
| `cc-only`               | all of yours appear only in `Cc`                           | the account the newest message was addressed to |

A `primary` cluster is one row owned by the primary account. The CC'd address is an
annotation and is **excluded from state and urgency**, so a passive copy never makes a
thread look like it needs action. A `cc-only` cluster is one row ranked low — someone
else's thread that happens to be copied to two of your addresses.

**Merge at the message level, not the conversation level.** Folding two stored
conversations together after the fact means re-deriving `state`, `participants`,
`messageCount` and `lastMessageAt` from a union that no rule was written against.
Instead the cluster's messages are unioned first (by `internet_message_id`, falling back to
the provider message id) and a single build pass runs over them, so `deriveState` and the
rest still see one ordered thread.

**"Mine" becomes a set.** `cleanMessage` compares against a single `context.ownerEmail`.
With more than one connected address, a message from your _second_ address inside a thread
you own would render as a stranger's — left-aligned, and counted as an inbound turn. The
owner set replaces the singular email. `is_from_account_owner` is stored per row from a
one-owner sync, so this also needs the existing re-derive pass — bump `DERIVED_VERSION`,
which `reparseStoredMessages` already drives.

**Reply follows the conversation, not the session.** `sendReplyAction` and
`saveParsingProfileAction` build their Gmail client from `session.accountId`, and
`requireConversation(session.accountId, …)` scopes the lookup. With global accounts both
must use `conversations.accountId` instead, or a reply leaves from the wrong address. The
composer shows the chosen sender and allows picking when more than one of yours is on the
thread.

**Reconnect and staleness are per account.** One revoked mailbox must not blank the merged
list: `loadInbox`'s `authRequired` becomes a per-account list so the banner can name the
mailbox that needs it, and `lastSyncedAt` is per account too.

**Deleting a mailbox is per account; signing out is per install.** The session cookie is
the only place that still names one account — everything else resolves its own — so
`forgetAccountAction` clears it **only when that was the last mailbox**. It used to clear it
whenever the deleted row was the session's own, which stranded an install that still had
mail on the "connect a mailbox" screen and made the user re-authorise an account they never
lost. With one still connected the session is simply re-pointed at it.

The same delete also has to survive the flip it performs. `settings.tsx`'s signed-out branch
used to sit above the form's twenty-odd `useState` calls in one component; invalidating the
loader flipped `signedIn` to false **in place**, so the next render called fewer hooks than
the previous one and React refused it ("Rendered fewer hooks than expected"). The branch is
now its own component, the way `Inbox` was already written for exactly this reason. Both
failure modes were reported together — an error, then a connect prompt with a live mailbox
behind it — and they are two halves of one event: the clear, then the re-render.

### How it is built

`src/lib/conversation/merge.ts` is the whole of it, and it is pure — no database, so the
rules are testable on their own.

1. **Cluster** the loaded conversations with union-find, joined by any shared
   `internetMessageId`. A message with no `Message-ID` (a synthetic one) stays in its own
   cluster, since only a real one can be shared across mailboxes.
2. **Classify** the cluster from the stored `from`/`to`/`cc` — see the table above. A direct
   sighting anywhere outranks a CC one anywhere.
3. **Choose the owner**: the newest message's addressee if that address is one of yours,
   else the sole correspondent, else the first CC'd address. The owner is what the row's
   details editor, sender profile and default reply address use.
4. **Rebuild once**, from the union of messages with `isFromOwner` recomputed against the
   _set_ of connected addresses, and with attachments deduped on
   `filename|size|contentId` (not on the provider attachment id, which differs between
   mailboxes holding the same message).

```
loadInbox()
  → listAccounts()
  → per account: ensureDerivedFields, staleness check, opportunistic sync
  → listConversations(account) each
  → mergeAccountConversations(...)
  → sort by lastMessageAt, count by state
```

The account argument is gone from `loadInbox()` and `loadConversation()`; `getSession()` is
now only the "this browser is signed in" guard. `getConversationByThreadId` resolves a
thread across accounts rather than inside one, and the reply and sender-profile actions read
`conversations.accountId` instead of the session's — otherwise a reply leaves from the
wrong address.

The composer shows which address a reply will leave from and offers a picker when more than
one of the user's addresses is on the thread; `sendReplyAction` recomputes the allowed set
server-side rather than trusting the client. `InboxPayload.authRequired` became
`authRequiredAccounts`, so one revoked mailbox is named without blanking the others.

**Adding a mailbox is an action on the signed-in inbox.** The only sign-in prompt is the
signed-out one, so a user already connected to one mailbox had no route back to
`/auth/google` and could not add a second. The inbox header now carries an **Add mailbox**
link beside the connected addresses; because accounts are global and `upsertAccount`
inserts by email, re-running the OAuth flow connects the new mailbox alongside the
existing ones and the session cookie simply moves to the newest account.

**Rebuilt conversations reuse the stored derived fields unless a merge actually happened.**
With one mailbox holding the thread and the connected set unchanged, `state`, `urgency`,
`isAutomated` and friends are taken from the row as-is — they belong to the decision layer,
and re-deriving them here would override a stored decision and mask the deliberate
`DERIVED_VERSION` behaviour. Only a genuine merge (more than one source) or a second one of
your addresses appearing on the thread triggers recomputation. Verified against a copy of
the real mailbox: 59 stored conversations and 59 merged rows, byte-identical on
subject/state/count/ordering.

Step that is **not** done, and is what a second service needs first: `accounts.provider`
(default `'gmail'`) and `UNIQUE(provider, email)` replacing the global `accounts_email_idx`,
plus renaming the `gmail_*` id columns to `provider_*` while there is still only one
provider.

**Scoping, stated because the beta depends on it:** mailboxes are per user
(`accounts.user_id`), every listing and lookup is scoped by the session's user, and the two
paths that take an account id from the client (`sendReplyAction`, `saveParsingProfileAction`)
go through `assertOwnedAccount`. Two consequences worth keeping: an address can be connected
to only one account on the install (`upsertAccount` refuses it rather than moving the row and
its synced history), and deleting the user removes their mailboxes and conversations with it.

### A merged thread is a *cluster*, not a thread id — the detail view has to re-merge

Learned from the real mailbox: a thread _between two of the user's own accounts_ looked
broken, and the specific symptom was that opening a merged row showed one mailbox's mail
and hid the other's.

The rows were there — the inbox merges them correctly — but **the detail view never
re-merged**. `loadConversation` loaded the single stored conversation the row's
`gmailThreadId` pointed at. A thread id is mailbox-scoped, and Gmail does **not** always
group a message the same way in the sender's and recipient's mailboxes: on the test
mailbox, one address held the conversation as a nine-message thread while the other held
the same messages as **seven separate single-message threads**. The merge picked the
owner as the account the newest message was addressed to, so the row's thread id pointed
at a one-message fragment. The inbox said "9 messages"; opening it showed 1.

`getConversationClusterByThreadId` now resolves the **Message-ID-connected component**
(BFS over message ids, transitively — the fragments only link through the ids they carry),
and both `loadConversation` and `requireConversationByThreadId` fold it back with the same
`mergeAccountConversations` the inbox uses. Verified against the real data: both the
fragment id and the complete id resolve to the same 8-source cluster of 9 messages.

**The canonical row is the owner's most complete copy**, not the first one found. Cluster
order is not stable — the inbox and the detail view can feed the same cluster in different
orders, and an order-dependent choice would move the row id (and the topic/goal stored
against it). Ties break on thread id for determinism.

### Between your own accounts, the chat is drawn from the owning mailbox

With the cluster fixed, the second half of the weirdness was presentational. `isFromOwner`
is deliberately the whole connected set, so in a thread between two of the user's accounts
**every** message is "yours" — the chat rendered everything right-aligned as "You", a
person talking to themselves down one side.

The view now renders from the **owning mailbox's point of view**: messages from
`detail.accountId` are "You" on the right, and messages from another of the user's
addresses are the other side, labelled with that **address** rather than the display name
(both accounts are, after all, the same person's name). `ownerEmails` on the detail payload
is what lets the view tell an own-address from a stranger. This is a rendering decision and
leaves `isFromOwner` — and therefore state derivation — untouched; the two only coincide
for single-account installs.

### Outlook is the second service

Outlook.com and Microsoft 365 are the second provider, through Microsoft Graph. The work was
mostly making the seam real rather than writing a second app:

- **One interface, two adapters.** `src/lib/mailbox/types.ts` defines `MailboxClient` — the
  six methods sync needs, plus an optional `sendReply` for providers that model a reply
  instead of a raw message. Gmail implements it in `lib/gmail/client.ts`; Graph in
  `lib/microsoft/client.ts`. `createMailboxClientFor` is the only place an account row turns
  into a client.
- **Graph is JSON, so the adapter synthesises MIME.** `microsoft/message.ts` turns a Graph
  message into the same tree Gmail returns: a text or HTML part, headers, and one leaf per
  attachment. The parser, the quote/greeting/signature stripping and the attachment walker
  therefore have one implementation, not two.
- **Cursors are `sync_cursors(account_id, kind, value)`.** Gmail's value is its `historyId`
  (`kind='history'`); Graph's is an ISO timestamp (`kind='received'`). The table also carries
  `updated_at`, which is the staleness clock — the old `accounts.history_id` could not be,
  because token refreshes bump that row too. The migration renames the Gmail-shaped columns
  (`provider_thread_id`, `provider_message_id`, `provider_attachment_id`) and copies the old
  cursor rows across; it does not drop and recreate them.
- **Graph's cursor is a timestamp on purpose.** Delta endpoints need a `deltaLink`, and
  establishing one means enumerating the mailbox first. `receivedDateTime ge <cursor>` is
  exact for the case the app has — new mail, including a new message in an old conversation —
  and costs one page. A cursor that is not an ISO timestamp is refused so the next sync
  backfills instead of filtering on a value from the other provider.
- **Sending differs and the seam says so.** Gmail takes a raw MIME message built by
  `send.ts`; Graph takes `createReply`, a body `PATCH`, optional attachment uploads and
  `send`, so its adapter implements `sendReply`. Both receive the same composed body —
  greeting, signature and quote — so the recipient gets the same mail either way. Graph's
  simple-attachment ceiling is 3 MB, which is checked before an upload rather than after.
- **Auth shares the round trip.** `lib/auth/oauth.ts` owns the state cookie, the PKCE
  verifier and the challenge; `google.ts` and `microsoft.ts` supply endpoints and scopes.
- **What is still not done:** IMAP. Gmail and Graph both give a thread id and a cursor, so
  neither needs threading reconstruction; IMAP does, and that is the expensive part. Graph
  attachments over 3 MB need an upload session. Both are recorded rather than pretended.
- **Already neutral, and still worth keeping that way:** the MIME parser, HTML sanitiser,
  quote / greeting / signature stripping, no-reply detection (address-based), the conversation
  model, and the decision layer.

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

### Can't reply to a sender

The markers only catch senders that say so in their address, and Jev can only read what the
writing shows. A company writing from an ordinary address (`updates@`, `account@`) with mail
there is nothing to answer — a view-only notice, an invoice, a statement — is invisible to
both, and the user is the only one who knows.

So replyability has a third owner, above the other two: `sender_profiles.replyable`, per
mailbox and per sender address, managed in **Settings → "Can't reply to"** and nowhere else —
the address is typed into a form there, with the mailbox picked when more than one is
connected, and each entry has an **Allow replies** button to take it back. It is
stored rather than inferred, for the same reason `state_override` is: a sync rebuilds a thread
from Gmail and knows nothing about what the user said, so the answer has to live somewhere the
decision path reads. `decideAndSave` reads it per sender, `HeuristicRuleClassifier` reports it
as a fact, Jev is **not** asked the replyability question for a marked sender, and
`isAutomatedThread` stays the authority on machine mail — taking a mark back can never hand a
composer to a `noreply@` address.

Five deliberate choices:

- **One list, with two ways in.** The list is still the thing the user curates, and still the
  only place the mark is *managed* — each entry has **Allow replies** to take it back. What it
  is no longer is the only place one can be *added*. Marking a sender used to mean recognising
  them in a thread and then finding the address again somewhere else to type it, so there are
  now two shortcuts and one exit: a **Can't reply** button on the thread, which resolves the
  mailbox and the address from the mail on screen, and a one-click list of the addresses the
  mailbox has actually received from, above the form. Undo deliberately stays in Settings alone,
  so the thread gains a second way to make the mark without becoming a second place it is
  edited. `applySenderReplyabilityToSender` is still the single write every direction goes
  through, so an entry made from a thread and one made from the form cannot diverge — and the
  free-text form stays for what neither shortcut can do: naming a sender **before** any mail
  from them has arrived.
- **The picker offers only senders whose threads still show a reply box.** One filter doing
  three jobs — a sender already marked drops out (the sweep set all of their threads to
  `replyable = false`), a machine sender drops out (they are already unanswerable without anyone
  being asked, so a mark would change nothing), and marking one in the list makes it vanish from
  the list on the reload that confirms it. The user's own addresses are excluded separately,
  because a thread between two of their mailboxes has a non-owner side that is still theirs.
- **The mark covers the sender, not the thread.** That is what the user is answering: this
  company's mail is one-way, not just this one message. Every future thread from them inherits
  it, and `setReplyableForSender` sweeps the threads already stored at the moment of the entry,
  because the decision layer only runs on mail Gmail reports as changed.
- **Only the composer is hidden.** The state is left exactly where the decision layer put it.
  The user is saying they cannot answer this sender, not that the mail does not matter, so the
  thread stays listed where they found it — unlike machine mail, which also ranks low.
- **A merge carries the verdict.** `isAutomated` on the row is what tells a *decision* (the
  user's mark, or Jev's reading) apart from the *marker*: a decision is reused rather than
  re-derived, while machine mail is recomputed from the union so a thread a human finally
  answers becomes replyable again.

Known limits, on purpose: the mark is per **address**, so a company mailing from two addresses
(`updates@` and `invitations@`) takes two entries; the address is checked for shape only
(`isSenderAddress` in `model.ts`), so a typo is stored and simply never matches; and nothing
reads the message body, so a
signature saying "this address is not monitored" is not detected — a strict phrase list would
have to reach bodies into `isAutomatedThread`, which risks false positives on quoted text.
Replyability is also not persisted as a *state*, so a marked thread still counts in
`needs-action` when the decision layer put it there.

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

**Bump `DERIVED_VERSION` whenever a derived column is added to `conversations`, or the
parser changes.** Otherwise the same silent-staleness bug returns.

User-owned columns are the exception: `seen_at`, `done_at` and the can't-reply mark are not
recomputed by the backfill at all — it writes only `is_automated` and `replyable` — so there is
nothing to recompute and nothing to bump. What they need instead is the opposite guarantee:
every path that rebuilds a thread must *carry* them (`getStoredUserFields`), or a sync silently
resets an answer the user gave.

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

### Parsing changes fix themselves locally — mostly

`DERIVED_VERSION` (now 3) began as a way to recompute a new _column_ from the local
`messages` table. A parsing change looks like it cannot use that, because the raw MIME was
never stored — but the text the old parser wrongly **kept** is right there in
`messages.body_text`.

`reparseStoredMessages` uses that: it rebuilds the pre-strip text from the row's own pieces
— `greeting_text` + `body_text` + `signature_text` + `stripped_quote` — and runs the parser
again, so a detection fix reaches mail already in the database with no Gmail round trip. It
runs from `ensureDerivedFields` when the stored version lags, and is idempotent. Stored
HTML is trimmed only when the pass actually detects text the old parser missed, because
re-serialising an untouched document normalises markup (`<br />` becomes `<br>`).

The direction it cannot fix is text a previous parser wrongly **removed** — that text is
only in the raw message. For that, `scripts/rebackfill.ts` re-fetches threads **by id**, not
by search query — a `newer_than:30d` query returns whatever is still inside the window (6
threads out of 31 on this mailbox, because mail ages out of a date range whether or not
the app still shows it), whereas ids come from the database, so every conversation already
in the inbox is fixed and nothing else is pulled in.

Worth remembering: `--missing-html` is _not_ sufficient after an HTML/rendering change. It
skips threads that already had a `body_html` value, which is exactly the ones holding the
old unsanitised markup. Run the full re-fetch. (It is still the flag to use when the plain
body is fine and only HTML is missing.)

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

### Read is not doing

Open threads and finished threads used to look alike, and the difference that matters is not
"have I looked at this" but "have I dealt with this". They are now two separate stored answers,
and keeping them separate is the whole point:

| Mark | Column | Set by | Shows as |
|---|---|---|---|
| Read | `conversations.seen_at` | opening the thread | unread dot in the inbox, "New messages" divider in the thread |
| Done | `conversations.done_at` + `done_message_at` | the **Mark done** button, and nothing else | a Done tag, a line on the thread saying what it means, and a move to the **Done** section at the bottom of the inbox, with **Reopen** to take it back |

- **Viewing never marks a thread done.** That is the failure the mark exists to prevent: a
  thread that files itself away when it is opened is one nobody comes back to reply to. Neither
  does a sync, a re-decide, or the send path — only the user says "done".
- **Read is a high-water mark, not a flag per message.** `saveConversation` replaces a thread's
  messages wholesale on every sync, so a column on `messages` would be wiped by the next sync of
  that thread and the user's reading would silently come undone. The mark is also forward-only:
  the view reports the instant it had on screen, so mail that synced in after the page rendered
  is not marked read by it.
- **Done changes where a thread is *listed*, not what it *is*.** The state column is never
  rewritten — "handled" is not a claim about what the mail needs — but `partitionByState` counts
  a done thread outside the state groups, so it stops appearing under "Needs action" and sits in
  its own section. That split is the point: the headings above it are what still wants
  attention, and a finished thread listed among them was the confusion the marks exist to fix.
  The tag inside the Done section shows the state it had, faintly, so nothing is hidden.
- **The words live in one place.** `READ_META`, `DONE_META` and `DONE_GROUP` in
  `conversation-state.ts`, next to `STATE_META`: one is a fact the app noticed (you have not
  opened it) and the other is a decision the user made (you have dealt with it), which is a
  distinction nobody should have to infer from a dot and a tag. The inbox header carries the
  one-line legend.
- **Newer mail voids it**, using `activeDone` and the same rule as `activeStateOverride`: the
  mark was a judgement about the messages that existed then, and a thread that receives a reply
  comes back on its own.
- **A rebuild has to carry both.** Gmail knows nothing about either, so `decideAndSave` and
  `refreshThread` read them back with `getStoredUserFields` before saving — one read for all
  three user-owned fields (`state_override`, `seen_at`, `done_at`), because reading one and
  dropping another is exactly the bug that shape invites. A merge carries Done (voided against
  the union's newest message) and *unions* Read, since reading a thread in either mailbox means
  the user has read the mail.

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
- **A new `app_settings` column needs its migration applied before the dev server restarts.**
  The settings row is read with `findFirst`, which selects every declared column, so the app does
  not fail on a *missing* table — it fails on a column that exists in the schema and not in the
  file. `bun run db:generate && bun run db:migrate` is the whole fix.
- Bump `DERIVED_VERSION` when adding a derived column to `conversations` or changing the
  parser. Incremental sync will not revisit unchanged threads, so without it the new column
  stays at its migration default forever and nothing reports a problem.
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
