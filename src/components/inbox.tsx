/**
 * The conversation list.
 *
 * Grouped by state rather than chronology — that is the whole premise of the app:
 * what needs doing comes first, and time is secondary.
 */

import { useState } from 'react'

import type { ConversationState } from '#/db/schema.ts'
import type {
  AccountSyncProgress,
  ConversationSummary,
  InboxPayload,
} from '#/lib/gmail/service.ts'

import {
  DONE_GROUP,
  DONE_META,
  READ_META,
  STATE_META,
  STATE_ORDER,
} from '#/lib/conversation-state'
import { cn } from '#/lib/utils'
import { Link } from '@tanstack/react-router'
import { Avatar } from '#/components/avatar'
import { StateBadge } from '#/components/state-badge'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * "3h ago".
 *
 * Rendered from `Date.now()`, so it disagrees between the server render and the
 * client's first paint by however long the response took. The element opts out of
 * the hydration warning for exactly that reason — the alternative is a stable but
 * useless "10/03/2026, 14:20".
 */
function timeAgo(iso: string): string {
  const elapsed = Date.now() - new Date(iso).getTime()

  if (elapsed < MINUTE) return 'now'
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d ago`

  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}

/**
 * The open threads filed under one state.
 *
 * `!c.done` is not redundant with the counts: a done thread keeps the state it
 * had (`done` is the user's answer about handling it, not a claim about what the
 * mail needs), so without this it would be listed twice — once here and once
 * under Done.
 */
function byState(
  conversations: ConversationSummary[],
  state: ConversationState,
): ConversationSummary[] {
  return conversations.filter((c) => c.state === state && !c.done)
}

/** The threads the user has handled, in their own section. */
function doneThreads(
  conversations: ConversationSummary[],
): ConversationSummary[] {
  return conversations.filter((c) => c.done)
}

/** Names if we have them, otherwise the bare address. */
function participantsOf(conversation: ConversationSummary): string {
  if (conversation.participants.length === 0) return 'Unknown sender'

  return conversation.participants
    .slice(0, 2)
    .map((p) => p.name ?? p.email)
    .join(', ')
}

/**
 * Marks a thread as having no human on the other side.
 *
 * Deliberately a text tag rather than an icon: "no reply" is the actual reason
 * the card is not interactive, and an icon alone would leave that unsaid.
 */
function NoReplyTag() {
  return (
    <span className="shrink-0 rounded-full border border-border bg-muted px-1.5 py-px text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
      No reply
    </span>
  )
}

/**
 * Which connected mailbox this row belongs to.
 *
 * The inbox is one merged list, so a row has to say where it came from — with
 * several addresses in play, "who is this from" is only half the question.
 */
/**
 * The user's own "handled" mark.
 *
 * The counterpart of the unread dot, and the two are the pair that used to be
 * missing: the dot is mail they have not opened, this is mail they have dealt
 * with. `title` is the difference in words, because the point of the pair is that
 * nobody has to guess which is which.
 */
function DoneTag() {
  return (
    <span
      title={DONE_META.description}
      className="shrink-0 rounded-full border border-success/30 bg-success/15 px-1.5 py-px text-[10px] font-medium tracking-wide text-success uppercase"
    >
      {DONE_META.label}
    </span>
  )
}

function AccountTag({ email }: { email: string }) {
  return (
    <span className="shrink-0 rounded-full border border-border bg-background px-1.5 py-px text-[10px] font-medium text-muted-foreground">
      {email}
    </span>
  )
}

/**
 * How the user's addresses relate to the thread.
 *
 * `cc-only` is the one worth surfacing as a tag: it is someone else's
 * conversation you happen to be copied on twice, so it reads as informational
 * rather than as something waiting on you. Anything else only needs the CC'd
 * addresses named.
 */
function RelationTag({ conversation }: { conversation: ConversationSummary }) {
  if (conversation.relation === 'cc-only') {
    return (
      <span className="shrink-0 rounded-full border border-border bg-muted px-1.5 py-px text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        Cc
      </span>
    )
  }

  if (conversation.ccAccountEmails.length > 0) {
    return (
      <span className="shrink-0 text-xs text-muted-foreground">
        also {conversation.ccAccountEmails.join(', ')}
      </span>
    )
  }

  return null
}

/**
 * A machine-generated update: receipts, build results, alerts, invitations.
 *
 * Denser than a chat row and missing everything that implies a conversation —
 * no participant list, no message count, no avatar, and nothing that looks like
 * a reply target. You triage these by source and time, not by dialogue.
 */
function AutomatedRow({ conversation }: { conversation: ConversationSummary }) {
  const sender = participantsOf(conversation)

  return (
    <li>
      <Link
        to="/conversations/$providerThreadId"
        params={{ providerThreadId: conversation.providerThreadId }}
        className="block rounded-md border border-border/60 bg-muted/20 px-3 py-2 transition-colors hover:border-foreground/25"
      >
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {sender}
            </span>
            <NoReplyTag />
            <AccountTag email={conversation.accountEmail} />
          </div>

          <time
            dateTime={conversation.lastMessageAt}
            suppressHydrationWarning
            className="shrink-0 text-xs text-muted-foreground"
          >
            {timeAgo(conversation.lastMessageAt)}
          </time>
        </div>

        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {conversation.topic ?? conversation.subject}
        </p>
      </Link>
    </li>
  )
}

function ConversationRow({
  conversation,
}: {
  conversation: ConversationSummary
}) {
  // The user's own topic when they have set one, the raw subject otherwise —
  // the subject is full of "Re:" noise but it is better than a blank row.
  const title = conversation.topic ?? conversation.subject

  return (
    <li>
      <Link
        to="/conversations/$providerThreadId"
        params={{ providerThreadId: conversation.providerThreadId }}
        className="block rounded-lg border border-border bg-card p-4 transition-colors hover:border-foreground/25"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 gap-3">
            <Avatar contact={conversation.participants[0]} className="mt-0.5" />
            <div className="min-w-0">
              <p className="flex min-w-0 items-center gap-2 text-sm font-medium text-card-foreground">
                {/*
                 * Incoming mail the user has not opened. Only unseen mail earns
                 * this: a thread they have read but not answered is not new — it is
                 * the one case where looking away would lose a reply, so it keeps
                 * its row's weight and stays where it is.
                 */}
                {conversation.unseen ? (
                  <span
                    role="img"
                    aria-label={READ_META.description}
                    title={READ_META.description}
                    className="size-2 shrink-0 rounded-full bg-primary"
                  />
                ) : null}
                <span
                  className={cn(
                    'truncate',
                    conversation.unseen && 'font-semibold',
                  )}
                >
                  {title}
                </span>
              </p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {participantsOf(conversation)}
              </p>
            </div>
          </div>

          <time
            dateTime={conversation.lastMessageAt}
            suppressHydrationWarning
            className="shrink-0 text-xs text-muted-foreground"
          >
            {timeAgo(conversation.lastMessageAt)}
          </time>
        </div>

        {conversation.preview ? (
          <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
            {conversation.preview}
          </p>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {/* Faint in the Done section: the state is the one it had when the user
              finished with it, kept rather than rewritten, and dimming it says so
              without hiding it. */}
          <StateBadge
            state={conversation.state}
            className={conversation.done ? 'opacity-60' : undefined}
          />
          {conversation.done ? <DoneTag /> : null}
          {/* A human thread can still have nobody to answer — same "No reply"
              tag as an automated card, since the composer is hidden either way. */}
          {conversation.replyable ? null : <NoReplyTag />}
          <AccountTag email={conversation.accountEmail} />
          <RelationTag conversation={conversation} />
          <span className="text-xs text-muted-foreground">
            {conversation.messageCount}{' '}
            {conversation.messageCount === 1 ? 'message' : 'messages'}
          </span>
          {conversation.attachmentCount > 0 ? (
            <span className="text-xs text-muted-foreground">
              {conversation.attachmentCount}{' '}
              {conversation.attachmentCount === 1
                ? 'attachment'
                : 'attachments'}
            </span>
          ) : null}
        </div>
      </Link>
    </li>
  )
}

/**
 * The bar under a mailbox's progress line.
 *
 * A determinate bar once the total is known, and a moving sliver when it is not
 * — `threads.list` has to finish paging before there is a denominator, and a bar
 * that guessed at one would be lying in the run that matters most.
 */
function SyncProgressBar({ progress }: { progress: AccountSyncProgress }) {
  const { processed, estimated } = progress
  const known = estimated !== null && estimated > 0
  const done = known ? Math.min(processed, estimated) : 0

  return (
    <div
      role="progressbar"
      aria-label={`Syncing ${progress.email}`}
      aria-valuemin={0}
      aria-valuemax={known ? estimated : undefined}
      aria-valuenow={known ? done : undefined}
      className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-border/60"
    >
      <div
        className={cn(
          'h-full rounded-full bg-primary',
          known ? 'transition-[width] duration-500' : 'w-1/3 animate-pulse',
        )}
        style={known ? { width: `${(done / estimated) * 100}%` } : undefined}
      />
    </div>
  )
}

/** "42 of ~600", or just "42 so far" before the total is known. */
function progressLabel(progress: AccountSyncProgress): string {
  if (progress.estimated === null) {
    return progress.processed > 0 ? `${progress.processed} so far` : 'starting…'
  }

  return `${Math.min(progress.processed, progress.estimated)} of ~${progress.estimated}`
}

/**
 * What a sync that is still running looks like.
 *
 * The first backfill of a real mailbox is minutes of work, and until this
 * existed the page simply sat there — the run was awaited by the loader, so
 * adding an account looked like a hang. The numbers come from the sync itself,
 * so the bar moves for a reason.
 */
function SyncBanner({ syncing }: { syncing: AccountSyncProgress[] }) {
  return (
    <div
      role="status"
      className="mt-6 rounded-md border border-border bg-muted/30 px-4 py-3"
    >
      <p className="text-sm font-medium text-foreground">
        {syncing.length === 1
          ? 'Syncing your mailbox…'
          : `Syncing ${syncing.length} mailboxes…`}
      </p>

      <ul className="mt-2 space-y-2">
        {syncing.map((progress) => (
          <li key={progress.id}>
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="truncate text-muted-foreground">
                {progress.email}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {progressLabel(progress)}
              </span>
            </div>
            <SyncProgressBar progress={progress} />
          </li>
        ))}
      </ul>

      <p className="mt-2 text-xs text-muted-foreground">
        Conversations appear in the list as they are synced. A large mailbox can
        take a few minutes the first time.
      </p>
    </div>
  )
}

function SignInPrompt() {
  return (
    <div className="rounded-lg border border-border bg-card p-8 text-center">
      <h2 className="text-lg font-semibold text-card-foreground">
        Connect your mailbox
      </h2>
      <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
        Lumen reads your mail and shows it as a list of conversations grouped by
        what needs your attention. It never writes to your mail.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <a
          href="/auth/google"
          className={cn(
            'inline-flex h-9 items-center rounded-md bg-primary px-4',
            'text-sm font-medium text-primary-foreground',
          )}
        >
          Connect Gmail
        </a>
        <a
          href="/auth/microsoft"
          className={cn(
            'inline-flex h-9 items-center rounded-md border border-border bg-background px-4',
            'text-sm font-medium text-foreground transition-colors hover:border-foreground/25',
          )}
        >
          Connect Outlook
        </a>
      </div>
    </div>
  )
}

export function Inbox({
  payload,
  onResync,
}: {
  payload: InboxPayload
  /** Present when the app can rebuild from Gmail; absent in isolation/tests. */
  onResync?: () => Promise<{ error: string | null }>
}) {
  // Hooks run before the signed-out early return, so the hook order is stable.
  const [resyncing, setResyncing] = useState(false)
  const [resyncError, setResyncError] = useState<string | null>(null)

  const handleResync = async () => {
    if (!onResync || resyncing) return

    setResyncing(true)
    setResyncError(null)
    try {
      const result = await onResync()
      if (result.error) setResyncError(result.error)
    } catch (error) {
      setResyncError(
        error instanceof Error ? error.message : 'Could not re-sync.',
      )
    } finally {
      setResyncing(false)
    }
  }

  if (!payload.signedIn) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <h1 className="text-3xl font-bold">Lumen</h1>
        <div className="mt-8">
          <SignInPrompt />
        </div>
      </div>
    )
  }

  const {
    accounts,
    conversations,
    counts,
    doneCount,
    syncError,
    authRequiredAccounts,
    lastSyncedAt,
    syncing,
  } = payload

  // Every state is present in `counts`, including zeroes — an absent key would
  // mean the counts and the list disagree, which is worth hiding rather than
  // papering over.
  const visibleStates = STATE_ORDER.filter((state) => counts[state] > 0)
  const done = doneThreads(conversations)

  return (
    <div className="mx-auto max-w-2xl p-8">
      <header className="flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Lumen</h1>
          {/*
           * The two marks, in words, once — because the dot and the tag are only
           * obvious to whoever wrote them. One is a fact the app noticed, the
           * other is a decision the user made, and saying so here is cheaper than
           * expecting anyone to work it out from the two rows side by side.
           */}
          <p className="mt-1 text-xs text-muted-foreground">
            <span
              aria-hidden="true"
              className="mr-1.5 inline-block size-2 rounded-full bg-primary align-middle"
            />
            {READ_META.label} — mail you have not opened.{' '}
            <span className="font-medium text-foreground">
              {DONE_META.label}
            </span>{' '}
            — you handled it, so it is out of the groups below.
          </p>
        </div>
        {/* All connected mailboxes are merged into the one list below. The
            "Add mailbox" action re-runs the same OAuth flow as the sign-in
            prompt, but accounts are global, so signing in again connects the
            new mailbox alongside the existing ones instead of replacing them. */}
        <div className="flex min-w-0 items-center gap-3">
          <span className="truncate text-xs text-muted-foreground">
            {accounts.map((account) => account.email).join(' · ')}
          </span>
          <Link
            to="/compose"
            className={cn(
              'shrink-0 inline-flex h-8 items-center rounded-md bg-primary px-3',
              'text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90',
            )}
          >
            New message
          </Link>
          <button
            type="button"
            onClick={() => void handleResync()}
            disabled={resyncing || !onResync}
            title="Re-fetch the last 30 days from Gmail"
            className={cn(
              'shrink-0 inline-flex h-8 items-center rounded-md border border-border bg-background px-3',
              'text-xs font-medium text-foreground transition-colors hover:border-foreground/25',
              (resyncing || !onResync) && 'cursor-not-allowed opacity-50',
            )}
          >
            {resyncing ? 'Re-syncing…' : 'Re-sync'}
          </button>
          <a
            href="/auth/google"
            className={cn(
              'shrink-0 inline-flex h-8 items-center rounded-md border border-border bg-background px-3',
              'text-xs font-medium text-foreground transition-colors hover:border-foreground/25',
            )}
          >
            Add Gmail
          </a>
          <a
            href="/auth/microsoft"
            className={cn(
              'shrink-0 inline-flex h-8 items-center rounded-md border border-border bg-background px-3',
              'text-xs font-medium text-foreground transition-colors hover:border-foreground/25',
            )}
          >
            Add Outlook
          </a>
          <Link
            to="/settings"
            className={cn(
              'shrink-0 inline-flex h-8 items-center rounded-md border border-border bg-background px-3',
              'text-xs font-medium text-foreground transition-colors hover:border-foreground/25',
            )}
          >
            Settings
          </Link>
        </div>
      </header>

      {authRequiredAccounts.length > 0 ? (
        <div
          role="alert"
          className="mt-6 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          <p>
            The mail service no longer accepts the stored access for{' '}
            {authRequiredAccounts.map((account) => account.email).join(', ')} —
            you may have revoked it, or it expired. Sign in again to keep
            syncing. The other mailboxes are unaffected.
          </p>
          <span className="mt-3 flex flex-wrap gap-2">
            {authRequiredAccounts.map((account) => (
              <a
                key={account.id}
                href={
                  account.provider === 'microsoft'
                    ? '/auth/microsoft'
                    : '/auth/google'
                }
                className={cn(
                  'inline-flex h-8 items-center rounded-md bg-primary px-3',
                  'text-xs font-medium text-primary-foreground',
                )}
              >
                Reconnect{' '}
                {account.provider === 'microsoft' ? 'Outlook' : 'Gmail'}
              </a>
            ))}
          </span>
        </div>
      ) : syncError ? (
        <p
          role="status"
          className="mt-6 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          Sync failed: {syncError}
        </p>
      ) : null}

      {resyncError ? (
        <p
          role="status"
          className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          Re-sync failed: {resyncError}
        </p>
      ) : null}

      {syncing.length > 0 ? <SyncBanner syncing={syncing} /> : null}

      {conversations.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">
          {syncing.length > 0
            ? 'The first sync is running — conversations will appear here as they arrive.'
            : lastSyncedAt
              ? 'Nothing in the synced window.'
              : 'Nothing synced yet.'}
        </p>
      ) : (
        <div className="mt-8 space-y-8">
          {visibleStates.map((state) => (
            <section key={state}>
              <div className="mb-3 flex items-baseline justify-between gap-4">
                <h2 className="text-sm font-semibold tracking-wide text-foreground uppercase">
                  {STATE_META[state].label}
                </h2>
                <span className="text-xs text-muted-foreground">
                  {counts[state]}
                </span>
              </div>

              <ul className="space-y-3">
                {byState(conversations, state).map((conversation) =>
                  // Same feed, same grouping — only the presentation differs. A
                  // failed build is still `needs-action`; it is just not a chat.
                  conversation.isAutomated ? (
                    <AutomatedRow
                      key={conversation.id}
                      conversation={conversation}
                    />
                  ) : (
                    <ConversationRow
                      key={conversation.id}
                      conversation={conversation}
                    />
                  ),
                )}
              </ul>
            </section>
          ))}

          {/*
           * Last, and its own section rather than another state: these are the
           * threads the user has said they are finished with, and the reason to
           * split them out is that the groups above are what still wants
           * attention. New mail moves a thread back up here on its own.
           */}
          {doneCount > 0 ? (
            <section>
              <div className="mb-3 flex items-baseline justify-between gap-4">
                <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
                  {DONE_GROUP.label}
                </h2>
                <span className="text-xs text-muted-foreground">
                  {doneCount}
                </span>
              </div>
              <p className="mb-3 text-xs text-muted-foreground">
                {DONE_GROUP.description}
              </p>

              <ul className="space-y-3">
                {done.map((conversation) =>
                  conversation.isAutomated ? (
                    <AutomatedRow
                      key={conversation.id}
                      conversation={conversation}
                    />
                  ) : (
                    <ConversationRow
                      key={conversation.id}
                      conversation={conversation}
                    />
                  ),
                )}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </div>
  )
}
