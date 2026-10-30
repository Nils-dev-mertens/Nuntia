/**
 * The conversation list.
 *
 * Grouped by state rather than chronology — that is the whole premise of the app:
 * what needs doing comes first, and time is secondary.
 */

import { useEffect, useRef, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { Check } from 'lucide-react'

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
import { partitionOrganizationGroups } from '#/lib/organization/matching.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * How many rows a section shows in the all-sections view.
 *
 * The inbox's job is to show what needs doing, and a section with sixty threads
 * in it buries everything below it. Ten is enough to see the shape of a section
 * and short enough that the next section is still on screen; the rest is one
 * click away, and a section viewed on its own is not capped.
 */
const SECTION_PAGE_SIZE = 10

/** One rendered group: a custom label, a state label, or Done. */
type InboxSection = {
  key: string
  title: string
  description: string | null
  items: ConversationSummary[]
  /** The dot beside the section's tab: the state's colour, or a neutral one. */
  dotClass: string
  /** Done is a filing decision rather than a label, so its heading stays quiet. */
  muted?: boolean
}

/**
 * "3h ago".
 *
 * Rendered from `Date.now()`, so it disagrees between the server render and the
 * client's first paint by however long the response took. The element opts out of
 * the hydration warning for exactly that reason — the alternative is a stable but
 * useless "10/03/2026, 14:20".
 */
/** "840 B", "12 KB", "1.4 MB" — attachment sizes, which are only ever glanced at. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

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

/**
 * High, middling, or low — three bands rather than ten exact ranks.
 *
 * Sorting by the raw score put an eight from three weeks ago above a seven from
 * this morning, which buries fresh mail for a point. The bands let importance
 * decide the tier and the date decide the order inside it, so the score matters
 * without freezing the list in place.
 */
function importanceBand(score: number): number {
  if (score >= 7) return 2
  if (score >= 4) return 1
  return 0
}

/** Importance tier first, then recency — newest first inside a tier. */
function byImportance(a: ConversationSummary, b: ConversationSummary): number {
  const band = importanceBand(b.importance) - importanceBand(a.importance)
  if (band !== 0) return band
  return Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt)
}

/** The threads the user has handled, in their own section. */
/** Names if we have them, otherwise the bare address. */
function participantsOf(conversation: ConversationSummary): string {
  if (conversation.participants.length === 0) return 'Unknown sender'

  return conversation.participants
    .slice(0, 2)
    .map((p) => p.name ?? p.email)
    .join(', ')
}

/**
 * The small marks under a thread, as words rather than pills.
 *
 * They carry meaning, not category, so they share the row's small type and one
 * separator instead of each growing its own border and background. The one that
 * is a decision (Done) gets colour and a check; the rest stay quiet.
 */
function Separator() {
  return (
    <span aria-hidden="true" className="text-muted-foreground/40 select-none">
      ·
    </span>
  )
}

/**
 * Marks a thread as having no human on the other side.
 *
 * Deliberately words rather than an icon: "no reply" is the actual reason the
 * composer is hidden, and an icon alone would leave that unsaid.
 */
function NoReplyTag() {
  return <span>no reply</span>
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
      className="inline-flex items-center gap-1 font-medium text-success"
    >
      <Check aria-hidden="true" className="size-3" />
      {DONE_META.label}
    </span>
  )
}

/**
 * Jev's importance score, spelled out.
 *
 * It used to be a bar with a bare number beside it, which only explained itself
 * on hover — and a hover is not an explanation on a phone, or to anyone who
 * never points at it. The band word says what the number is for; the score
 * stays beside it because "high" alone hides the line between a 7 and a 10.
 */
function importanceWord(score: number): 'high' | 'medium' | 'low' {
  const band = importanceBand(score)
  return band === 2 ? 'high' : band === 1 ? 'medium' : 'low'
}

