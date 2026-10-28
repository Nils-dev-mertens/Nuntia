# Organizations — what Nuntia is, and where the shared version goes

**Status: direction, not a design.** Nothing here is built, and most of it is not
decided. The purpose of this document is to separate two things that are easy to
mix up: what the product _is_ today, and what a version for a company would have
to become. The decisions, once made, belong in [PLAN.md](../PLAN.md); this is the
orientation that makes those decisions legible.

Short version: Nuntia is one person's memory of their correspondents. An
organisation needs several people to share a few of those memories without
sharing the rest, and that is a schema decision before it is a feature.

## What Nuntia is today

A chat-style mail client. Gmail and Outlook are read through one sync pipeline
and merged into a single inbox; threads render as conversations, with the
greeting, signature and quoted history stripped at parse time and restored on
send. Deterministic rules classify each thread, Jev (optional, your key) scores
importance and urgency, an LLM (optional, your key) names topics and drafts
replies. The app only ever reads and sends mail; drafts are text in the composer
and nothing is sent without the user.

It is a private beta: sign-in is replaced by an invite, an operator approves
people from `/admin`, and usage is measured from the app's own tables. One
installation is one SQLite file on one Bun process — there is no server to
operate and no second copy of the data.

### One person, one install

Every row that matters is reached through the signed-in user:

| Area                        | Owned by today                                                    | What an organisation needs                                    |
| --------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------- |
| Mailboxes and tokens        | `accounts.user_id`; one address, one owner (`accounts_email_idx`) | Each member connects their own address; no sharing by default |
| Threads, messages, files    | `conversations.account_id` → that mailbox → that member           | Unchanged; a shared view only by assignment                   |
| Read, Done, state overrides | the conversation row, written by that member                      | Unchanged — these stay personal                               |
| Contact context             | `contact_contexts (user_id, email)`                               | Possibly shared `kind`, private notes (open)                  |
| Inbox sections              | `organization_rules.user_id` — the name means grouping, not orgs  | Likely organisation-wide (open)                               |
| Parsing / reply style       | `sender_profiles.account_id`, i.e. per mailbox                    | Probably per member (open)                                    |
| AI keys and settings        | `app_settings.user_id`                                            | Per organisation or per member (open)                         |
| Invites, access requests    | install-wide rows                                                 | Per organisation and per seat (open)                          |
| Operator access             | `users.role`, first user is admin, `LUMEN_ADMIN_EMAILS` override  | Organisation roles (open)                                     |
| Feedback, product events    | `user_id`                                                         | Funnel per organisation rather than per person (open)         |

This is not only a column choice. Ownership is enforced in code at every seam:
`listAccounts` and `assertOwnedAccount` gate a mailbox, `loadInbox` fans out over
the signed-in user's accounts and merges by `Message-ID`, the decision pipeline
reads "you" as those connected addresses, and deleting a user cascades their
mailboxes and all the mail beneath them. A second owner model has to touch each
of those, which is why it is worth deciding once rather than growing a bypass.

## The organisation model

Solo and corporation are not two skins on the same account. The shape agreed so
far:

- **Members keep their own mailboxes.** Everyone connects their own address, as
  they would in Outlook. Being in an organisation does not put one member's inbox
  in front of another, and read marks, Done, drafts and parsing preferences stay
  theirs.
- **Sharing is an explicit act.** A conversation can be assigned to a colleague;
  that assignment — not membership — is the intended way for someone else to see
  it.
- **The client list is the organisation's.** A client imported from the company's
  CRM is a client of the company, so client mail is prioritised in every member's
  inbox.
- **The account type is not `work_kind`.** `work_kind` says what one person does
  and only seeds their defaults. The account type decides what is shared and who
  may see it; a solo support person is a valid pair.
- **Solo stays the default.** An organisation is something a workspace becomes or
  is created as, not something every user has to think about.

What "shared" means in practice is deliberately narrow: one client list, one set
of sections and rules, and assignment. It does not mean a shared inbox.

## What an organisation is not

- **Not a shared mailbox.** A `support@` box that several people read is a
  different mechanism (one connection, several readers) and needs its own design.
  Nothing here assumes it.
- **Not a second deployment.** The database is a file on one host, so an
  organisation is rows in that file, not another app or database. The `/admin`
  split into `apps/web` + `apps/admin` only becomes real when the database stops
  being a file.
- **Not a helpdesk.** Assignment routes a conversation; it does not add tickets,
  SLAs or canned replies.
- **Not billing.** Seats are a membership count here, not a price.

## Open decisions

These change ownership, so a guess costs a migration of semantics rather than a
UI edit. Where a default seems obvious it is written as a _proposal_, not a
decision.

1. **Client list layering.** Organisation list only, member list only, or an
   organisation list with a personal overlay? _Proposal:_ shared kind plus private
   notes, because "Acme is a client" is a company fact and "Ana prefers short
   replies" is a person's.
2. **Roles.** Owner / admin / member, and whether "admin" stays `users.role` or
   becomes a membership role. _Proposal:_ membership roles; keep the existing
   `users.role` and `LUMEN_ADMIN_EMAILS` as the break-glass path for an install
   with no organisation yet.
