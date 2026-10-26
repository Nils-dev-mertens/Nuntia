/**
 * The conversation list.
 *
 * Grouped by state rather than chronology — that is the whole premise of the app:
 * what needs doing comes first, and time is secondary.
 */

import { useEffect, useRef, useState } from 'react'

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
  stateLabel,
}: {
  conversation: ConversationSummary
  /** The user's wording for this thread's label; the default when unchanged. */
  stateLabel: string
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
            label={stateLabel}
            className={conversation.done ? 'opacity-60' : undefined}
          />
          {conversation.done ? <DoneTag /> : null}
          {/* A human thread can still have nobody to answer — same "No reply"
              tag as an automated card, since the composer is hidden either way. */}
          {conversation.replyable ? null : <NoReplyTag />}
          {conversation.senderImportance !== null ? (
            <span
              title="Your importance rating for this correspondent; used as context when classifying their mail."
              className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary"
            >
              Contact · {conversation.senderImportance}/10
            </span>
          ) : null}
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
function GetStarted() {
  return (
    <div className="mx-auto max-w-2xl p-8">
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
              &ldquo;Done&rdquo; is yours — new mail brings the thread back on its
              own.
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

function SignInPrompt() {
  return (
    <div className="rounded-lg border border-border bg-card p-8 text-center">
      <h2 className="text-lg font-semibold text-card-foreground">
        Connect your mailbox
      </h2>
      <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
        Nuntia reads your mail and shows it as a list of conversations grouped by
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

  if (!payload.signedIn) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <h1 className="text-3xl font-bold">Nuntia</h1>
        <div className="mt-8">
          <SignInPrompt />
        </div>
      </div>
    )
  }

  // Signed in with nothing connected is not an empty inbox — it is a first run.
  // Checked before the inbox chrome so a new invitee never sees filters and a
  // "nothing in the synced window" message about mail that cannot exist yet.
  if (payload.accounts.length === 0) return <GetStarted />

  const {
    accounts,
    conversations,
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
      organizationGroups.ungrouped.filter((conversation) => conversation.state === state).length,
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
      items: group.items,
    })),
    ...visibleStates.map((state) => ({
      key: `state:${state}`,
      title: stateLabels[state].name,
      description: stateLabels[state].description || null,
      items: byState(organizationGroups.ungrouped, state),
    })),
    ...(done.length > 0
      ? [
          {
            key: 'done',
            title: DONE_GROUP.label,
            description: DONE_GROUP.description,
            items: done,
            muted: true,
          },
        ]
      : []),
  ]
  // A filter can stop existing between renders (a rule was disabled, a search
  // narrowed the sections); falling back to everything beats an empty page.
  const activeFilter = sections.some(
    (section) => section.key === sectionFilter,
  )
    ? sectionFilter
    : 'all'
  const shownSections =
    activeFilter === 'all'
      ? sections
      : sections.filter((section) => section.key === activeFilter)

  return (
    <div className="mx-auto max-w-2xl p-8">
      <header className="flex items-baseline justify-between gap-4">
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
          {openFormCount > 0 ? (
            <Link
              to="/ask"
              className={cn(
                'shrink-0 inline-flex h-8 items-center rounded-md border border-border bg-background px-3',
                'text-xs font-medium text-foreground transition-colors hover:border-foreground/25',
              )}
            >
              Questions
            </Link>
          ) : null}
          {/* The beta's one standing invitation to say something. A link, not a
              popup: the point is that it is there when something goes wrong. */}
          <Link
            to="/feedback"
            className={cn(
              'shrink-0 inline-flex h-8 items-center rounded-md border border-border bg-background px-3',
              'text-xs font-medium text-foreground transition-colors hover:border-foreground/25',
            )}
          >
            Feedback
          </Link>
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

      {formPrompt && hiddenPromptId !== formPrompt.id ? (
        <div className="mt-6 rounded-md border border-border bg-muted/40 px-4 py-3 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium">One question from the Nuntia team</p>
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

      {searchActive && searchError && !searching ? (
        <p
          role="alert"
          className="mt-8 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {searchError}
        </p>
      ) : visibleConversations.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">
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
      ) : (
        <>
          {/*
           * The two ways to narrow a long inbox: a section of its own, or a
           * search across all synced mail. They compose — a search under a
           * section is just that section's matches — and each is usable alone.
           */}
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            {sections.length > 1 ? (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                Show
                <select
                  aria-label="Show one section"
                  value={activeFilter}
                  onChange={(event) => setSectionFilter(event.target.value)}
                  className="rounded-md border border-border bg-background px-2 py-1 text-xs font-medium text-foreground"
                >
                  <option value="all">All sections</option>
                  {sections.map((section) => (
                    <option key={section.key} value={section.key}>
                      {section.title} ({section.items.length})
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <span />
            )}

            {onSearch ? (
              <div className="ml-auto flex items-center gap-2">
                <input
                  type="search"
                  aria-label="Search all mail"
                  placeholder="Search all mail…"
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  className="h-8 w-64 max-w-full rounded-md border border-border bg-background px-2.5 text-xs text-foreground outline-none focus:border-foreground/30"
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

          {searchActive && searchResults && !searching ? (
            <p role="status" className="mt-2 text-xs text-muted-foreground">
              {searchResults.conversations.length}{' '}
              {searchResults.conversations.length === 1 ? 'result' : 'results'}{' '}
              for “{searchResults.query}” in synced mail.
            </p>
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
                        />
                      ) : (
                        <ConversationRow
                          key={conversation.id}
                          conversation={conversation}
                          stateLabel={
                            stateLabels[conversation.state].name
                          }
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
        </>
      )}
    </div>
  )
}
