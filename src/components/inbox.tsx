/**
 * The conversation list.
 *
 * Grouped by state rather than chronology — that is the whole premise of the app:
 * what needs doing comes first, and time is secondary.
 */

import type { ConversationState } from '#/db/schema.ts'
import type { ConversationSummary, InboxPayload } from '#/lib/gmail/service.ts'

import { STATE_META, STATE_ORDER } from '#/lib/conversation-state'
import { cn } from '#/lib/utils'
import { Link } from '@tanstack/react-router'
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

function byState(
  conversations: ConversationSummary[],
  state: ConversationState,
): ConversationSummary[] {
  return conversations.filter((c) => c.state === state)
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
        to="/conversations/$gmailThreadId"
        params={{ gmailThreadId: conversation.gmailThreadId }}
        className="block rounded-md border border-border/60 bg-muted/20 px-3 py-2 transition-colors hover:border-foreground/25"
      >
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {sender}
            </span>
            <NoReplyTag />
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
        to="/conversations/$gmailThreadId"
        params={{ gmailThreadId: conversation.gmailThreadId }}
        className="block rounded-lg border border-border bg-card p-4 transition-colors hover:border-foreground/25"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-card-foreground">
              {title}
            </p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {participantsOf(conversation)}
            </p>
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

        <div className="mt-3 flex items-center gap-2">
          <StateBadge state={conversation.state} />
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

function SignInPrompt() {
  return (
    <div className="rounded-lg border border-border bg-card p-8 text-center">
      <h2 className="text-lg font-semibold text-card-foreground">
        Connect your mailbox
      </h2>
      <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
        Lumen reads your Gmail and shows it as a list of conversations grouped
        by what needs your attention. It never writes to your mail.
      </p>
      <a
        href="/auth/google"
        className={cn(
          'mt-6 inline-flex h-9 items-center rounded-md bg-primary px-4',
          'text-sm font-medium text-primary-foreground',
        )}
      >
        Connect Gmail
      </a>
    </div>
  )
}

export function Inbox({ payload }: { payload: InboxPayload }) {
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

  const { conversations, counts, syncError, authRequired, lastSyncedAt } =
    payload

  // Every state is present in `counts`, including zeroes — an absent key would
  // mean the counts and the list disagree, which is worth hiding rather than
  // papering over.
  const visibleStates = STATE_ORDER.filter((state) => counts[state] > 0)

  return (
    <div className="mx-auto max-w-2xl p-8">
      <header className="flex items-baseline justify-between gap-4">
        <h1 className="text-3xl font-bold">Lumen</h1>
        <span className="text-xs text-muted-foreground">{payload.email}</span>
      </header>

      {authRequired ? (
        <div
          role="alert"
          className="mt-6 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          <p>
            Google no longer accepts the stored access — you may have revoked
            it, or it expired. Sign in again to keep syncing.
          </p>
          <a
            href="/auth/google"
            className={cn(
              'mt-3 inline-flex h-8 items-center rounded-md bg-primary px-3',
              'text-xs font-medium text-primary-foreground',
            )}
          >
            Reconnect Google
          </a>
        </div>
      ) : syncError ? (
        <p
          role="status"
          className="mt-6 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          Sync failed: {syncError}
        </p>
      ) : null}

      {conversations.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">
          Nothing synced yet
          {lastSyncedAt ? '' : ' — this may take a moment on first run.'}
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
        </div>
      )}
    </div>
  )
}