function ImportanceTag({ score }: { score: number }) {
  const word = importanceWord(score)

  return (
    <span
      title={`Jev's importance score: how much this thread needs you (${score} of 10).`}
      className="inline-flex items-baseline gap-1 whitespace-nowrap"
    >
      <span
        className={cn(
          'font-medium',
          word === 'high' ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        {word} importance
      </span>
      <span className="tabular-nums">{score}/10</span>
    </span>
  )
}

function AccountTag({ email }: { email: string }) {
  return <span className="truncate">{email}</span>
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
      <>
        <Separator />
        <span>cc</span>
      </>
    )
  }

  if (conversation.ccAccountEmails.length > 0) {
    return (
      <>
        <Separator />
        <span className="truncate">
          also {conversation.ccAccountEmails.join(', ')}
        </span>
      </>
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
function AutomatedRow({
  conversation,
  showAccount,
  onRowMenu,
  onRowPreview,
  active,
  selectable,
  showSelector,
  selected,
  onSelect,
}: {
  conversation: ConversationSummary
  showAccount: boolean
  onRowMenu: (event: MouseEvent, conversation: ConversationSummary) => void
  onRowPreview: (conversation: ConversationSummary) => void
  /** True while the preview column is showing this row. */
  active: boolean
  /** False when there is no batch action to take on a selection. */
  selectable: boolean
  /** True while selection is visible: Shift is down, or something is picked. */
  showSelector: boolean
  selected: boolean
  onSelect: (
    providerThreadId: string,
    modifiers: { shiftKey: boolean; additive: boolean },
  ) => void
}) {
  const sender = participantsOf(conversation)

  return (
    <li className="relative">
      {/*
       * The checkbox sits beside the link rather than inside it: a row is one
       * anchor, and an input nested in an anchor is both invalid markup and a
       * control that navigates when it is meant to select.
       */}
      {showSelector ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          aria-label={`Select ${conversation.topic ?? conversation.subject}`}
          onClick={(event) =>
            onSelect(conversation.providerThreadId, {
              shiftKey: event.shiftKey,
              additive: event.ctrlKey || event.metaKey,
            })
          }
          className={cn(
            'absolute top-2 left-2 z-10 flex size-4 items-center justify-center rounded border transition-colors',
            selected
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border bg-background hover:border-foreground/40',
          )}
        >
          {selected ? <Check aria-hidden="true" className="size-3" /> : null}
        </button>
      ) : null}
      <Link
        to="/conversations/$providerThreadId"
        params={{ providerThreadId: conversation.providerThreadId }}
        onContextMenu={(event) => onRowMenu(event, conversation)}
        onMouseEnter={() => onRowPreview(conversation)}
        onFocus={() => onRowPreview(conversation)}
        onClick={(event) => {
          // A modifier is the selection gesture; without one the row is still a
          // link, which is what makes selecting a deliberate act.
          if (!selectable) return
          if (!event.shiftKey && !event.ctrlKey && !event.metaKey) return
          event.preventDefault()
          onSelect(conversation.providerThreadId, {
            shiftKey: event.shiftKey,
            additive: event.ctrlKey || event.metaKey,
          })
        }}
        className={cn(
          'block rounded-md border border-border/60 bg-muted/20 transition-colors hover:border-foreground/25',
          showSelector ? 'py-2 pr-3 pl-9' : 'px-3 py-2',
          active && 'border-foreground/30 bg-muted/40',
        )}
      >
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {sender}
            </span>
            <NoReplyTag />
            {showAccount ? (
              <AccountTag email={conversation.accountEmail} />
            ) : null}
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
  stateLabel,
  showAccount,
  onRowMenu,
  onRowPreview,
  active,
  selectable,
  showSelector,
  selected,
  onSelect,
}: {
  conversation: ConversationSummary
  /** The user's wording for this thread's label; the default when unchanged. */
  stateLabel: string
  /** Hidden for single-mailbox installs, where the chip says nothing new. */
  showAccount: boolean
  onRowMenu: (event: MouseEvent, conversation: ConversationSummary) => void
  onRowPreview: (conversation: ConversationSummary) => void
  /** True while the preview column is showing this row. */
  active: boolean
  /** False when there is no batch action to take on a selection. */
  selectable: boolean
  /** True while selection is visible: Shift is down, or something is picked. */
  showSelector: boolean
  selected: boolean
  onSelect: (
    providerThreadId: string,
    modifiers: { shiftKey: boolean; additive: boolean },
  ) => void
}) {
  // The user's own topic when they have set one, the raw subject otherwise —
  // the subject is full of "Re:" noise but it is better than a blank row.
  const title = conversation.topic ?? conversation.subject

  return (
    <li className="relative">
      {/* Outside the row's link, so selecting never navigates. */}
      {showSelector ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          aria-label={`Select ${title}`}
          onClick={(event) =>
            onSelect(conversation.providerThreadId, {
              shiftKey: event.shiftKey,
              additive: event.ctrlKey || event.metaKey,
            })
          }
          className={cn(
            'absolute top-3.5 left-3 z-10 flex size-4 items-center justify-center rounded border transition-colors',
            selected
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border bg-background hover:border-foreground/40',
          )}
        >
          {selected ? <Check aria-hidden="true" className="size-3" /> : null}
        </button>
      ) : null}
      <Link
        to="/conversations/$providerThreadId"
        params={{ providerThreadId: conversation.providerThreadId }}
        onContextMenu={(event) => onRowMenu(event, conversation)}
        onMouseEnter={() => onRowPreview(conversation)}
        onFocus={() => onRowPreview(conversation)}
        onClick={(event) => {
          // A modifier is the selection gesture; without one the row is still a
          // link, which is what makes selecting a deliberate act.
          if (!selectable) return
          if (!event.shiftKey && !event.ctrlKey && !event.metaKey) return
          event.preventDefault()
          onSelect(conversation.providerThreadId, {
            shiftKey: event.shiftKey,
            additive: event.ctrlKey || event.metaKey,
          })
        }}
        className={cn(
          'block rounded-lg border border-border bg-card transition-colors hover:border-foreground/25',
          showSelector ? 'py-4 pr-4 pl-10' : 'p-4',
          active && 'border-foreground/30 ring-1 ring-foreground/10',
        )}
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

        {/* What the thread actually wants, when the decision layer worked it
            out. It is the reason the row is in this section, so it leads; the
            preview follows on a wider screen where the extra line fits. */}
        {conversation.goal ? (
          <p className="mt-2 line-clamp-2 text-sm text-foreground/90">
            {conversation.goal}
          </p>
        ) : null}

        {conversation.preview ? (
          <p
            className={cn(
              'line-clamp-2 text-sm text-muted-foreground',
              conversation.goal ? 'mt-1 hidden sm:block' : 'mt-2',
            )}
          >
            {conversation.preview}
          </p>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          {/* Faint in the Done section: the state is the one it had when the user
              finished with it, kept rather than rewritten, and dimming it says so
              without hiding it. */}
          <StateBadge
            state={conversation.state}
            label={stateLabel}
            className={conversation.done ? 'opacity-60' : undefined}
          />
          {conversation.done ? (
            <>
              <Separator />
              <DoneTag />
            </>
          ) : null}
          {/* A human thread can still have nobody to answer — the same wording as
              an automated card, since the composer is hidden either way. */}
          {conversation.replyable ? null : (
            <>
              <Separator />
              <NoReplyTag />
            </>
          )}
          <Separator />
          <ImportanceTag score={conversation.importance} />
          {conversation.senderImportance !== null ? (
            <>
              <Separator />
              <span title="Your importance rating for this correspondent; used as context when classifying their mail.">
                contact {conversation.senderImportance}/10
              </span>
            </>
          ) : null}
          {showAccount ? (
            <>
              <Separator />
              <AccountTag email={conversation.accountEmail} />
            </>
          ) : null}
          <RelationTag conversation={conversation} />
          <Separator />
          <span>
            {conversation.messageCount}{' '}
            {conversation.messageCount === 1 ? 'message' : 'messages'}
          </span>
          {conversation.attachmentCount > 0 ? (
            <>
              <Separator />
              <span>
                {conversation.attachmentCount}{' '}
                {conversation.attachmentCount === 1
                  ? 'attachment'
                  : 'attachments'}
              </span>
            </>
          ) : null}
        </div>
      </Link>
    </li>
  )
}

/**
 * The mailbox in four numbers.
 *
 * Every one of these is already on the loader — `counts` and `doneCount` are
 * computed once for the whole mailbox, and the unseen count is a filter over the
 * rows — so the top of the page says how much work there is before the user has
 * scrolled through it.
 */
function SummaryStrip({
  counts,
  doneCount,
  unseenCount,
  lastSyncedAt,
  syncing,
  accountCount,
}: {
  counts: Record<ConversationState, number>
  doneCount: number
  unseenCount: number
  lastSyncedAt: string | null
  syncing: boolean
  accountCount: number
}) {
  const tiles = [
    {
      key: 'needs-action',
      label: 'Needs action',
      value: counts['needs-action'],
      tone: 'text-success',
    },
    {
      key: 'waiting-for-reply',
      label: 'Waiting on them',
      value: counts['waiting-for-reply'],
      tone: 'text-warning',
    },
    { key: 'new', label: 'New', value: unseenCount, tone: 'text-primary' },
    {
      key: 'done',
      label: 'Handled',
      value: doneCount,
      tone: 'text-muted-foreground',
    },
  ] as const

  return (
    <section aria-label="Mailbox at a glance" className="mt-6">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tiles.map((tile) => (
          <div
            key={tile.key}
            className="rounded-lg border border-border bg-card px-3 py-2"
          >
            <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              {tile.label}
            </p>
            <p
              className={cn(
                'mt-0.5 text-2xl font-semibold tabular-nums',
                tile.tone,
              )}
            >
              {tile.value}
            </p>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        {syncing
          ? 'Syncing…'
          : lastSyncedAt
            ? `Last synced ${timeAgo(lastSyncedAt)}`
            : 'Not synced yet'}
        {' · '}
        {accountCount} {accountCount === 1 ? 'mailbox' : 'mailboxes'}
      </p>
    </section>
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

/**
 * The first screen a newly invited person sees.
 *
 * A signed-in user with no mailbox is not an empty inbox — there is nothing to
 * be empty *of*. Showing the normal chrome (Re-sync, state filters, "nothing in
 * the synced window") describes a product they have not used yet, so this is a
 * separate screen: what Nuntia is, the two buttons that make it work, and what
 * happens after each one.
 *
 * The steps are ordered by what the person has to *do*, not by what the app does
 * internally. Step one is the only interactive one.
 */
function GetStarted({ microsoftConfigured }: { microsoftConfigured: boolean }) {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        You&apos;re in
      </p>
      <h1 className="mt-1 text-3xl font-bold">Welcome to Nuntia</h1>
      <p className="mt-2 max-w-lg text-sm text-muted-foreground">
        Nuntia reads your mail and turns it into a short list of conversations,
        grouped by what actually needs you. Three minutes to set up, and nothing
        sends without your say-so.
      </p>

      <ol className="mt-8 space-y-5">
        <li className="flex gap-4">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
            1
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Connect a mailbox</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Gmail or Outlook. Nuntia asks for read and send access — it cannot
              delete mail, and the token stays on this machine.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <a
                href="/auth/google"
                className={cn(
                  'inline-flex h-9 items-center rounded-md bg-primary px-4',
                  'text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90',
                )}
              >
                Connect Gmail
              </a>
              <OutlookButton
                configured={microsoftConfigured}
                className={cn(
                  'inline-flex h-9 items-center rounded-md border border-border bg-background px-4',
                  'text-sm font-medium text-foreground transition-colors hover:border-foreground/25',
                )}
              >
                Connect Outlook
              </OutlookButton>
            </div>
          </div>
        </li>

        <li className="flex gap-4">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border text-xs font-semibold text-muted-foreground">
            2
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Let the first sync run</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Nuntia reads the last 30 days and groups the threads as they
              arrive. You can close the tab; the sync keeps going, and a large
              mailbox takes a few minutes the first time.
            </p>
          </div>
        </li>

        <li className="flex gap-4">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border text-xs font-semibold text-muted-foreground">
            3
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Read the three marks</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              A dot means unopened. A state tag says what the thread needs.
              &ldquo;Done&rdquo; is yours — new mail brings the thread back on
              its own.
            </p>
          </div>
        </li>

        <li className="flex gap-4">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border text-xs font-semibold text-muted-foreground">
            4
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Connect your AI providers</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Nuntia does not ship a key — you connect your own in Settings. Jev
              scores which mail actually needs you, and an LLM names topics and
              drafts replies.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Without them the app still works: it falls back to its rules, so
              the inbox sorts itself, but with no topics and no drafts. Each key
              is yours, stored encrypted on this machine, and used only for your
              mail.
            </p>
            <Link
              to="/settings"
              className={cn(
                'mt-3 inline-flex h-9 items-center rounded-md border border-border bg-background px-4',
                'text-sm font-medium text-foreground transition-colors hover:border-foreground/25',
              )}
            >
              Add your keys in Settings
            </Link>
          </div>
        </li>
      </ol>

      <div className="mt-8 flex flex-wrap items-center gap-4 border-t border-border pt-4 text-xs text-muted-foreground">
        <Link to="/settings" className="text-primary hover:underline">
          Settings
        </Link>
        <span aria-hidden="true">·</span>
        <Link to="/feedback" className="text-primary hover:underline">
          Tell me what got in the way
        </Link>
        <span aria-hidden="true">·</span>
        <span>It&apos;s a beta — the person who built it reads that box.</span>
      </div>
    </div>
  )
}

/**
 * The Outlook connection action.
 *
 * Microsoft sign-in is optional — an install with no app registration cannot run
 * the flow at all — so while `MICROSOFT_CLIENT_ID`/`MICROSOFT_CLIENT_SECRET` are
 * unset the button renders as a disabled control rather than as a link to a
 * callback that would only refuse. It becomes a real link the moment the key is
 * added, with nothing else to change.
 */
function OutlookButton({
  configured,
  className,
  children,
}: {
  configured: boolean
  className: string
  children: ReactNode
}) {
  if (!configured) {
    return (
      <span
        aria-disabled="true"
        title="Outlook is not configured on this install"
        className={cn(className, 'cursor-not-allowed opacity-50')}
      >
        {children}
      </span>
    )
  }

  return (
    <a href="/auth/microsoft" className={className}>
      {children}
    </a>
  )
}

function SignInPrompt({
  microsoftConfigured,
}: {
  microsoftConfigured: boolean
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-8 text-center">
      <h2 className="text-lg font-semibold text-card-foreground">
        Connect your mailbox
      </h2>
      <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
        Nuntia reads your mail and shows it as a list of conversations grouped
        by what needs your attention. It never writes to your mail.
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
        <OutlookButton
          configured={microsoftConfigured}
          className={cn(
            'inline-flex h-9 items-center rounded-md border border-border bg-background px-4',
            'text-sm font-medium text-foreground transition-colors hover:border-foreground/25',
          )}
        >
          Connect Outlook
        </OutlookButton>
      </div>
    </div>
  )
}

/** What the preview column needs from one thread. */
export type MailPreview = {
  providerThreadId: string
  subject: string
  topic: string | null
  goal: string | null
  state: ConversationState
  done: boolean
  accountEmail: string
  participants: Array<{
    name: string | null
    email: string
    initials: string
    avatarUrl: string | null
  }>
  /** The newest three messages, oldest first — the last one is the preview. */
  messages: Array<{
    from: string
    sentAt: string
    body: string
    isFromOwner: boolean
  }>
  messageCount: number
  attachmentCount: number
  attachments: Array<{ filename: string; sizeBytes: number }>
  replyable: boolean
  importance: number
  senderImportance: number | null
  /** The user's own notes about the correspondent, when they have written any. */
  contact: {
    roleCompany: string | null
    relationship: string | null
    topics: string | null
    currentWork: string | null
  } | null
}

/**
 * The right-hand preview column.
 *
 * Shows the newest message of whatever row the pointer is over, so deciding
 * which thread to open does not cost a page load each. It deliberately is not
 * the full thread: that is the conversation view's job, and the footer's Open
 * link goes there.
 */
function MailPreviewCard({
  preview,
  loading,
  error,
  stateLabels,
}: {
  preview: MailPreview | null
  loading: boolean
  error: string | null
  stateLabels: Record<ConversationState, { name: string; description: string }>
}) {
  if (error) {
    return (
      <div
        role="status"
        className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-xs text-destructive"
      >
        {error}
      </div>
    )
  }

  if (!preview) {
    return (
      <div className="rounded-lg border border-dashed border-border p-4">
        <h2 className="text-sm font-semibold text-foreground">Mail preview</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {loading
            ? 'Loading…'
            : 'Point at a conversation to read its newest message here, without leaving the list.'}
        </p>
      </div>
    )
  }

  const newest = preview.messages.at(-1) ?? null
  const earlier = preview.messages.slice(0, -1)
  const names = preview.participants
    .slice(0, 3)
    .map((participant) => participant.name ?? participant.email)
    .join(', ')

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-baseline justify-between gap-3 border-b border-border px-5 py-3">
        <span className="truncate text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          {preview.accountEmail}
        </span>
        {newest ? (
          <time
            dateTime={newest.sentAt}
            suppressHydrationWarning
            className="shrink-0 text-[11px] text-muted-foreground"
          >
            {timeAgo(newest.sentAt)}
          </time>
        ) : null}
      </div>

      <div className="px-5 py-4">
        <h2 className="line-clamp-3 text-base font-semibold text-card-foreground">
          {preview.topic ?? preview.subject}
        </h2>

        <div className="mt-3 flex items-center gap-2">
          <div className="flex shrink-0 -space-x-1.5">
            {preview.participants.slice(0, 3).map((participant) => (
              <Avatar
                key={participant.email}
                contact={participant}
                className="size-6 ring-2 ring-card"
              />
            ))}
          </div>
          <p className="min-w-0 truncate text-xs text-muted-foreground">
            {names}
          </p>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <StateBadge
            state={preview.state}
            label={stateLabels[preview.state].name}
          />
          {preview.done ? (
            <>
              <Separator />
              <DoneTag />
            </>
          ) : null}
          {preview.replyable ? null : (
            <>
              <Separator />
              <NoReplyTag />
            </>
          )}
          <Separator />
          <ImportanceTag score={preview.importance} />
          {preview.senderImportance !== null ? (
            <>
              <Separator />
              <span>contact {preview.senderImportance}/10</span>
            </>
          ) : null}
        </div>

        {/* The thread's ask, when the decision layer worked one out — the same
            line the row shows, repeated where there is room to read it. */}
        {preview.goal ? (
          <p className="mt-3 rounded-md border-l-2 border-primary/30 bg-muted/40 px-3 py-2 text-xs text-foreground/90">
            {preview.goal}
          </p>
        ) : null}

        {/* What the user knows about this person, when they have said. Two lines
            at most: the panel is for judging the mail, not for editing a CRM. */}
        {preview.contact &&
        (preview.contact.roleCompany || preview.contact.relationship) ? (
          <dl className="mt-3 grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1 text-[11px]">
            {preview.contact.roleCompany ? (
              <>
                <dt className="text-muted-foreground">Role</dt>
                <dd className="truncate text-foreground/90">
                  {preview.contact.roleCompany}
                </dd>
              </>
            ) : null}
            {preview.contact.relationship ? (
              <>
                <dt className="text-muted-foreground">Relationship</dt>
                <dd className="line-clamp-2 text-foreground/90">
                  {preview.contact.relationship}
                </dd>
              </>
            ) : null}
          </dl>
        ) : null}

        {newest ? (
          <p className="mt-3 line-clamp-[12] text-sm break-words whitespace-pre-wrap text-muted-foreground xl:line-clamp-[18]">
            {newest.body || 'No text in the newest message.'}
          </p>
        ) : null}

        {earlier.length > 0 ? (
          <div className="mt-4 border-t border-border pt-3">
            <p className="text-[11px] tracking-wide text-muted-foreground uppercase">
              Earlier in this thread
            </p>
            <ul className="mt-2 space-y-2">
              {earlier.map((message) => (
                <li key={`${message.sentAt}-${message.from}`}>
                  <p className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
                    <span className="truncate">
                      {message.isFromOwner ? 'You' : message.from}
                    </span>
                    <span
                      className="shrink-0 text-[11]"
                      suppressHydrationWarning
                    >
                      {timeAgo(message.sentAt)}
                    </span>
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground/90">
                    {message.body || 'No text.'}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {preview.attachments.length > 0 ? (
          <div className="mt-4 border-t border-border pt-3">
            <p className="text-[11px] tracking-wide text-muted-foreground uppercase">
              Attachments
            </p>
            <ul className="mt-2 space-y-1">
              {preview.attachments.map((attachment) => (
                <li
                  key={`${attachment.filename}-${attachment.sizeBytes}`}
                  className="flex items-baseline justify-between gap-2 text-xs text-foreground/90"
                >
                  <span className="truncate">{attachment.filename}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {formatSize(attachment.sizeBytes)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="mt-4 flex items-center justify-between gap-2 border-t border-border pt-3">
          <span className="text-[11px] text-muted-foreground">
            {preview.messageCount}{' '}
            {preview.messageCount === 1 ? 'message' : 'messages'}
          </span>
          <Link
            to="/conversations/$providerThreadId"
            params={{ providerThreadId: preview.providerThreadId }}
            className="inline-flex h-8 shrink-0 items-center rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:border-foreground/25"
          >
            Open
          </Link>
        </div>
      </div>
    </div>
  )
}

export type InboxFormPrompt = {
  id: string
  title: string
  description: string
  questionCount: number
}

export function Inbox({
  payload,
  formPrompt = null,
  openFormCount = 0,
  onResync,
  onDismissForm,
  onSearch,
  onSetDone,
  onSetState,
  onSetDoneMany,
  onSetStateMany,
  onPreview,
}: {
  payload: InboxPayload
  /** The newest unanswered form, promoted as a banner. */
  formPrompt?: InboxFormPrompt | null
  /** How many forms are open, including dismissed and already-answered ones. */
  openFormCount?: number
  /** Present when the app can rebuild from Gmail; absent in isolation/tests. */
  onResync?: () => Promise<{ error: string | null }>
  onDismissForm?: (formId: string) => Promise<{ error: string | null }>
  /**
   * Search every synced thread, including the ones the ten-per-section view is
   * hiding. Absent in isolation, where the box is not rendered: a search field
   * that cannot search is worse than no search field.
   */
  onSearch?: (
    query: string,
  ) => Promise<{ conversations: ConversationSummary[]; error: string | null }>
  /**
   * Load one thread's newest message for the preview column. Absent in
   * isolation, where the column falls back to its hint.
   */
  onPreview?: (
    providerThreadId: string,
  ) => Promise<{ preview: MailPreview | null; error: string | null }>
  /**
   * Mark a thread done from its row, without opening it. Optional because the
   * component also renders in isolation, where there is no server to call.
   */
  onSetDone?: (
    providerThreadId: string,
    done: boolean,
  ) => Promise<{ error: string | null }>
  /** Relabel a thread, or pass `null` to let the app file it again. */
  onSetState?: (
    providerThreadId: string,
    state: ConversationState | null,
  ) => Promise<{ error: string | null }>
  /**
   * The same two actions over a selection of threads.
   *
   * Optional like their single-row counterparts: in isolation there is no server
   * to write to, and a checkbox that cannot act is worse than no checkbox.
   */
  onSetDoneMany?: (
    providerThreadIds: string[],
    done: boolean,
  ) => Promise<{ error: string | null }>
  onSetStateMany?: (
    providerThreadIds: string[],
    state: ConversationState | null,
  ) => Promise<{ error: string | null }>
}) {
  // Hooks run before the signed-out early return, so the hook order is stable.
  const [resyncing, setResyncing] = useState(false)
  const [resyncError, setResyncError] = useState<string | null>(null)
  const [hiddenPromptId, setHiddenPromptId] = useState<string | null>(null)
  const [promptError, setPromptError] = useState<string | null>(null)
  const [searchInput, setSearchInput] = useState('')
  const [searchResults, setSearchResults] = useState<{
    query: string
    conversations: ConversationSummary[]
  } | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  // The request that is allowed to land. A slow answer for an old query must not
  // replace the results for what is in the box now.
  const searchRequest = useRef(0)
  const [sectionFilter, setSectionFilter] = useState('all')
  const [expandedSections, setExpandedSections] = useState<
    Record<string, boolean>
  >({})
  // The row the context menu belongs to, plus where it was opened. The
  // coordinates are viewport-based because the menu is `position: fixed`.
  const [menu, setMenu] = useState<{
    conversation: ConversationSummary
    x: number
    y: number
  } | null>(null)
  const [menuBusy, setMenuBusy] = useState(false)
  const [menuError, setMenuError] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  // Multi-select for batch triage. Ids rather than row objects, so a loader
  // refresh — which replaces every summary — does not drop the selection.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkError, setBulkError] = useState<string | null>(null)
  // Where a Shift range starts from, and whether Shift is down. Selection is
  // not a mode you switch on: holding Shift is the mode.
  const [anchor, setAnchor] = useState<string | null>(null)
  const [shiftHeld, setShiftHeld] = useState(false)
  // The preview column's own state: which row it is showing, its cache, and the
  // request allowed to land.
  const [preview, setPreview] = useState<{
    id: string
    data: MailPreview
  } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const previewCache = useRef(new Map<string, MailPreview>())
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previewRequest = useRef(0)

  /**
   * Ask the server after a short pause rather than on every keystroke.
   *
   * A search reads the whole synced window, so firing one per character would be
   * both wasteful and racy; 300ms is long enough to type a word and short enough
   * that the list still feels live.
   */
  useEffect(() => {
    const query = searchInput.trim()
    const request = searchRequest.current + 1
    searchRequest.current = request

    if (!query || !onSearch) {
      setSearchResults(null)
      setSearching(false)
      setSearchError(null)
      return
    }

    setSearching(true)
    const timer = setTimeout(() => {
      void onSearch(query)
        .then((result) => {
          if (request !== searchRequest.current) return
          setSearching(false)
          if (result.error) {
            setSearchError(result.error)
            setSearchResults(null)
            return
          }
          setSearchError(null)
          setSearchResults({ query, conversations: result.conversations })
        })
        .catch(() => {
          if (request !== searchRequest.current) return
          setSearching(false)
          setSearchError('Search failed. Try again in a moment.')
        })
    }, 300)

    return () => clearTimeout(timer)
  }, [searchInput, onSearch])

  useEffect(() => {
    if (!menu) return

    // Move focus into the menu: the right click did not focus the row, so a
    // keyboard user would otherwise be left on whatever was focused before.
    menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null)
    }
    // A click elsewhere, a scroll or a resize all leave the menu pointing at the
    // wrong row or floating in the wrong place, so it closes instead.
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null)
    }
    const onViewportChange = () => setMenu(null)

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('scroll', onViewportChange, true)
    window.addEventListener('resize', onViewportChange)

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('scroll', onViewportChange, true)
      window.removeEventListener('resize', onViewportChange)
    }
  }, [menu])

  /**
   * Open the row menu at the pointer.
   *
   * `contextmenu` fires for the right mouse button and for the keyboard's menu
   * key, so one handler serves both. The position is clamped to the viewport:
   * a row near the bottom edge would otherwise open the menu off-screen.
   */
  const openRowMenu = (
    event: MouseEvent,
    conversation: ConversationSummary,
  ) => {
    event.preventDefault()
    const width = 240
    const height = 320
    setMenuError(null)
    setMenu({
      conversation,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
    })
  }

  /**
   * Run one menu action; on failure the menu stays open with the reason.
   *
   * `ids` is the whole selection when the menu was opened on one of its rows,
   * so a single gesture can triage several threads. Every thread touched has its
   * cached preview dropped, and a successful batch leaves nothing selected.
   */
  const runMenuAction = async (
    action: (ids: string[]) => Promise<{ error: string | null }>,
    ids: string[],
  ) => {
    if (menuBusy || ids.length === 0) return
    setMenuBusy(true)
    setMenuError(null)
    try {
      const result = await action(ids)
      if (result.error) {
        setMenuError(result.error)
        return
      }
      for (const id of ids) previewCache.current.delete(id)
      if (preview && ids.includes(preview.id)) setPreview(null)
      if (ids.length > 1) {
        setSelected(new Set())
        setAnchor(null)
      }
      setMenu(null)
    } catch {
      setMenuError('That did not work. Try again.')
    } finally {
      setMenuBusy(false)
    }
  }

  useEffect(
    () => () => {
      if (previewTimer.current) clearTimeout(previewTimer.current)
    },
    [],
  )

  /**
   * Shift is the selection mode.
   *
   * Watched at the window so the checkboxes can appear before a row is touched,
   * and released on blur so switching tabs does not leave the list looking like
   * a mode the keyboard no longer agrees with. Ignored while typing, where Shift
   * is a capital letter rather than a selection modifier.
   */
  useEffect(() => {
    if (!onSetDoneMany && !onSetStateMany) return

    const isTyping = (target: EventTarget | null) => {
      const element = target as HTMLElement | null
      if (!element) return false
      const tag = element.tagName
      return (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        element.isContentEditable
      )
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Shift' && !isTyping(event.target)) setShiftHeld(true)
      if (event.key === 'Escape') {
        setSelected(new Set())
        setAnchor(null)
      }
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Shift') setShiftHeld(false)
    }
    const onBlur = () => setShiftHeld(false)

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [onSetDoneMany, onSetStateMany])

  // A search that matches nothing would otherwise leave the chosen section
  // selected for the list that comes back, which then reads as empty with no
  // visible cause. Clearing it as the empty result lands is what puts the
  // "no matches" message back in charge.
  useEffect(() => {
    if (!searchInput.trim() || !searchResults) return
    if (searchResults.conversations.length === 0) setSectionFilter('all')
  }, [searchInput, searchResults])

  /**
   * Show a thread in the preview column.
   *
   * Pointing at a row is the pointer moving down a list, so the load is debounced
   * and cached: passing over five rows on the way to the sixth must not start
   * five reads. The last preview stays on screen when the pointer leaves a row —
   * blanking it would make the column flicker in every gap between cards.
   */
  const showPreview = (conversation: ConversationSummary) => {
    if (!onPreview) return
    // The column is hidden below `lg`, so there is nothing to fill and no point
    // spending a request on a tap that navigates anyway.
    if (!window.matchMedia('(min-width: 1024px)').matches) return

    const id = conversation.providerThreadId
    setPreviewError(null)

    const cached = previewCache.current.get(id)
    if (cached) {
      setPreview({ id, data: cached })
      return
    }

    const request = previewRequest.current + 1
    previewRequest.current = request
    if (previewTimer.current) clearTimeout(previewTimer.current)
    setPreviewLoading(true)
    previewTimer.current = setTimeout(() => {
      void onPreview(id)
        .then((result) => {
          if (request !== previewRequest.current) return
          setPreviewLoading(false)
          if (result.error) {
            setPreviewError(result.error)
            return
          }
          if (!result.preview) return
          previewCache.current.set(id, result.preview)
          setPreview({ id, data: result.preview })
        })
        .catch(() => {
          if (request !== previewRequest.current) return
          setPreviewLoading(false)
          setPreviewError('Could not load the preview.')
        })
    }, 180)
  }

  const handleDismissPrompt = async () => {
    if (!formPrompt || !onDismissForm) return

    setPromptError(null)
    const result = await onDismissForm(formPrompt.id)
    if (result.error) {
      setPromptError(result.error)
      return
    }

    setHiddenPromptId(formPrompt.id)
  }

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

  // Bound to locals so the closures below keep the non-null narrowing.
  const doneMany = onSetDoneMany
  const stateMany = onSetStateMany
  const selectable = Boolean(doneMany || stateMany)
  // The checkboxes are only part of the page while a selection gesture is
  // possible or under way; otherwise the rows stay a clean list.
  const showSelectors = selectable && (shiftHeld || selected.size > 0)

  /**
   * The rows a menu action applies to.
   *
   * Widened to the selection only when the menu was opened on a selected row:
   * right-clicking some other thread is a statement about that thread alone,
   * even while a selection exists elsewhere in the list.
   */
  const menuTargetIds =
    menu &&
    selected.has(menu.conversation.providerThreadId) &&
    selected.size > 1
      ? [...selected]
      : menu
        ? [menu.conversation.providerThreadId]
        : []

  /** Apply a done change to the menu's targets, through the batch when there is one. */
  const applyDone = (
    ids: string[],
    done: boolean,
  ): Promise<{ error: string | null }> => {
    if (doneMany) return doneMany(ids, done)
    const [id] = ids
    if (id && onSetDone) return onSetDone(id, done)
    return Promise.resolve({ error: 'Nothing to update.' })
  }

  /** The same for a label, including handing the threads back with `null`. */
  const applyState = (
    ids: string[],
    state: ConversationState | null,
  ): Promise<{ error: string | null }> => {
    if (stateMany) return stateMany(ids, state)
    const [id] = ids
    if (id && onSetState) return onSetState(id, state)
    return Promise.resolve({ error: 'Nothing to update.' })
  }

  /**
   * Select one row, or the run between the anchor and it.
   *
   * Shift adds everything from the previous pick down to this row, in the order
   * the rows are actually on screen — the range the user is pointing at, not the
   * hidden rest of a collapsed section. Ctrl (or Cmd) toggles just the one row
   * and keeps the rest. Clicking a row without either modifier navigates, which
   * is why `selectable` only matters once a modifier is down.
   */
  const selectRow = (
    providerThreadId: string,
    modifiers: { shiftKey: boolean; additive: boolean },
  ) => {
    setSelected((current) => {
      const next = new Set(current)

      if (modifiers.shiftKey && anchor) {
        const from = renderedOrder.indexOf(anchor)
        const to = renderedOrder.indexOf(providerThreadId)
        if (from !== -1 && to !== -1) {
          const [start, end] = from < to ? [from, to] : [to, from]
          for (const id of renderedOrder.slice(start, end + 1)) next.add(id)
          return next
        }
      }

      if (next.has(providerThreadId)) next.delete(providerThreadId)
      else next.add(providerThreadId)
      return next
    })

    setAnchor(providerThreadId)
  }

  /**
   * Run one action over the whole selection.
   *
   * The list is left alone until the action answers: a row that vanishes before
   * the server has agreed is a lie the next refresh has to take back. On success
   * the selection clears and the preview's cached copy is dropped, since the
   * thread it was showing may now be labelled differently.
   */
  const runBulk = async (
    action: (ids: string[]) => Promise<{ error: string | null }>,
  ) => {
    if (bulkBusy || selected.size === 0) return

    const ids = [...selected]
    setBulkBusy(true)
    setBulkError(null)
    try {
      const result = await action(ids)
      if (result.error) {
        setBulkError(result.error)
        return
      }
      for (const id of ids) previewCache.current.delete(id)
      if (preview && ids.includes(preview.id)) setPreview(null)
      setSelected(new Set())
      setAnchor(null)
    } catch {
      setBulkError('That did not work. Try again.')
    } finally {
      setBulkBusy(false)
    }
  }

  if (!payload.signedIn) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
        <h1 className="text-3xl font-bold">Nuntia</h1>
        <div className="mt-8">
          <SignInPrompt microsoftConfigured={payload.microsoftConfigured} />
        </div>
      </div>
    )
  }

  // Signed in with nothing connected is not an empty inbox — it is a first run.
  // Checked before the inbox chrome so a new invitee never sees filters and a
  // "nothing in the synced window" message about mail that cannot exist yet.
  if (payload.accounts.length === 0)
    return <GetStarted microsoftConfigured={payload.microsoftConfigured} />

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

  // While a search is in flight the last results stay on screen; clearing the
  // list on every keystroke would make the page flicker between states.
  const searchQuery = searchInput.trim()
  const searchActive = searchQuery.length > 0
  const visibleConversations = searchResults?.conversations ?? conversations
  const stateLabels = payload.stateLabels

  // Counted from the rows being rendered rather than taken from the payload, so
  // the headings agree with a search's results rather than with the whole
  // mailbox.
  const organizationGroups = partitionOrganizationGroups(
    visibleConversations,
    payload.organizationRules,
  )
  const stateCounts = Object.fromEntries(
    STATE_ORDER.map((state) => [
      state,
      organizationGroups.ungrouped.filter(
        (conversation) => conversation.state === state,
      ).length,
    ]),
  ) as Record<ConversationState, number>
  const visibleStates = STATE_ORDER.filter((state) => stateCounts[state] > 0)
  const done = organizationGroups.done

  // One shape for every group, so the heading, the meaning, the cap and the
  // filter behave the same whether the label is built in or the user's own.
  const sections: InboxSection[] = [
    ...organizationGroups.groups.map((group) => ({
      key: `label:${group.id}`,
      title: group.name,
      description: group.description || null,
      dotClass: 'bg-foreground/30',
      items: [...group.items].sort(byImportance),
    })),
    ...visibleStates.map((state) => ({
      key: `state:${state}`,
      title: stateLabels[state].name,
      description: stateLabels[state].description || null,
      dotClass: STATE_META[state].dotClass,
      items: byState(organizationGroups.ungrouped, state).sort(byImportance),
    })),
    ...(done.length > 0
      ? [
          {
            key: 'done',
            title: DONE_GROUP.label,
            description: DONE_GROUP.description,
            dotClass: 'bg-muted-foreground',
            items: done,
            muted: true,
          },
        ]
      : []),
  ]
  // A filter can stop existing between renders (a rule was disabled, a search
  // narrowed the sections), and a search can empty the section being viewed
  // while still matching mail elsewhere. Falling back to everything is what
  // shows those matches rather than an empty section under a selected tab.
  const filterMatchedNothing =
    searchActive &&
    sections.find((section) => section.key === sectionFilter)?.items.length ===
      0
  const activeFilter = filterMatchedNothing
    ? 'all'
    : sections.some((section) => section.key === sectionFilter)
      ? sectionFilter
      : 'all'
  const shownSections =
    activeFilter === 'all'
      ? sections
      : sections.filter((section) => section.key === activeFilter)
  // The order a Shift range follows: what is on screen, top to bottom, with the
  // same per-section cap the list renders under.
  const renderedOrder = shownSections.flatMap((section) => {
    const showsAll =
      activeFilter === section.key ||
      searchActive ||
      expandedSections[section.key] === true
    const items = showsAll
      ? section.items
      : section.items.slice(0, SECTION_PAGE_SIZE)
    return items.map((conversation) => conversation.providerThreadId)
  })

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-8 lg:max-w-7xl 2xl:max-w-[88rem]">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Nuntia</h1>
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
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="hidden min-w-0 max-w-56 truncate text-xs text-muted-foreground sm:block">
            {accounts.map((account) => account.email).join(' · ')}
          </span>
          <Link
            to="/compose"
            className={cn(
              'inline-flex h-9 shrink-0 items-center rounded-md bg-primary px-3',
              'text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90',
            )}
          >
            New message
          </Link>
          {/* Account-level actions, collapsed: they are rare next to reading the
              list, and laid out flat they were wider than the page. */}
          <details className="relative shrink-0">
            <summary
              className={cn(
                'inline-flex h-9 cursor-pointer list-none items-center rounded-md border border-border bg-background px-3',
                'text-xs font-medium text-foreground transition-colors hover:border-foreground/25',
                '[&::-webkit-details-marker]:hidden',
              )}
            >
              Mailboxes
              {openFormCount > 0 ? (
                <span
                  aria-hidden="true"
                  className="ml-1.5 size-1.5 rounded-full bg-primary"
                />
              ) : null}
            </summary>
            <div className="absolute right-0 z-20 mt-1 w-60 rounded-lg border border-border bg-card p-1 shadow-lg">
              <p className="px-2.5 pt-1.5 pb-1 text-[11px] tracking-wide text-muted-foreground uppercase">
                Connected
              </p>
              <ul className="mb-1 space-y-0.5">
                {accounts.map((account) => (
                  <li
                    key={account.id}
                    title={account.email}
                    className="truncate px-2.5 py-1 text-xs text-foreground"
                  >
                    {account.email}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => void handleResync()}
                disabled={resyncing || !onResync}
                title="Re-fetch the last 30 days from Gmail"
                className="block w-full rounded-md px-2.5 py-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                {resyncing ? 'Re-syncing…' : 'Re-sync mail'}
              </button>
              <a
                href="/auth/google"
                className="block rounded-md px-2.5 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted"
              >
                Add Gmail mailbox
              </a>
              <OutlookButton
                configured={payload.microsoftConfigured}
                className="block w-full rounded-md px-2.5 py-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-muted"
              >
                Add Outlook mailbox
              </OutlookButton>
              {openFormCount > 0 ? (
                <Link
                  to="/ask"
                  className="block rounded-md px-2.5 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                >
                  Questions ({openFormCount})
                </Link>
              ) : null}
              {/* The beta's one standing invitation to say something. A link, not
                  a popup: the point is that it is there when something goes wrong. */}
              <Link
                to="/feedback"
                className="block rounded-md px-2.5 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted"
              >
                Send feedback
              </Link>
            </div>
          </details>
          <Link
            to="/settings"
            className={cn(
              'inline-flex h-9 shrink-0 items-center rounded-md border border-border bg-background px-3',
              'text-xs font-medium text-foreground transition-colors hover:border-foreground/25',
            )}
          >
            Settings
          </Link>
        </div>
      </header>

      {/* The shape of the work before the work: counts the section headings
          would otherwise only reveal one at a time. */}
      <SummaryStrip
        counts={counts}
        doneCount={doneCount}
        unseenCount={
          conversations.filter(
            (conversation) => conversation.unseen && !conversation.done,
          ).length
        }
        lastSyncedAt={lastSyncedAt}
        syncing={syncing.length > 0}
        accountCount={accounts.length}
      />

      {/* The actions a row offers without opening it: the two marks the user
          owns, and the label. Opened by right click or the menu key. */}
      {menu ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Thread actions"
          style={{ top: menu.y, left: menu.x }}
          className="fixed z-50 w-60 rounded-lg border border-border bg-card p-1 shadow-xl"
        >
          <p className="truncate px-2.5 pt-1.5 pb-1 text-[11px] text-muted-foreground">
            {menu.conversation.topic ?? menu.conversation.subject}
          </p>
          <Link
            to="/conversations/$providerThreadId"
            params={{ providerThreadId: menu.conversation.providerThreadId }}
            role="menuitem"
            onClick={() => setMenu(null)}
            className="block rounded-md px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted focus:bg-muted focus:outline-none"
          >
            Open thread
          </Link>
          {onSetDone || doneMany ? (
            <button
              type="button"
              role="menuitem"
              disabled={menuBusy}
              onClick={() =>
                void runMenuAction(
                  (ids) => applyDone(ids, !menu.conversation.done),
                  menuTargetIds,
                )
              }
              className="block w-full rounded-md px-2.5 py-1.5 text-left text-xs font-medium text-foreground hover:bg-muted focus:bg-muted focus:outline-none disabled:opacity-50"
            >
              {menuTargetIds.length > 1
                ? `Mark ${menuTargetIds.length} as ${menu.conversation.done ? 'not done' : 'done'}`
                : menu.conversation.done
                  ? 'Mark as not done'
                  : 'Mark as done'}
            </button>
          ) : null}
          {onSetState || stateMany ? (
            <>
              <div className="my-1 h-px bg-border" />
              <p className="px-2.5 pt-1 pb-1 text-[11px] tracking-wide text-muted-foreground uppercase">
                {menuTargetIds.length > 1
                  ? `Label ${menuTargetIds.length} conversations`
                  : 'Label'}
              </p>
              {STATE_ORDER.map((state) => (
                <button
                  key={state}
                  type="button"
                  role="menuitemradio"
                  aria-checked={menu.conversation.state === state}
                  disabled={menuBusy}
                  onClick={() =>
                    void runMenuAction(
                      (ids) => applyState(ids, state),
                      menuTargetIds,
                    )
                  }
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-foreground hover:bg-muted focus:bg-muted focus:outline-none disabled:opacity-50',
                    menu.conversation.state === state && 'font-semibold',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'size-1.5 rounded-full',
                      STATE_META[state].dotClass,
                    )}
                  />
                  {stateLabels[state].name}
                  {menu.conversation.state === state ? (
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      now
                    </span>
                  ) : null}
                </button>
              ))}
              <button
                type="button"
                role="menuitem"
                disabled={menuBusy}
                onClick={() =>
                  void runMenuAction(
                    (ids) => applyState(ids, null),
                    menuTargetIds,
                  )
                }
                className="block w-full rounded-md px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted focus:bg-muted focus:outline-none disabled:opacity-50"
              >
                {menuTargetIds.length > 1
                  ? 'Use automatic label for all'
                  : 'Use automatic label'}
              </button>
            </>
          ) : null}
          {menuError ? (
            <p
              role="alert"
              className="px-2.5 pt-1 pb-1.5 text-[11px] text-destructive"
            >
              {menuError}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* List on the left, preview on the right; the column only exists where
          there is width for it, and the list keeps the full width below that. */}
      <div className="lg:flex lg:items-start lg:gap-8">
        <div className="min-w-0 lg:flex-1">
          {formPrompt && hiddenPromptId !== formPrompt.id ? (
            <div className="mt-6 rounded-md border border-border bg-muted/40 px-4 py-3 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">
                    One question from the Nuntia team
                  </p>
                  <p className="mt-0.5 text-muted-foreground">
                    {formPrompt.title}
                    {' · '}
                    {formPrompt.questionCount}{' '}
                    {formPrompt.questionCount === 1 ? 'question' : 'questions'}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <Link
                    to="/ask/$id"
                    params={{ id: formPrompt.id }}
                    className="text-primary hover:underline"
                  >
                    Answer
                  </Link>
                  <button
                    onClick={() => void handleDismissPrompt()}
                    className="text-xs text-muted-foreground hover:underline"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
              {promptError ? (
                <p className="mt-2 text-xs text-destructive">{promptError}</p>
              ) : null}
            </div>
          ) : null}

          {authRequiredAccounts.length > 0 ? (
            <div
              role="alert"
              className="mt-6 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
            >
              <p>
                The mail service no longer accepts the stored access for{' '}
                {authRequiredAccounts
                  .map((account) => account.email)
                  .join(', ')}{' '}
                — you may have revoked it, or it expired. Sign in again to keep
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

          {searchActive && searchError && !searching ? (
            <p
              role="alert"
              className="mt-8 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
            >
              {searchError}
            </p>
          ) : null}

          {/*
           * The two ways to narrow a long inbox: a section of its own, or a
           * search across all synced mail. They compose — a search under a
           * section is just that section's matches — and each is usable alone.
           *
           * Deliberately outside the results check: this used to render only
           * when something matched, so a search that found nothing took the
           * search box off the screen with the results and left the user with no
           * way to clear the query.
           */}
          {onSearch || sections.length > 1 ? (
            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              {/* Pills rather than a select: the counts are the point, and a
                drop-down hid every section but the chosen one. */}
              {sections.length > 1 ? (
                <div
                  role="group"
                  aria-label="Show one section"
                  className="flex items-center gap-1 overflow-x-auto rounded-lg border border-border bg-muted/40 p-1"
                >
                  <button
                    type="button"
                    aria-pressed={activeFilter === 'all'}
                    onClick={() => setSectionFilter('all')}
                    className={cn(
                      'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors',
                      activeFilter === 'all'
                        ? 'bg-card text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    All
                    <span className="tabular-nums text-muted-foreground">
                      {visibleConversations.length}
                    </span>
                  </button>
                  {sections.map((section) => (
                    <button
                      key={section.key}
                      type="button"
                      aria-pressed={activeFilter === section.key}
                      onClick={() => setSectionFilter(section.key)}
                      className={cn(
                        'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors',
                        activeFilter === section.key
                          ? 'bg-card text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          'size-1.5 rounded-full',
                          section.dotClass,
                        )}
                      />
                      {section.title}
                      <span className="tabular-nums text-muted-foreground">
                        {section.items.length}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <span />
              )}

              {onSearch ? (
                <div className="flex w-full items-center gap-2 sm:w-auto sm:justify-end">
                  <input
                    type="search"
                    aria-label="Search all mail"
                    placeholder="Search all mail…"
                    value={searchInput}
                    onChange={(event) => setSearchInput(event.target.value)}
                    className="h-9 w-full rounded-md border border-border bg-background px-2.5 text-xs text-foreground outline-none focus:border-foreground/30 sm:w-64"
                  />
                  {searching ? (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      Searching…
                    </span>
                  ) : null}
                  {searchActive ? (
                    <button
                      type="button"
                      onClick={() => setSearchInput('')}
                      className="shrink-0 text-xs text-muted-foreground hover:underline"
                    >
                      Clear
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {selected.size > 0 ? (
            <div
              role="region"
              aria-label="Selected conversations"
              className="sticky top-2 z-20 mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-card px-3 py-2 shadow-sm"
            >
              <span className="text-xs font-semibold text-foreground">
                {selected.size} selected
              </span>
              <span className="hidden text-[11px] text-muted-foreground lg:inline">
                Shift-click a row for a range · Ctrl-click to toggle
              </span>
              {doneMany ? (
                <>
                  <button
                    type="button"
                    disabled={bulkBusy}
                    onClick={() => void runBulk((ids) => doneMany(ids, true))}
                    className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-foreground hover:bg-muted disabled:opacity-50"
                  >
                    Mark done
                  </button>
                  <button
                    type="button"
                    disabled={bulkBusy}
                    onClick={() => void runBulk((ids) => doneMany(ids, false))}
                    className="rounded-md px-1 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
                  >
                    Mark not done
                  </button>
                </>
              ) : null}
              {stateMany ? (
                <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  Label
                  <select
                    value=""
                    disabled={bulkBusy}
                    onChange={(event) => {
                      const value = event.target.value
                      if (!value) return
                      void runBulk((ids) =>
                        stateMany(
                          ids,
                          value === 'automatic'
                            ? null
                            : (value as ConversationState),
                        ),
                      )
                    }}
                    className="rounded-md border border-border bg-background px-1.5 py-0.5 text-[11px] text-foreground disabled:opacity-50"
                  >
                    <option value="">Apply…</option>
                    {STATE_ORDER.map((state) => (
                      <option key={state} value={state}>
                        {stateLabels[state].name}
                      </option>
                    ))}
                    <option value="automatic">Automatic</option>
                  </select>
                </label>
              ) : null}
              {bulkBusy ? (
                <span className="text-[11px] text-muted-foreground">
                  Working…
                </span>
              ) : null}
              <button
                type="button"
                disabled={bulkBusy}
                onClick={() => {
                  setSelected(new Set())
                  setAnchor(null)
                  setBulkError(null)
                }}
                className="ml-auto text-[11px] text-muted-foreground hover:underline disabled:opacity-50"
              >
                Clear
              </button>
              {bulkError ? (
                <p role="alert" className="w-full text-[11px] text-destructive">
                  {bulkError}
                </p>
              ) : null}
            </div>
          ) : null}

          {sections.some((section) => !section.muted) ? (
            <p className="mt-3 text-[11px] text-muted-foreground">
              Sorted by importance, highest first, then newest.
            </p>
          ) : null}

          {searchActive &&
          searchResults &&
          !searching &&
          searchResults.conversations.length > 0 ? (
            <p role="status" className="mt-2 text-xs text-muted-foreground">
              {searchResults.conversations.length}{' '}
              {searchResults.conversations.length === 1 ? 'result' : 'results'}{' '}
              for “{searchResults.query}” in synced mail.
            </p>
          ) : null}

          {visibleConversations.length === 0 ? (
            <div className="mt-8">
              <p className="text-sm text-muted-foreground">
                {searchActive
                  ? searching
                    ? 'Searching…'
                    : `No synced mail matches “${searchQuery}”.`
                  : syncing.length > 0
                    ? 'The first sync is running — conversations will appear here as they arrive.'
                    : lastSyncedAt
                      ? 'Nothing in the synced window.'
                      : 'Nothing synced yet.'}
              </p>
              {searchActive && !searching ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {syncing.length > 0
                    ? 'Mail is still syncing in, so this can change as it arrives. '
                    : ''}
                  Search covers the mail already synced, not the whole mailbox.
                  Try one word, a sender’s name, or an address.
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="mt-8 space-y-8">
            {shownSections.map((section) => {
              const isFiltered = activeFilter === section.key
              // The cap belongs to the compact all-sections view. A section on
              // its own, or a search's matches, shows everything it found.
              const showsAll =
                isFiltered ||
                searchActive ||
                expandedSections[section.key] === true
              const shown = showsAll
                ? section.items
                : section.items.slice(0, SECTION_PAGE_SIZE)

              return (
                <section key={section.key}>
                  <div className="mb-1 flex items-baseline justify-between gap-4">
                    <h2
                      className={cn(
                        'text-sm font-semibold tracking-wide uppercase',
                        section.muted
                          ? 'text-muted-foreground'
                          : 'text-foreground',
                      )}
                    >
                      {section.title}
                    </h2>
                    <span className="text-xs text-muted-foreground">
                      {section.items.length}
                    </span>
                  </div>
                  {/* The label's meaning, in the user's words — the reason a
                      section explains itself rather than only naming itself. */}
                  {section.description ? (
                    <p className="mb-3 text-xs text-muted-foreground">
                      {section.description}
                    </p>
                  ) : (
                    <div className="mb-3" />
                  )}

                  <ul className="space-y-3">
                    {shown.map((conversation) =>
                      // Same feed, same grouping — only the presentation differs.
                      // A failed build is still `needs-action`; it just is not a
                      // chat.
                      conversation.isAutomated ? (
                        <AutomatedRow
                          key={conversation.id}
                          conversation={conversation}
                          showAccount={accounts.length > 1}
                          onRowMenu={openRowMenu}
                          onRowPreview={showPreview}
                          active={preview?.id === conversation.providerThreadId}
                          selectable={selectable}
                          selected={selected.has(conversation.providerThreadId)}
                          showSelector={showSelectors}
                          onSelect={selectRow}
                        />
                      ) : (
                        <ConversationRow
                          key={conversation.id}
                          conversation={conversation}
                          stateLabel={stateLabels[conversation.state].name}
                          showAccount={accounts.length > 1}
                          onRowMenu={openRowMenu}
                          onRowPreview={showPreview}
                          active={preview?.id === conversation.providerThreadId}
                          selectable={selectable}
                          selected={selected.has(conversation.providerThreadId)}
                          showSelector={showSelectors}
                          onSelect={selectRow}
                        />
                      ),
                    )}
                  </ul>

                  {!isFiltered &&
                  !searchActive &&
                  section.items.length > SECTION_PAGE_SIZE ? (
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedSections((current) => ({
                          ...current,
                          [section.key]: current[section.key] !== true,
                        }))
                      }
                      className="mt-3 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-foreground/25"
                    >
                      {expandedSections[section.key]
                        ? 'Show fewer'
                        : `Show all ${section.items.length}`}
                    </button>
                  ) : null}
                </section>
              )
            })}
          </div>
        </div>

        <aside className="hidden lg:sticky lg:top-6 lg:block lg:w-96 lg:shrink-0 xl:w-[26rem] 2xl:w-[32rem]">
          <MailPreviewCard
            preview={preview?.data ?? null}
            loading={previewLoading}
            error={previewError}
            stateLabels={stateLabels}
          />
        </aside>
      </div>
    </div>
  )
}