3. **Invites and seats.** Invites are install-wide today, address-bound and
   single-use. _Proposal:_ an invite belongs to an organisation and consumes a
   seat; the existing bootstrap invite creates the first organisation with the
   first user as its owner.
4. **What becomes organisation-scoped.** Sections and rules almost certainly;
   parsing and reply style probably not; AI keys and the minimum draft importance
   need an answer. _Proposal:_ sections and client list shared, per-correspondent
   preferences private unless a member opts in.
5. **Assignment semantics.** A reference (assignee gets a view, the thread stays
   in the owner's mailbox) or a copy (both can act on their own)? _Proposal:_ a
   reference with an explicit "assigned to" line, because a copy creates two
   threads that disagree.
6. **Member departure.** Deleting a user currently deletes their mail. Before
   seats exist, that has to become a transfer or a retention rule, or a company
   loses a client history the day an employee leaves.
7. **The client webhook's owner.** `POST /api/client-hook/<token>` needs one
   token per list. _Proposal:_ one token per organisation, minted and rotated by
   an admin, so four members importing the same CRM do not produce four lists.
8. **CRM replace semantics.** `replace: true` currently means "a client missing
   from this payload loses `kind`". With several writers and several sources that
   needs a namespace: _proposal:_ replace only clears clients last written by the
   same source.

## The order things should happen in

1. **The solo client registry.** `contact_contexts.kind`, the Clients section,
   the sidebar editor and a manual import. It needs no sharing, no token and no
   organisation, and it is useful to one person today.
2. **Decide the list above.** The answers go into PLAN.md as decisions, not into
   a prototype.
3. **The scoping migration.** `organizations` and `memberships`, an
   `organization_id` on the tables that become shared, a backfill that gives
   every existing user their own single-member organisation, and one ownership
   helper every query goes through.
4. **Assignment and shared sections.** The first visible behaviour: a conversation
   can be assigned, and a shared section appears above the state groups.
5. **The organisation client webhook.** One token, one list, priority everywhere,
   and the CRM replace rules from step 2.

Why not start with the webhook: it is the one piece that hard-codes an owner. A
per-user token is easy to ship and wrong to keep, and the client list is the
feature a company cares about most. Ship `kind` early; ship the token once the
owner is known.

## Migration sketch

The shape, not the migration files:

- `organizations` (`id`, `name`, `kind` — solo | company — `created_at`) and
  `memberships` (`organization_id`, `user_id`, `role`, `status`, `created_at`).
- `organization_id` on `accounts`, `contact_contexts`, `organization_rules`,
  `conversations`, `invites` and `client_import_tokens` (new). Add it nullable,
  backfill, then tighten.
- Backfill: every existing user becomes the owner of their own solo organisation,
  and their rows point at it. Nothing about a single-user install should change
  behaviour, including `/admin` and the invite flow.
- Ownership: a `membershipFor(userId)` / `requireMembership(userId)` helper, and
  every list query takes the organisation id from the session's active
  membership rather than from the user. The current `assertOwnedAccount` becomes
  `assertAccountInOrganization`.
- `accounts_email_idx` stays globally unique: one mailbox, one owner. Connecting
  an address already connected to another account still refuses, in any
  organisation. Shared mailboxes are a later feature with their own table.
- Delete semantics change before seats do: a leaving member's mailboxes need an
  owner transfer or an explicit retention decision, not a cascade.
- The app stays one process and one file. Nothing about organisations requires a
  network database; that is still the trigger for `apps/web` + `apps/admin`.

## What will bite

- **A missing predicate is a data leak.** Every query that returns mail, contacts
  or settings has to carry the organisation id, and a helper that forgets it is
  invisible in review. The ownership matrix belongs in tests: member A cannot see
  member B's mail, contacts or sections, and an assigned thread is the only
  exception.
- **"You" in the decision pipeline** must stay the member's own connected
  addresses. If it becomes the organisation's, one person's sent mail makes
  another person's thread look answered.
- **Shared `kind` leaks a relationship.** If the client list is organisation-wide,
  a member learns that an address is a client before ever mailing them. That is
  probably the point, but it should be a decision rather than a side effect.
- **The beta funnel changes unit.** One request, one invite, one activated user
  becomes one organisation and n seats. The admin page and `beta-report.ts` will
  need both numbers, or the funnel stops answering "is this working".
- **Invite mode has no password reset.** Signing in with a password works in
  invite mode, but a member who has forgotten theirs still needs the address-bound
  invite that lands them in the _right_ organisation, not just any account with
  that email. The existing-user path in `/join` has to check membership, not only
  identity.

## Where the rest of the design lives

- [PLAN.md — Client mail, and what kind of person you're writing to](../PLAN.md#client-mail-and-what-kind-of-person-youre-writing-to)
  — the `kind` values, the Clients section and the webhook payload.
- [PLAN.md — Organizations are a second account type](../PLAN.md#organizations-are-a-second-account-type)
  — the short version of this document inside the plan.
- [PLAN.md — Access is request-only, and the beta is measured](../PLAN.md#access-is-request-only-and-the-beta-is-measured)
  — the invite and funnel mechanics that seats will change.
- [PLAN.md — Multiple accounts, one inbox](../PLAN.md#multiple-accounts-one-inbox)
  — the merge path an organisation has to keep working.
