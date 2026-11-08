/**
 * Account and AI settings.
 *
 * The two AI services are configured here rather than in the environment: the
 * keys are per-user secrets set by the signed-in person, stored encrypted, and
 * editable without a redeploy. Each service is independent — you can configure
 * Jev without an LLM, or an LLM without Jev, and an unconfigured service simply
 * falls back to the rule-based behaviour.
 *
 * Identity lives here too: who is signed in, which devices hold a session, and
 * the two ways out — this device, or every other one.
 *
 * The loader returns a *summary* only (is it configured, which model). The keys
 * are never sent to the browser.
 */

import { createServerFn } from '@tanstack/react-start'
import {
  createFileRoute,
  Link,
  redirect,
  useRouter,
} from '@tanstack/react-router'
import { useState } from 'react'
import type { FormEvent } from 'react'
import {
  ArrowLeft,
  Ban,
  FolderTree,
  Mail,
  MessageSquare,
  SlidersHorizontal,
  Sparkles,
  Tag,
  User,
} from 'lucide-react'

import { AppShell } from '#/components/app-shell.tsx'

import {
  destroySession,
  getSession,
  getUser,
  listAccounts,
  listSessions,
  revokeAllSessions,
} from '#/lib/auth/index.ts'
import { getAiSettings, saveAiSettings } from '#/lib/ai/index.ts'
import type { AiSettingsSummary, LlmProvider } from '#/lib/ai/index.ts'
import {
  listRecentContextRevisions,
  undoContextRevision,
} from '#/lib/context/revisions.ts'
import type { ContextRevisionView } from '#/lib/context/revisions.ts'
import {
  addUnreplyableSender,
  forgetAccount,
  removeUnreplyableSender,
} from '#/lib/gmail/service.ts'
import {
  getParsingProfileContext,
  listIncomingSenders,
  listUnreplyableSenders,
  reparseStoredMessages,
  saveAccountParsingDefaults,
} from '#/lib/conversation/index.ts'
import type { ParsingPreferences } from '#/lib/conversation/index.ts'
import { assertOwnedAccount } from '#/lib/auth/accounts.ts'
import { redecideStoredConversations } from '#/lib/mailbox/sync.ts'
// The draft limits are imported from the pure module that defines them, not from
// the conversation barrel: the barrel also re-exports the repository and the
// decision pipeline, and a browser import of it drags `node:fs` (the AI log)
// into the client graph. Only server functions may use the barrel.
import {
  REPLY_DRAFT_MIN_IMPORTANCE_MAX,
  REPLY_DRAFT_MIN_IMPORTANCE_MIN,
} from '#/lib/conversation/draft.ts'
import { getPreferences, savePreferences } from '#/lib/settings/preferences.ts'
import {
  listOrganizationLabels,
  listStateLabels,
  saveOrganizationLabels,
  saveStateLabels,
} from '#/lib/organization/store.ts'
import type {
  OrganizationLabel,
  OrganizationMatchRule,
  OrganizationRuleField,
} from '#/lib/organization/matching.ts'
import {
  ORGANIZATION_RULE_FIELDS,
  ORGANIZATION_RULE_LIMITS,
} from '#/lib/organization/matching.ts'
import {
  STATE_LABEL_LIMITS,
  STATE_MEANING_MIN_CORRECTIONS,
  defaultStateLabels,
} from '#/lib/organization/labels.ts'
import type { StateLabels } from '#/lib/organization/labels.ts'
import { proposeStateMeaning } from '#/lib/organization/state-meaning.ts'
import type { StateMeaningProposal } from '#/lib/organization/state-meaning.ts'
import { CONVERSATION_STATES } from '#/db/schema.ts'
import { STATE_META, STATE_ORDER } from '#/lib/conversation-state.ts'

/** Provider choices for the topic generator. Labels only — no server code. */
const PROVIDERS: Array<{ value: '' | LlmProvider; label: string }> = [
  { value: '', label: 'Off — no topic labels' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'gemini', label: 'Google Gemini' },
]

const PROVIDER_VALUES = new Set(PROVIDERS.map((p) => p.value))

const fetchAiSettings = createServerFn({ method: 'GET' }).handler(
  async (): Promise<
    | { signedIn: false }
    | {
        signedIn: true
        settings: AiSettingsSummary
        organizationLabels: OrganizationLabel[]
        /** The four state labels, with the user's wording applied. */
        stateLabels: StateLabels
        /** Recent automatic context writes, newest first, with an Undo each. */
        contextRevisions: ContextRevisionView[]
        /** Connected mailboxes, so they can be listed and cleared out. */
        accounts: Array<{
          id: string
          email: string
          provider: 'google' | 'microsoft'
          parsingDefaults: ParsingPreferences
          defaultReplyGreeting: string
          defaultReplySignature: string
        }>
        /** Whether avatars may be fetched from Gravatar (opt-in, off by default). */
        useGravatar: boolean
        /** Who is signed in, and the devices holding a session for them. */
        viewer: { id: string; email: string; name: string | null }
        devices: Array<{
          id: string
          userAgent: string | null
          lastSeenAt: string
          /** True for the device making this request, so it cannot revoke itself by accident. */
          current: boolean
        }>
        /**
         * Senders the user has marked as ones a reply cannot reach, per mailbox.
         *
         * Listed here because the mark is set from a conversation and applies to
         * every thread from that sender afterwards — a place to see the whole
         * list is what makes it possible to take one back without hunting for
         * the thread that set it.
         */
        unreplyableSenders: Array<{ accountId: string; senderEmail: string }>
        /**
         * Senders this install has actually received from, newest first.
         *
         * The quick half of the list: picking one of these is a click, where the
         * free-text form needs the address recalled and typed. Only threads that
         * still show a reply box are considered, so the list can never offer a
         * sender that is already marked or already unanswerable on its own.
         */
        recentSenders: Array<{
          accountId: string
          email: string
          name: string | null
          lastMessageAt: string
        }>
      }
  > => {
    const session = await getSession()
    if (!session) return { signedIn: false }

    const accounts = await listAccounts(session.userId)
    const [viewer, devices] = await Promise.all([
      getUser(session.userId),
      listSessions(session.userId),
    ])

    // Read per mailbox rather than in one query: the same call the sync path
    // uses, so the list on screen cannot disagree with what a decision reads.
    const unreplyableSenders = (
      await Promise.all(
        accounts.map(async (account) =>
          [...(await listUnreplyableSenders(account.id))].map(
            (senderEmail) => ({ accountId: account.id, senderEmail }),
          ),
        ),
      )
    )
      .flat()
      .sort((a, b) => a.senderEmail.localeCompare(b.senderEmail))

    // Every connected address is the user's own, so a thread between two of their
    // mailboxes must not offer the other side as a sender to mark. Passed as a set
    // because "mine" has been a set since the second mailbox was connected.
    const ownerEmails = new Set(accounts.map((account) => account.id))

    const recentSenders = (
      await Promise.all(
        accounts.map(async (account) =>
          (await listIncomingSenders(account.id, ownerEmails)).map(
            (sender) => ({
              accountId: account.id,
              email: sender.email,
              name: sender.name,
              lastMessageAt: sender.lastMessageAt.toISOString(),
            }),
          ),
        ),
      )
    ).flat()

    if (!viewer) {
      // The session outlived the user row (deleted out of band). Treat it as
      // signed out rather than rendering half a page about a stranger.
      return { signedIn: false }
    }

    return {
      signedIn: true,
      settings: await getAiSettings(session.userId),
      organizationLabels: await listOrganizationLabels(session.userId),
      stateLabels: await listStateLabels(session.userId),
      contextRevisions: await listRecentContextRevisions(session.userId),
      accounts: await Promise.all(
        accounts.map(async (account) => {
          const profile = await getParsingProfileContext(account.id)
          return {
            id: account.id,
            email: account.email,
            provider: account.provider,
            parsingDefaults: profile.parsingDefaults,
            defaultReplyGreeting: profile.replyStyles.account.greeting ?? '',
            defaultReplySignature: profile.replyStyles.account.signature ?? '',
          }
        }),
      ),
      viewer: {
        id: viewer.id,
        email: viewer.email,
        name: viewer.name,
      },
      devices: devices.map((device) => ({
        id: device.id,
        userAgent: device.userAgent,
        lastSeenAt: device.lastSeenAt.toISOString(),
        current: device.id === session.sessionId,
      })),
      useGravatar: (await getPreferences(session.userId)).useGravatar,
      unreplyableSenders,
      recentSenders,
    }
  },
)

/**
 * Disconnect a mailbox and delete everything synced from it.
 *
 * The id arrives from the browser, so ownership is checked rather than trusted —
 * `forgetAccount` refuses a mailbox that is not this user's. Deleting the last
 * mailbox does *not* sign the user out any more: they still have an account,
 * their AI keys and their own list of senders, and re-authorising a mailbox they
 * happen to have removed must not cost them all of that.
 */
const forgetAccountAction = createServerFn({ method: 'POST' })
  // `validator`, not `inputValidator`: the latter is deprecated. The other
  // actions in this app still use the old name and should be renamed too.
  .validator((data: { accountId: string }) => data)
  .handler(async ({ data }): Promise<{ error: string | null }> => {
    const session = await getSession()
    if (!session) return { error: 'You are not signed in.' }

    try {
      await forgetAccount(session.userId, data.accountId.trim().toLowerCase())
      return { error: null }
    } catch (error) {
      console.error('[settings] deleting stored mail failed:', error)
      return {
        error:
          error instanceof Error
            ? error.message
            : 'Could not delete the stored mail.',
      }
    }
  })

/**
 * Turn avatars from Gravatar on or off.
 *
 * Off by default, and the only setting here that contacts a third party: the
 * request carries an MD5 of each address, which is why it is an explicit choice
 * rather than an opt-out nobody notices.
 */
const saveParsingDefaultsAction = createServerFn({ method: 'POST' })
  .inputValidator(
    (data: {
      accountId: string
      parsing: ParsingPreferences
      greeting: string
      signature: string
    }) => data,
  )
  .handler(async ({ data }): Promise<{ error: string | null }> => {
    const session = await getSession()
    if (!session) return { error: 'You are not signed in.' }
    if (
      typeof data.parsing.stripQuotedHistory !== 'boolean' ||
      typeof data.parsing.stripGreeting !== 'boolean' ||
      typeof data.parsing.stripSignature !== 'boolean' ||
      typeof data.greeting !== 'string' ||
      typeof data.signature !== 'string' ||
      data.greeting.length > 200 ||
      data.signature.length > 1000
    ) {
      return { error: 'Parsing settings are invalid or too long.' }
    }

    try {
      const accountId = data.accountId.trim().toLowerCase()
      await assertOwnedAccount(session.userId, accountId)
      await saveAccountParsingDefaults(accountId, {
        parsing: data.parsing,
        greeting: data.greeting.trim() || null,
        signature: data.signature.trim() || null,
      })
      const context = await getParsingProfileContext(accountId)
      await reparseStoredMessages(accountId, context)
      await redecideStoredConversations(accountId, session.userId)
      return { error: null }
    } catch (error) {
      console.error('[settings] saving parsing defaults failed:', error)
      return {
        error:
          error instanceof Error
            ? error.message
            : 'Could not save parsing settings.',
      }
    }
  })

const saveOrganizationLabelsAction = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => data)
  .handler(
    async ({
      data,
    }): Promise<{
      rules: OrganizationLabel[] | null
      error: string | null
    }> => {
      const session = await getSession()
      if (!session) return { rules: null, error: 'You are not signed in.' }

      try {
        const labels = await saveOrganizationLabels(session.userId, data)
        return labels
          ? { rules: labels, error: null }
          : {
              rules: null,
              error: 'Organization rules are invalid or exceed the limit.',
            }
      } catch (error) {
        console.error('[settings] saving organization rules failed:', error)
        return { rules: null, error: 'Could not save organization rules.' }
      }
    },
  )

const saveStateLabelsAction = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => data)
  .handler(
    async ({
      data,
    }): Promise<{ labels: StateLabels | null; error: string | null }> => {
      const session = await getSession()
      if (!session) return { labels: null, error: 'You are not signed in.' }

      try {
        const labels = await saveStateLabels(session.userId, data)
        return labels
          ? { labels, error: null }
          : { labels: null, error: 'Those labels are invalid or too long.' }
      } catch (error) {
        console.error('[settings] saving state labels failed:', error)
        return { labels: null, error: 'Could not save the labels.' }
      }
    },
  )

/**
 * Draft a new meaning for the label the user corrects most.
 *
 * Returns the proposal rather than saving it: a meaning rewritten by a model
 * that also classifies against it would drift and then confirm itself, so it is
 * shown as a diff and only stored when the user says so.
 */
const proposeStateMeaningAction = createServerFn({ method: 'POST' }).handler(
  async (): Promise<{
    proposal: StateMeaningProposal | null
    reason: string | null
    error: string | null
  }> => {
    const session = await getSession()
    if (!session) {
      return { proposal: null, reason: null, error: 'You are not signed in.' }
    }

    try {
      return await proposeStateMeaning(session.userId)
    } catch (error) {
      console.error('[settings] drafting a label meaning failed:', error)
      return {
        proposal: null,
        reason: null,
        error: 'Could not draft a meaning. Please try again.',
      }
    }
  },
)

const saveGravatarAction = createServerFn({ method: 'POST' })
  .validator((data: { useGravatar: boolean }) => data)
  .handler(async ({ data }): Promise<{ error: string | null }> => {
    const session = await getSession()
    if (!session) return { error: 'You are not signed in.' }

    try {
      await savePreferences(session.userId, {
        useGravatar: Boolean(data.useGravatar),
      })
      return { error: null }
    } catch (error) {
      console.error('[settings] saving the avatar preference failed:', error)
      return { error: 'Could not save that setting.' }
    }
  })

/** Sign out on this device: one session row deleted, the others left alone. */
const signOutAction = createServerFn({ method: 'POST' }).handler(
  async (): Promise<{ error: string | null }> => {
    try {
      await destroySession()
      return { error: null }
    } catch (error) {
      console.error('[settings] sign out failed:', error)
      return { error: 'Could not sign out.' }
    }
  },
)

/**
 * Sign out every *other* device.
 *
 * The current session is kept, which is what makes this safe to click: the user
 * stays where they are and the devices they no longer have are the ones that
 * lose access. Revoking all of them, including this one, would sign the user out
 * of the page they are looking at — that is the plain Sign out button.
 */
const signOutEverywhereAction = createServerFn({ method: 'POST' }).handler(
  async (): Promise<{ error: string | null; revoked: number }> => {
    const session = await getSession()
    if (!session) return { error: 'You are not signed in.', revoked: 0 }

    try {
      const others = (await listSessions(session.userId)).filter(
        (device) => device.id !== session.sessionId,
      )
      await revokeAllSessions(session.userId, session.sessionId)
      return { error: null, revoked: others.length }
    } catch (error) {
      console.error('[settings] revoking other sessions failed:', error)
      return { error: 'Could not sign the other devices out.', revoked: 0 }
    }
  },
)

/**
 * Take a sender off the can't-reply list, from the settings page.
 *
 * Session only, then delegate — the checks (connected mailbox, and the address
 * actually being on the stored list rather than the rendered one) live in
 * `removeUnreplyableSender` beside the add path, so both directions are tested
 * through the same harness.
 */
const clearSenderReplyabilityAction = createServerFn({ method: 'POST' })
  .validator((data: { accountId: string; senderEmail: string }) => data)
  .handler(async ({ data }): Promise<{ error: string | null }> => {
    const session = await getSession()
    if (!session) return { error: 'You are not signed in.' }

    try {
      return await removeUnreplyableSender(
        session.userId,
        data.accountId,
        data.senderEmail,
      )
    } catch (error) {
      console.error('[replyable] lifting the mark failed:', error)
      return { error: 'Could not update that sender.' }
    }
  })

/**
 * Add a sender to the can't-reply list.
 *
 * Session only, then delegate: every check that matters about the mailbox and the
 * address lives in `addUnreplyableSender`, where the test harness can reach it
 * without a router. An address with no mail yet is accepted on purpose — that is
 * what managing the list from Settings rather than from a thread buys.
 */
const markSenderReplyabilityAction = createServerFn({ method: 'POST' })
  .validator((data: { accountId: string; senderEmail: string }) => data)
  .handler(
    async ({
      data,
    }): Promise<{ error: string | null; added: string | null }> => {
      const session = await getSession()
      if (!session) {
        return { error: 'You are not signed in.', added: null }
      }

      try {
        return await addUnreplyableSender(
          session.userId,
          data.accountId,
          data.senderEmail,
        )
      } catch (error) {
        console.error('[replyable] adding a sender failed:', error)
        return { error: 'Could not add that sender.', added: null }
      }
    },
  )

type SaveInput = {
  jevModel: string | null
  llmProvider: string
  llmModel: string | null
  /** Importance at or above which a reply draft is offered, 1–10. */
  suggestReplyMinImportance: number
  /** Whether a sent reply is checked against the thread's goal. */
  goalCheckEnabled: boolean
  /** Whether the app refreshes goals and contact profiles from the mail. */
  autoContextEnabled: boolean
  /** `null` means "leave the stored key unchanged". */
  jevApiKey: string | null
  clearJevKey: boolean
  llmApiKey: string | null
  clearLlmKey: boolean
}

function validateSave(data: SaveInput): string | null {
  if (!PROVIDER_VALUES.has(data.llmProvider as '' | LlmProvider)) {
    return 'That LLM provider is not supported.'
  }

  const threshold = data.suggestReplyMinImportance
  if (
    typeof threshold !== 'number' ||
    !Number.isInteger(threshold) ||
    threshold < REPLY_DRAFT_MIN_IMPORTANCE_MIN ||
    threshold > REPLY_DRAFT_MIN_IMPORTANCE_MAX
  ) {
    return `Importance must be a whole number between ${REPLY_DRAFT_MIN_IMPORTANCE_MIN} and ${REPLY_DRAFT_MIN_IMPORTANCE_MAX}.`
  }

  if (typeof data.goalCheckEnabled !== 'boolean') {
    return 'The goal check setting has to be on or off.'
  }

  if (typeof data.autoContextEnabled !== 'boolean') {
    return 'The automatic context setting has to be on or off.'
  }

  const fields: Array<[string, string | null, number]> = [
    ['Jev model', data.jevModel, 100],
    ['LLM model', data.llmModel, 100],
    ['Jev API key', data.jevApiKey, 500],
    ['LLM API key', data.llmApiKey, 500],
  ]
  for (const [label, value, limit] of fields) {
    if (value !== null && typeof value !== 'string') {
      return `${label} must be text.`
    }
    if (typeof value === 'string' && value.length > limit) {
      return `${label} must be ${limit} characters or fewer.`
    }
  }
  return null
}

/** `null`/blank means "not provided"; the caller decides what that means. */
function blankToNull(value: string | null): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed || null
}

const saveAiSettingsAction = createServerFn({ method: 'POST' })
  .inputValidator((data: SaveInput) => data)
  .handler(async ({ data }): Promise<{ error: string | null }> => {
    const session = await getSession()
    if (!session) return { error: 'You are not signed in.' }

    const invalid = validateSave(data)
    if (invalid) return { error: invalid }

    try {
      await saveAiSettings(session.userId, {
        jevModel: blankToNull(data.jevModel),
        llmProvider: data.llmProvider
          ? (data.llmProvider as LlmProvider)
          : null,
        llmModel: blankToNull(data.llmModel),
        suggestReplyMinImportance: data.suggestReplyMinImportance,
        goalCheckEnabled: data.goalCheckEnabled,
        autoContextEnabled: data.autoContextEnabled,
        // `undefined` keeps the stored key; `''` clears it; a value replaces it.
        jevApiKey: data.clearJevKey
          ? ''
          : (blankToNull(data.jevApiKey) ?? undefined),
        llmApiKey: data.clearLlmKey
          ? ''
          : (blankToNull(data.llmApiKey) ?? undefined),
      })
      return { error: null }
    } catch (error) {
      console.error('[settings] save failed:', error)
      return { error: 'Could not save the AI settings.' }
    }
  })

/**
 * Put a context value back.
 *
 * The browser sends the revision id and nothing else: the server reads what was
 * replaced from the log and writes that, so a client cannot name a value to
 * restore. Undo is a write like any other and records a revision of its own,
 * which is what makes undoing twice ordinary rather than a special case.
 */
const undoContextRevisionAction = createServerFn({ method: 'POST' })
  .inputValidator((data: { revisionId: string }) => data)
  .handler(async ({ data }): Promise<{ error: string | null }> => {
    const session = await getSession()
    if (!session) return { error: 'You are not signed in.' }

    if (typeof data.revisionId !== 'string' || !data.revisionId) {
      return { error: 'That change could not be found.' }
    }

    try {
      const undone = await undoContextRevision(session.userId, data.revisionId)
      return undone
        ? { error: null }
        : { error: 'That change is already undone.' }
    } catch (error) {
      console.error('[settings] undo failed:', error)
      return { error: 'Could not undo that change.' }
    }
  })

export const Route = createFileRoute('/settings')({
  loader: async () => {
    const result = await fetchAiSettings()
    // Signed out is a redirect, like the inbox: there is no per-install settings
    // page to show any more, only a person's own.
    if (!result.signedIn) throw redirect({ to: '/sign-in' })
    return result
  },
  component: Settings,
})

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="block text-xs text-muted-foreground">
      {label}
      {children}
      {hint ? <span className="mt-1 block text-[11px]">{hint}</span> : null}
    </label>
  )
}

/** The signed-in half of what this page's loader can return. */
type SignedInSettings = Extract<
  Awaited<ReturnType<typeof fetchAiSettings>>,
  { signedIn: true }
>

/**
 * The words the four built-in labels read as.
 *
 * The labels themselves are fixed — every decision and stored row speaks in
 * those four values — but their names and meanings are the user's. The inbox
 * shows both: the name in the heading and badge, the meaning under the heading,
 * so a section explains why a thread is in it instead of only naming it.
 */
function StateLabelsEditor({ initialLabels }: { initialLabels: StateLabels }) {
  const router = useRouter()
  const [labels, setLabels] = useState(initialLabels)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  // The draft and the reason there is none are separate: "not enough corrections
  // yet" is an answer, not a failure, and must not look like one.
  const [proposing, setProposing] = useState(false)
  const [proposal, setProposal] = useState<StateMeaningProposal | null>(null)
  const [proposalReason, setProposalReason] = useState<string | null>(null)

  async function propose() {
    if (busy || proposing) return
    setProposing(true)
    setError(null)
    setMessage(null)
    setProposalReason(null)
    try {
      const result = await proposeStateMeaningAction()
      if (result.error) {
        setError(result.error)
        return
      }
      setProposal(result.proposal)
      setProposalReason(result.reason)
    } catch {
      setError('Could not draft a meaning. Please try again.')
    } finally {
      setProposing(false)
    }
  }

  /**
   * Approve the draft: put it in the form and save at once.
   *
   * Saving immediately rather than leaving it in the textarea is the point of the
   * diff — an approved meaning that is only in unsaved form is one a page refresh
   * throws away.
   */
  async function applyProposal() {
    if (!proposal) return
    const next: StateLabels = {
      ...labels,
      [proposal.state]: {
        ...labels[proposal.state],
        description: proposal.proposed,
      },
    }
    setLabels(next)
    setProposal(null)
    await save(next)
  }

  function update(
    state: keyof StateLabels,
    patch: Partial<StateLabels[keyof StateLabels]>,
  ) {
    setLabels((current) => ({
      ...current,
      [state]: { ...current[state], ...patch },
    }))
    setMessage(null)
  }

  /**
   * Save the given labels, defaulting to what is in the form.
   *
   * The parameter has one caller: approving a proposed meaning has to write the
   * meaning it approved, not whatever React has committed to state by the time
   * the save resolves.
   */
  async function save(next: StateLabels = labels) {
    if (busy) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const result = await saveStateLabelsAction({
        data: CONVERSATION_STATES.map((state) => ({
          state,
          ...next[state],
        })),
      })
      if (result.error || !result.labels) {
        setError(result.error ?? 'Could not save the labels.')
        return
      }
      setLabels(result.labels)
      setMessage('Labels saved.')
      await router.invalidate()
    } catch {
      setError('Could not save the labels.')
    } finally {
      setBusy(false)
    }
  }

  const defaults = defaultStateLabels()
  const inputClass =
    'min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground'

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-semibold text-foreground">Label meanings</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Every thread is filed under one of these four labels. Rename one, or
        rewrite what it means and is for — the inbox headings, the meaning under
        each heading and the badge on a thread all use your words. This changes
        the wording only, never how mail is filed.
      </p>

      <ol className="mt-3 space-y-2">
        {STATE_ORDER.map((state) => (
          <li key={state} className="rounded-md border border-border p-3">
            <div className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={`size-2 shrink-0 rounded-full ${STATE_META[state].dotClass}`}
              />
              <input
                aria-label={`${defaults[state].name} label name`}
                value={labels[state].name}
                maxLength={STATE_LABEL_LIMITS.name}
                disabled={busy}
                onChange={(event) =>
                  update(state, { name: event.target.value })
                }
                placeholder={defaults[state].name}
                className={`${inputClass} flex-1`}
              />
            </div>
            <label className="mt-2 block text-[11px] text-muted-foreground">
              Meaning / purpose
              <textarea
                aria-label={`${defaults[state].name} label meaning`}
                value={labels[state].description}
                maxLength={STATE_LABEL_LIMITS.description}
                rows={2}
                disabled={busy}
                onChange={(event) =>
                  update(state, { description: event.target.value })
                }
                placeholder={defaults[state].description}
                className={`${inputClass} mt-1 block w-full resize-y`}
              />
            </label>
          </li>
        ))}
      </ol>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void save()}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save labels'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setLabels(defaultStateLabels())
            setMessage('Default wording restored. Save to apply it.')
          }}
          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground disabled:opacity-50"
        >
          Use default wording
        </button>
      </div>

      <div className="mt-3 rounded-md border border-border bg-muted/20 p-3">
        <p className="text-[11px] font-medium text-foreground">
          Rewrite a meaning from your corrections
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Moving a thread out of a label is the app getting it wrong. After{' '}
          {STATE_MEANING_MIN_CORRECTIONS} of those on the same label, it can
          draft what that label means to you — shown as a diff you approve,
          never applied on its own. It proposes the meaning only, never the
          name.
        </p>
        <button
          type="button"
          disabled={busy || proposing}
          onClick={() => void propose()}
          className="mt-2 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground disabled:opacity-50"
        >
          {proposing ? 'Drafting…' : 'Draft from my corrections'}
        </button>

        {proposal ? (
          <div className="mt-2 space-y-1 text-[11px]">
            <p className="font-medium text-foreground">{proposal.name}</p>
            <p className="text-muted-foreground line-through">
              {proposal.current || '(no meaning yet)'}
            </p>
            <p className="text-foreground">{proposal.proposed}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void applyProposal()}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                Use this meaning
              </button>
              <button
                type="button"
                onClick={() => setProposal(null)}
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground"
              >
                Dismiss
              </button>
              <span className="text-muted-foreground">
                Drawn from {proposal.corrections} corrections.
              </span>
            </div>
          </div>
        ) : null}

        {proposalReason ? (
          <p className="mt-2 text-[11px] text-muted-foreground">
            {proposalReason}
          </p>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {message ? (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {message}
        </p>
      ) : null}
    </section>
  )
}

function OrganizationRulesEditor({
  initialLabels,
  stateLabels,
}: {
  initialLabels: OrganizationLabel[]
  stateLabels: StateLabels
}) {
  const router = useRouter()
  const [rules, setRules] = useState(initialLabels)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  function updateRule(id: string, patch: Partial<OrganizationLabel>) {
    setRules((current) =>
      current.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)),
    )
    setMessage(null)
  }

  /**
   * The conditions on one label.
   *
   * They are alternatives, not a conjunction: the inbox files a thread as soon
   * as any one of them matches, so a label can be "this sender *or* this subject"
   * without being duplicated.
   */
  function updateMatch(
    labelId: string,
    matchId: string,
    patch: Partial<OrganizationMatchRule>,
  ) {
    setRules((current) =>
      current.map((label) =>
        label.id === labelId
          ? {
              ...label,
              rules: label.rules.map((match) =>
                match.id === matchId ? { ...match, ...patch } : match,
              ),
            }
          : label,
      ),
    )
    setMessage(null)
  }

  function addMatch(labelId: string) {
    setRules((current) =>
      current.map((label) =>
        label.id === labelId
          ? {
              ...label,
              rules: [
                ...label.rules,
                {
                  id: crypto.randomUUID(),
                  field: 'sender-domain',
                  value: '',
                } satisfies OrganizationMatchRule,
              ],
            }
          : label,
      ),
    )
    setMessage(null)
  }

  function removeMatch(labelId: string, matchId: string) {
    setRules((current) =>
      current.map((label) =>
        label.id === labelId
          ? { ...label, rules: label.rules.filter((m) => m.id !== matchId) }
          : label,
      ),
    )
    setMessage(null)
  }

  function moveRule(index: number, offset: -1 | 1) {
    const nextIndex = index + offset
    if (nextIndex < 0 || nextIndex >= rules.length) return
    setRules((current) => {
      const reordered = [...current]
      ;[reordered[index], reordered[nextIndex]] = [
        reordered[nextIndex],
        reordered[index],
      ]
      return reordered
    })
    setMessage(null)
  }

  async function save() {
    if (busy) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const result = await saveOrganizationLabelsAction({ data: rules })
      if (result.error || !result.rules) {
        setError(result.error ?? 'Could not save custom labels.')
        return
      }
      setRules(result.rules)
      setMessage('Custom labels saved.')
      await router.invalidate()
    } catch {
      setError('Could not save custom labels.')
    } finally {
      setBusy(false)
    }
  }

  const fieldLabels: Record<(typeof ORGANIZATION_RULE_FIELDS)[number], string> =
    {
      'sender-email': 'Sender email is',
      'sender-domain': 'Sender domain is',
      'subject-contains': 'Subject contains',
      'topic-contains': 'Topic contains',
      'state-is': 'Label is',
    }
  const inputClass =
    'min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground'

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-semibold text-foreground">Custom labels</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Add labels of your own, and the conditions that file matching
        conversations into each one. A label may have any number of them and any
        one is enough — so a section can be "this sender <em>or</em> this
        subject" without being duplicated. Labels run from top to bottom and the
        first enabled match wins. A label with no conditions is placed by the
        decision model instead, from the meaning you write for it; the same
        meaning is what the inbox shows under the heading. In the inbox, drag a
        label by its handle to put it anywhere between the four AI groups — or
        collapse it to keep the page short. A thread can also be moved to a
        different label (or back to the rules) from its right-click menu.
        Unlabelled threads stay in their four groups, and Done threads stay in
        Done. Labels only change where a thread is listed, never its state or AI
        classification.
      </p>
      {rules.length > 0 ? (
        <ol className="mt-3 space-y-2">
          {rules.map((rule, index) => (
            <li key={rule.id} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-medium text-muted-foreground">
                  {index + 1}.
                </span>
                <input
                  aria-label={`Rule ${index + 1} label name`}
                  value={rule.name}
                  maxLength={ORGANIZATION_RULE_LIMITS.name}
                  disabled={busy}
                  onChange={(event) =>
                    updateRule(rule.id, { name: event.target.value })
                  }
                  placeholder="Label name, e.g. Finance"
                  className={`${inputClass} flex-1`}
                />
                <button
                  type="button"
                  aria-label={`Move rule ${index + 1} up`}
                  disabled={busy || index === 0}
                  onClick={() => moveRule(index, -1)}
                  className="rounded border border-border px-2 py-1 text-xs disabled:opacity-40"
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`Move rule ${index + 1} down`}
                  disabled={busy || index === rules.length - 1}
                  onClick={() => moveRule(index, 1)}
                  className="rounded border border-border px-2 py-1 text-xs disabled:opacity-40"
                >
                  ↓
                </button>
                <label className="flex items-center gap-1 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    disabled={busy}
                    onChange={(event) =>
                      updateRule(rule.id, { enabled: event.target.checked })
                    }
                  />
                  Enabled
                </label>
                <button
                  type="button"
                  aria-label={`Delete rule ${index + 1}`}
                  disabled={busy}
                  onClick={() =>
                    setRules((current) =>
                      current.filter((entry) => entry.id !== rule.id),
                    )
                  }
                  className="rounded border border-destructive/40 px-2 py-1 text-xs text-destructive disabled:opacity-50"
                >
                  Delete
                </button>
              </div>
              <label className="mt-2 block text-[11px] text-muted-foreground">
                Meaning / purpose
                <textarea
                  aria-label={`Rule ${index + 1} label meaning`}
                  value={rule.description}
                  maxLength={ORGANIZATION_RULE_LIMITS.description}
                  rows={2}
                  disabled={busy}
                  onChange={(event) =>
                    updateRule(rule.id, { description: event.target.value })
                  }
                  placeholder="What belongs in this label, and why"
                  className={`${inputClass} mt-1 block w-full resize-y`}
                />
              </label>
              <div className="mt-2 rounded-md border border-border/60 p-2">
                <p className="text-[11px] font-medium text-muted-foreground">
                  Chosen by
                </p>
                {rule.rules.length === 0 ? (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Its meaning. With no condition, the decision model reads the
                    meaning above and files a thread here when the mail fits it.
                  </p>
                ) : (
                  <ul className="mt-1 space-y-2">
                    {rule.rules.map((match, matchIndex) => (
                      <li
                        key={match.id}
                        className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
                      >
                        <label className="text-[11px] text-muted-foreground">
                          When
                          <select
                            aria-label={`Label ${index + 1} condition ${matchIndex + 1} field`}
                            value={match.field}
                            disabled={busy}
                            onChange={(event) =>
                              updateMatch(rule.id, match.id, {
                                field: event.target
                                  .value as OrganizationRuleField,
                                value:
                                  event.target.value === 'state-is'
                                    ? 'needs-action'
                                    : '',
                              })
                            }
                            className={`${inputClass} mt-1 block w-full`}
                          >
                            {ORGANIZATION_RULE_FIELDS.map((field) => (
                              <option key={field} value={field}>
                                {fieldLabels[field]}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="text-[11px] text-muted-foreground">
                          {match.field === 'state-is' ? 'State' : 'Value'}
                          {match.field === 'state-is' ? (
                            <select
                              aria-label={`Label ${index + 1} condition ${matchIndex + 1} value`}
                              value={match.value}
                              disabled={busy}
                              onChange={(event) =>
                                updateMatch(rule.id, match.id, {
                                  value: event.target.value,
                                })
                              }
                              className={`${inputClass} mt-1 block w-full`}
                            >
                              {STATE_ORDER.map((state) => (
                                <option key={state} value={state}>
                                  {stateLabels[state].name}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input
                              aria-label={`Label ${index + 1} condition ${matchIndex + 1} value`}
                              value={match.value}
                              maxLength={ORGANIZATION_RULE_LIMITS.value}
                              disabled={busy}
                              onChange={(event) =>
                                updateMatch(rule.id, match.id, {
                                  value: event.target.value,
                                })
                              }
                              placeholder={
                                match.field === 'sender-domain'
                                  ? 'example.com'
                                  : match.field === 'sender-email'
                                    ? 'billing@example.com'
                                    : 'Text to match'
                              }
                              className={`${inputClass} mt-1 block w-full`}
                            />
                          )}
                        </label>
                        <button
                          type="button"
                          aria-label={`Remove condition ${matchIndex + 1}`}
                          disabled={busy}
                          onClick={() => removeMatch(rule.id, match.id)}
                          className="self-end rounded border border-border px-2 py-1 text-xs disabled:opacity-40"
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <button
                  type="button"
                  disabled={
                    busy || rule.rules.length >= ORGANIZATION_RULE_LIMITS.rules
                  }
                  onClick={() => addMatch(rule.id)}
                  className="mt-2 rounded border border-border px-2 py-1 text-xs font-medium text-foreground disabled:opacity-40"
                >
                  + Add condition
                </button>
                <span className="ml-2 text-[11px] text-muted-foreground">
                  Any one matching is enough.
                </span>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          No custom labels yet. Add one to file matching conversations somewhere
          of their own.
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || rules.length >= ORGANIZATION_RULE_LIMITS.count}
          onClick={() =>
            setRules((current) => [
              ...current,
              {
                id: crypto.randomUUID(),
                name: '',
                description: '',
                enabled: true,
                rules: [],
              },
            ])
          }
          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground disabled:opacity-50"
        >
          Add label
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void save()}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save custom labels'}
        </button>
        <span className="text-[11px] text-muted-foreground">
          {rules.length}/{ORGANIZATION_RULE_LIMITS.count} labels
        </span>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {message ? (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {message}
        </p>
      ) : null}
    </section>
  )
}

/**
 * Settings, one component.
 *
 * There used to be a signed-out branch here, split out so flipping the loader's
 * state did not change a hook list. The loader redirects a signed-out visitor
 * now, so the only variable left is how many mailboxes the user has — and a user
 * with none still has an account, keys to set, and devices to sign out.
 */
/**
 * The field a revision names, in words a reader of this page would use.
 *
 * The log stores column names, because that is what the undo has to write back;
 * `roleCompany` is not something to show a person.
 */
function contextRevisionLabel(field: string): string {
  switch (field) {
    case 'goal':
      return 'Goal'
    case 'topic':
      return 'Topic'
    case 'state':
      return 'State'
    case 'roleCompany':
      return 'Role'
    case 'relationship':
      return 'Relationship'
    case 'currentWork':
      return 'Current work'
    default:
      return 'Topics'
  }
}

/**
 * The settings navigation, in the groups `design.pen` v3 draws.
 *
 * The design's sidebar is a settings screen's own: back to the inbox, the
 * sections grouped by what they are about, and the profile at the bottom. The
 * items are the page's real sections rather than the design's placeholders — a
 * row that scrolls nowhere would be a worse lie than a missing one.
 */
const SETTINGS_GROUPS: ReadonlyArray<{
  label: string
  items: ReadonlyArray<{
    id: string
    label: string
    icon: typeof User
    description: string
  }>
}> = [
  {
    label: 'Account',
    items: [
      {
        id: 'account',
        label: 'Account',
        icon: User,
        description:
          'Who is signed in, the devices holding a session, and how avatars load.',
      },
      {
        id: 'mailboxes',
        label: 'Mailboxes',
        icon: Mail,
        description:
          'The addresses Nuntia syncs, and what deleting one removes.',
      },
    ],
  },
  {
    label: 'Inbox',
    items: [
      {
        id: 'parsing',
        label: 'Parsing & replies',
        icon: SlidersHorizontal,
        description:
          'How each mailbox strips quoted history, greetings and signatures, and the reply style that starts a draft.',
      },
      {
        id: 'state-labels',
        label: 'State labels',
        icon: Tag,
        description:
          'What the four built-in labels are called, and the meaning the inbox shows under them.',
      },
      {
        id: 'custom-labels',
        label: 'Sections & rules',
        icon: FolderTree,
        description:
          'Your own labels, and the conditions that file mail into them.',
      },
      {
        id: 'senders',
        label: "Can't reply to",
        icon: Ban,
        description:
          'Addresses that should never get a reply box, per mailbox.',
      },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      {
        id: 'ai',
        label: 'AI services',
        icon: Sparkles,
        description:
          'The keys and models behind classification and topics. Both are optional.',
      },
      {
        id: 'replies',
        label: 'Suggested replies',
        icon: MessageSquare,
        description:
          'When a reply is drafted for you, and whether a sent reply is checked against the goal.',
      },
    ],
  },
]

const SETTINGS_ITEMS = SETTINGS_GROUPS.flatMap((group) => group.items)

/** The nav column itself: the design's groups, one panel per row. */
function SettingsNav({
  active,
  onSelect,
}: {
  active: string
  onSelect: (id: string) => void
}) {
  return (
    <nav aria-label="Settings sections" className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Link
          to="/"
          aria-label="Back to inbox"
          className="flex size-[30px] items-center justify-center rounded-[4px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
        </Link>
        <span className="font-display text-xl font-semibold tracking-tight text-foreground">
          Settings
        </span>
      </div>

      {SETTINGS_GROUPS.map((group) => (
        <div key={group.label} className="flex flex-col gap-0.5">
          <p className="px-2.5 pt-1 pb-1 text-[10px] font-semibold tracking-[0.12em] text-muted-foreground/70 uppercase">
            {group.label}
          </p>
          {group.items.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelect(item.id)}
                aria-current={active === item.id ? 'page' : undefined}
                className={`flex h-[34px] items-center gap-2.5 rounded-[4px] px-2.5 text-left text-[12.5px] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${
                  active === item.id
                    ? 'bg-muted/70 font-semibold text-foreground'
                    : 'font-medium text-foreground/90 hover:bg-muted/40'
                }`}
              >
                <Icon aria-hidden="true" className="size-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </button>
            )
          })}
        </div>
      ))}
    </nav>
  )
}

function Settings() {
  return <SettingsForm result={Route.useLoaderData()} />
}

function SettingsForm({ result }: { result: SignedInSettings }) {
  const router = useRouter()
  const [activePanel, setActivePanel] = useState(
    SETTINGS_ITEMS[0]?.id ?? 'account',
  )
  const panel = SETTINGS_ITEMS.find((item) => item.id === activePanel)

  /**
   * Switching panels is a change of screen, not a jump down one page: the new
   * panel opens at the top instead of wherever the previous one was left.
   */
  const selectPanel = (id: string) => {
    setActivePanel(id)
    window.scrollTo({ top: 0 })
  }

  const {
    settings,
    organizationLabels: initialOrganizationLabels,
    stateLabels: initialStateLabels,
    contextRevisions,
    accounts,
    unreplyableSenders,
    recentSenders,
    viewer,
    devices,
    useGravatar,
  } = result

  // Own state so the checkbox responds before the save comes back; the server
  // value arrives on the next loader run and would otherwise be the only truth.
  const [gravatar, setGravatar] = useState(useGravatar)

  const [jevModel, setJevModel] = useState(settings.jevModel ?? '')
  const [jevApiKey, setJevApiKey] = useState('')
  const [clearJevKey, setClearJevKey] = useState(false)

  const [llmProvider, setLlmProvider] = useState<'' | LlmProvider>(
    settings.llmProvider ?? '',
  )
  const [llmModel, setLlmModel] = useState(settings.llmModel ?? '')
  const [llmApiKey, setLlmApiKey] = useState('')
  const [clearLlmKey, setClearLlmKey] = useState(false)
  // Held as text so the field can be emptied while typing; parsed on save, and
  // the server refuses anything that is not a whole 1–10.
  const [minImportance, setMinImportance] = useState(
    String(settings.suggestReplyMinImportance),
  )
  const [goalCheckEnabled, setGoalCheckEnabled] = useState(
    settings.goalCheckEnabled,
  )
  const [autoContextEnabled, setAutoContextEnabled] = useState(
    settings.autoContextEnabled,
  )

  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Kept separate from the form's own feedback: the mailbox list sits outside the
  // form, and one shared message would report in the wrong place.
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [mailboxError, setMailboxError] = useState<string | null>(null)
  const [mailboxMessage, setMailboxMessage] = useState<string | null>(null)

  // Its own feedback again: this list also sits outside the form, and a message
  // about a sender reported above the AI settings would read as being about them.
  const [senderError, setSenderError] = useState<string | null>(null)
  const [senderMessage, setSenderMessage] = useState<string | null>(null)

  // And again for the account section, for the same reason.
  const [accountError, setAccountError] = useState<string | null>(null)
  const [accountMessage, setAccountMessage] = useState<string | null>(null)

  // The can't-reply form's own two fields. The mailbox is picked rather than
  // implied by a thread — there is no open thread on this page — and defaults to
  // the first one, because most installs have exactly one.
  const [senderAccount, setSenderAccount] = useState(accounts[0]?.id ?? '')
  const [senderInput, setSenderInput] = useState('')
  const [parsingDrafts, setParsingDrafts] = useState(() =>
    Object.fromEntries(
      accounts.map((account) => [
        account.id,
        {
          ...account.parsingDefaults,
          greeting: account.defaultReplyGreeting,
          signature: account.defaultReplySignature,
        },
      ]),
    ),
  )
  const [parsingBusy, setParsingBusy] = useState<string | null>(null)
  const [parsingError, setParsingError] = useState<string | null>(null)
  const [parsingMessage, setParsingMessage] = useState<string | null>(null)

  // Only the selected mailbox's senders. The list is per mailbox, and mixing two
  // mailboxes' addresses under one picker is how the wrong one gets marked.
  const suggestions = recentSenders.filter(
    (sender) => sender.accountId === senderAccount,
  )

  /**
   * Delete a mailbox's stored copy, on the second click.
   *
   * Two clicks rather than a browser dialog: the app uses no dialogs, and this
   * makes the destructive step explicit without one. The mail stays in Gmail, so
   * the wording on the button says exactly what goes.
   */
  async function removeMailbox(accountId: string) {
    if (busy) return

    if (pendingDelete !== accountId) {
      setPendingDelete(accountId)
      setMailboxError(null)
      setMailboxMessage(null)
      return
    }

    setBusy(true)
    setMailboxError(null)
    setMailboxMessage(null)

    try {
      // Named for the outcome, not `result`: the loader's `result` is in scope
      // here, and shadowing it is what the linter warns about.
      const forgotten = await forgetAccountAction({ data: { accountId } })

      if (forgotten.error) {
        setMailboxError(forgotten.error)
        return
      }

      setPendingDelete(null)
      setMailboxMessage('Deleted. Connect it again to sync it fresh.')
      // Both the mailbox list and the signed-in state come from the loader.
      await router.invalidate()
    } catch {
      setMailboxError('Could not delete the stored mail.')
    } finally {
      setBusy(false)
    }
  }

  /**
   * Add an address to a mailbox's can't-reply list.
   *
   * Shared by both ways in. The free-text form supplies the mailbox and the
   * address explicitly — the list is per mailbox, and the same company writing to
   * two of them is two entries — and the one-click list of senders the mailbox has
   * actually received from supplies both from the row that was clicked.
   *
   * The confirmation names the address as *stored* (normalised) rather than as
   * given, so it reports the entry the list ended up holding.
   */
  async function addSenderAddress(accountId: string, senderEmail: string) {
    if (busy) return

    setBusy(true)
    setSenderError(null)
    setSenderMessage(null)

    try {
      const added = await markSenderReplyabilityAction({
        data: { accountId, senderEmail },
      })

      if (added.error || !added.added) {
        setSenderError(added.error ?? 'Could not add that sender.')
        return
      }

      setSenderMessage(`${added.added} will not get a reply box.`)
      setSenderInput('')
      await router.invalidate()
    } catch {
      setSenderError('Could not add that sender.')
    } finally {
      setBusy(false)
    }
  }

  async function addSender(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await addSenderAddress(senderAccount, senderInput)
  }

  /**
   * Sign out of this device, or of every other one.
   *
   * The plain sign-out is a full navigation rather than a router navigate: the
   * session cookie is gone, and every loader on every route would have to be
   * re-run anyway.
   */
  async function signOut(everywhereElse: boolean) {
    if (busy) return
    setBusy(true)
    setAccountError(null)
    setAccountMessage(null)

    try {
      if (everywhereElse) {
        const revoked = await signOutEverywhereAction()
        if (revoked.error) {
          setAccountError(revoked.error)
          return
        }
        setAccountMessage(
          revoked.revoked === 0
            ? 'No other devices were signed in.'
            : `Signed out ${revoked.revoked} other ${
                revoked.revoked === 1 ? 'device' : 'devices'
              }.`,
        )
        await router.invalidate()
        return
      }

      const result = await signOutAction()
      if (result.error) {
        setAccountError(result.error)
        return
      }

      window.location.assign('/sign-in')
    } catch {
      setAccountError('Could not sign out.')
    } finally {
      setBusy(false)
    }
  }

  /**
   * Take a sender off the can't-reply list.
   *
   * The counterpart of the button on a conversation, for the case where the user
   * wants the reply box back but has no thread from that sender to hand — the
   * mark covers every future one, so undoing it has to be reachable from here.
   */
  async function allowReplies(accountId: string, senderEmail: string) {
    if (busy) return
    setBusy(true)
    setSenderError(null)
    setSenderMessage(null)

    try {
      // Not `result`: the loader's own `result` is in scope in this component,
      // and shadowing it is how the two get confused.
      const cleared = await clearSenderReplyabilityAction({
        data: { accountId, senderEmail },
      })

      if (cleared.error) {
        setSenderError(cleared.error)
        return
      }

      setSenderMessage(`A reply can reach ${senderEmail} again.`)
      await router.invalidate()
    } catch {
      setSenderError('Could not update that sender.')
    } finally {
      setBusy(false)
    }
  }

  /**
   * Save the avatar preference as it is toggled.
   *
   * Optimistic, and rolled back when the save fails — a checkbox that only moves
   * after a round trip feels broken, and one that stays moved after a failure is
   * worse.
   */
  async function toggleGravatar(next: boolean) {
    setGravatar(next)
    setAccountError(null)
    setAccountMessage(null)

    try {
      const saved = await saveGravatarAction({ data: { useGravatar: next } })
      if (saved.error) {
        setAccountError(saved.error)
        setGravatar(!next)
        return
      }

      setAccountMessage(
        next
          ? 'Avatars load from Gravatar when an address has one.'
          : 'Avatars now use initials only.',
      )
    } catch {
      setAccountError('Could not save that setting.')
      setGravatar(!next)
    }
  }

  async function saveMailboxParsing(accountId: string) {
    if (busy || parsingBusy) return
    const draft = parsingDrafts[accountId]

    setParsingBusy(accountId)
    setParsingError(null)
    setParsingMessage(null)
    try {
      const saved = await saveParsingDefaultsAction({
        data: {
          accountId,
          parsing: {
            stripQuotedHistory: draft.stripQuotedHistory,
            stripGreeting: draft.stripGreeting,
            stripSignature: draft.stripSignature,
          },
          greeting: draft.greeting,
          signature: draft.signature,
        },
      })
      if (saved.error) {
        setParsingError(saved.error)
        return
      }
      setParsingMessage(
        `Saved parsing defaults for ${accounts.find((item) => item.id === accountId)?.email ?? accountId}. Existing messages were re-parsed.`,
      )
      await router.invalidate()
    } catch {
      setParsingError('Could not save mailbox parsing settings.')
    } finally {
      setParsingBusy(null)
    }
  }

  async function undoRevision(revisionId: string) {
    if (busy) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const undone = await undoContextRevisionAction({
        data: { revisionId },
      })
      if (undone.error) {
        setError(undone.error)
        return
      }
      await router.invalidate()
    } catch {
      setError('Could not undo that change.')
    } finally {
      setBusy(false)
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return

    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const saved = await saveAiSettingsAction({
        data: {
          jevModel: jevModel.trim() || null,
          llmProvider,
          llmModel: llmModel.trim() || null,
          suggestReplyMinImportance: Number(minImportance),
          goalCheckEnabled,
          autoContextEnabled,
          jevApiKey: jevApiKey.trim() || null,
          clearJevKey,
          llmApiKey: llmApiKey.trim() || null,
          clearLlmKey,
        },
      })

      if (saved.error) {
        setError(saved.error)
        return
      }

      // Clear the secret inputs; the stored value is never sent back.
      setJevApiKey('')
      setLlmApiKey('')
      setClearJevKey(false)
      setClearLlmKey(false)
      setMessage(
        'Saved. New decisions and topics apply from the next sync; the draft threshold applies to the next draft you ask for, and the goal check to the next reply you send.',
      )
      await router.invalidate()
    } catch {
      setError('Could not save the AI settings.')
    } finally {
      setBusy(false)
    }
  }

  const inputClass =
    'mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground'
  const statusClass = 'mt-1 text-[11px] text-muted-foreground'

  return (
    <AppShell
      accounts={accounts}
      profileEmail={viewer.email}
      nav={<SettingsNav active={activePanel} onSelect={selectPanel} />}
    >
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-2xl font-bold">{panel?.label ?? 'Settings'}</h1>
          <Link
            to="/"
            className="text-xs font-medium text-primary hover:underline lg:hidden"
          >
            ← Back to inbox
          </Link>
        </div>
        {panel ? (
          <p className="mt-1 text-sm text-muted-foreground">
            {panel.description}
          </p>
        ) : null}

        {/*
         * Below `lg` the shell's sidebar is hidden, and panels would leave every
         * screen but the first unreachable. The same items, as a scrolling strip.
         */}
        <div
          role="group"
          aria-label="Settings sections"
          className="mt-4 flex gap-1 overflow-x-auto rounded-lg border border-border bg-muted/40 p-1 lg:hidden"
        >
          {SETTINGS_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => selectPanel(item.id)}
              aria-current={activePanel === item.id ? 'page' : undefined}
              className={`inline-flex h-7 shrink-0 items-center rounded-md px-2.5 text-xs font-medium transition-colors ${
                activePanel === item.id
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {/*
         * One topic per card, every card the full width of the column.
         *
         * This used to be a 12-column bento, which put unrelated things beside each
         * other — signed-in devices next to parsing defaults — and left the two
         * halves of one topic (the four labels, then the custom ones) in different
         * rows of different heights. Reading it meant tracking across two columns
         * that had nothing to do with each other.
         */}
        <div className="mt-6 space-y-5">
          {activePanel === 'account' ? (
            <section className="rounded-lg border border-border bg-card p-4">
              <h2 className="text-sm font-semibold text-foreground">Account</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Signed in as{' '}
                <span className="text-foreground">
                  {viewer.name ? `${viewer.name} — ` : ''}
                  {viewer.email}
                </span>
                . Your mailboxes, keys and sender marks belong to this account
                alone.
              </p>

              <h3 className="mt-4 text-xs font-medium text-foreground">
                Signed-in devices
              </h3>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                One row per browser that signed in. Signing out here ends this
                browser's session only, so a phone left signed in can be cut off
                without disturbing this laptop.
              </p>

              <ul className="mt-2 space-y-1">
                {devices.map((device) => (
                  <li
                    key={device.id}
                    className="flex items-baseline justify-between gap-3 text-[11px] text-muted-foreground"
                  >
                    <span
                      className="min-w-0 truncate"
                      title={device.userAgent ?? ''}
                    >
                      {device.userAgent ?? 'Unknown device'}
                    </span>
                    <span className="shrink-0">
                      {device.current ? 'this device — ' : ''}
                      {/* UTC and stable: this renders on the server too, and a
                    locale-formatted time would differ between the two. */}
                      {device.lastSeenAt.slice(0, 16).replace('T', ' ')} UTC
                    </span>
                  </li>
                ))}
              </ul>

              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void signOut(false)}
                  className="inline-flex h-8 items-center rounded-md border border-border bg-background px-3 font-medium text-foreground hover:border-foreground/25 disabled:opacity-50"
                >
                  Sign out
                </button>
                <button
                  type="button"
                  disabled={busy || devices.length <= 1}
                  onClick={() => void signOut(true)}
                  className="inline-flex h-8 items-center rounded-md border border-border bg-background px-3 font-medium text-foreground hover:border-foreground/25 disabled:opacity-50"
                >
                  Sign out everywhere else
                </button>
              </div>

              <label className="mt-4 flex items-start gap-2 text-[11px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={gravatar}
                  disabled={busy}
                  onChange={(event) =>
                    void toggleGravatar(event.target.checked)
                  }
                  className="mt-0.5"
                />
                <span>
                  <span className="text-foreground">
                    Load avatars from Gravatar
                  </span>{' '}
                  — contacts always get initials; this sends an MD5 of each
                  sender's address to gravatar.com. Leave it off to keep
                  addresses on this machine.
                </span>
              </label>

              {accountError ? (
                <p
                  role="alert"
                  className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  {accountError}
                </p>
              ) : null}
              {accountMessage ? (
                <p
                  role="status"
                  className="mt-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
                >
                  {accountMessage}
                </p>
              ) : null}
            </section>
          ) : null}

          {activePanel === 'parsing' ? (
            <section className="space-y-4 rounded-lg border border-border bg-card p-4">
              <h2 className="text-sm font-semibold text-foreground">
                Parsing defaults
              </h2>
              <p className="text-xs text-muted-foreground">
                These defaults apply to new messages in each mailbox. Saving
                also re-parses stored messages locally, including their original
                text and HTML where available. Sender-specific overrides remain
                in each conversation.
              </p>
              {accounts.map((account) => {
                const draft = parsingDrafts[account.id] ?? {
                  ...account.parsingDefaults,
                  greeting: account.defaultReplyGreeting,
                  signature: account.defaultReplySignature,
                }
                const toggle = (
                  key: keyof ParsingPreferences,
                  label: string,
                ) => (
                  <label className="flex items-center gap-2 text-xs text-foreground">
                    <input
                      type="checkbox"
                      checked={draft[key]}
                      disabled={parsingBusy !== null}
                      onChange={(event) =>
                        setParsingDrafts((current) => ({
                          ...current,
                          [account.id]: {
                            ...(current[account.id] ?? draft),
                            [key]: event.target.checked,
                          },
                        }))
                      }
                    />
                    Strip {label}
                  </label>
                )
                return (
                  <div
                    key={account.id}
                    className="rounded-md border border-border p-3"
                  >
                    <h3 className="text-xs font-medium text-foreground">
                      {account.email} ·{' '}
                      {account.provider === 'microsoft' ? 'Outlook' : 'Gmail'}
                    </h3>
                    <div className="mt-3 space-y-2">
                      {toggle('stripQuotedHistory', 'quoted history')}
                      {toggle('stripGreeting', 'greetings')}
                      {toggle('stripSignature', 'signatures')}
                      <Field label="Default reply greeting">
                        <input
                          value={draft.greeting}
                          maxLength={200}
                          disabled={parsingBusy !== null}
                          onChange={(event) =>
                            setParsingDrafts((current) => ({
                              ...current,
                              [account.id]: {
                                ...(current[account.id] ?? draft),
                                greeting: event.target.value,
                              },
                            }))
                          }
                          className={inputClass}
                        />
                      </Field>
                      <Field label="Default reply signature">
                        <textarea
                          value={draft.signature}
                          maxLength={1000}
                          rows={2}
                          disabled={parsingBusy !== null}
                          onChange={(event) =>
                            setParsingDrafts((current) => ({
                              ...current,
                              [account.id]: {
                                ...(current[account.id] ?? draft),
                                signature: event.target.value,
                              },
                            }))
                          }
                          className={inputClass}
                        />
                      </Field>
                      <button
                        type="button"
                        disabled={parsingBusy !== null}
                        onClick={() => void saveMailboxParsing(account.id)}
                        className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
                      >
                        {parsingBusy === account.id
                          ? 'Saving & re-parsing…'
                          : 'Save parsing defaults'}
                      </button>
                    </div>
                  </div>
                )
              })}
              {accounts.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Connect a mailbox to set its parsing defaults.
                </p>
              ) : null}
              {parsingError ? (
                <p role="alert" className="text-xs text-destructive">
                  {parsingError}
                </p>
              ) : null}
              {parsingMessage ? (
                <p role="status" className="text-xs text-muted-foreground">
                  {parsingMessage}
                </p>
              ) : null}
            </section>
          ) : null}

          {activePanel === 'state-labels' ? (
            <StateLabelsEditor initialLabels={initialStateLabels} />
          ) : null}

          {activePanel === 'custom-labels' ? (
            <OrganizationRulesEditor
              initialLabels={initialOrganizationLabels}
              stateLabels={initialStateLabels}
            />
          ) : null}
        </div>

        {activePanel === 'ai' ? (
          <section className="mt-6 rounded-lg border border-border bg-card">
            <div className="border-b border-border p-4">
              <h2 className="text-sm font-semibold text-foreground">
                AI services
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Both are optional. Without them Nuntia classifies with rules
                only and conversations have no topic. Each person connects their
                own keys — there is no shared key for the install — and they are
                encrypted at rest.
              </p>
            </div>

            {/*
             * Stacked rather than split 5/7: the two services are one topic, but the
             * LLM half now carries the draft threshold, the goal check, the context
             * switch and the change log, which made a narrow column a long scroll
             * beside a mostly empty one.
             */}
            <form
              onSubmit={(event) => void submit(event)}
              className="divide-y divide-border"
            >
              <section className="p-4">
                <h3 className="text-sm font-semibold text-foreground">
                  Decision model — Jev
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Rates importance and urgency, and fills in the state when the
                  rules cannot decide it.
                </p>
                <p className={statusClass}>
                  {settings.jevConfigured
                    ? 'A key is stored. Enter a new one to replace it.'
                    : 'Not connected yet — add a key below.'}
                </p>

                <div className="mt-3 space-y-3">
                  <Field label="Jev API key">
                    <input
                      type="password"
                      value={jevApiKey}
                      disabled={clearJevKey}
                      placeholder={
                        settings.jevConfigured ? '••••••••' : 'ts-...'
                      }
                      onChange={(event) => setJevApiKey(event.target.value)}
                      autoComplete="off"
                      className={inputClass}
                    />
                  </Field>
                  <Field label="Model" hint="Defaults to jev-latest.">
                    <input
                      value={jevModel}
                      placeholder="jev-latest"
                      onChange={(event) => setJevModel(event.target.value)}
                      className={inputClass}
                    />
                  </Field>
                  {settings.jevConfigured ? (
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={clearJevKey}
                        onChange={(event) =>
                          setClearJevKey(event.target.checked)
                        }
                      />
                      Remove the stored Jev key
                    </label>
                  ) : null}
                </div>
              </section>

              <section className="p-4">
                <h3 className="text-sm font-semibold text-foreground">
                  Topics — LLM
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Writes a short topic label for each conversation. Drafting a
                  reply is set up under Suggested replies, so the two decisions
                  stay on their own screens.
                </p>
                <p className={statusClass}>
                  {settings.llmConfigured
                    ? 'A key is stored. Enter a new one to replace it.'
                    : 'Not connected yet — add a key below.'}
                </p>

                <div className="mt-3 space-y-3">
                  <Field label="Provider">
                    <select
                      value={llmProvider}
                      onChange={(event) =>
                        setLlmProvider(event.target.value as '' | LlmProvider)
                      }
                      className={inputClass}
                    >
                      {PROVIDERS.map((provider) => (
                        <option key={provider.value} value={provider.value}>
                          {provider.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="API key">
                    <input
                      type="password"
                      value={llmApiKey}
                      disabled={clearLlmKey || llmProvider === ''}
                      placeholder={
                        settings.llmConfigured ? '••••••••' : 'sk-...'
                      }
                      onChange={(event) => setLlmApiKey(event.target.value)}
                      autoComplete="off"
                      className={inputClass}
                    />
                  </Field>
                  <Field
                    label="Model"
                    hint="Leave blank to use the provider default."
                  >
                    <input
                      value={llmModel}
                      placeholder="gemini-2.5-flash"
                      disabled={llmProvider === ''}
                      onChange={(event) => setLlmModel(event.target.value)}
                      className={inputClass}
                    />
                  </Field>
                  {/* Key management belongs with the connection it is for, not
                    with the reply threshold on the next screen. */}
                  {settings.llmConfigured ? (
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={clearLlmKey}
                        onChange={(event) =>
                          setClearLlmKey(event.target.checked)
                        }
                      />
                      Remove the stored LLM key
                    </label>
                  ) : null}
                </div>
              </section>

              <div className="space-y-3 p-4">
                {error ? (
                  <p
                    role="alert"
                    className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  >
                    {error}
                  </p>
                ) : null}
                {message ? (
                  <p
                    role="status"
                    className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
                  >
                    {message}
                  </p>
                ) : null}
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                >
                  {busy ? 'Saving…' : 'Save settings'}
                </button>
              </div>
            </form>
          </section>
        ) : null}

        {activePanel === 'replies' ? (
          <section className="mt-6 rounded-lg border border-border bg-card">
            <div className="border-b border-border p-4">
              <h2 className="text-sm font-semibold text-foreground">
                Suggested replies
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                When Nuntia offers to draft a reply, and whether a sent reply is
                checked against the thread&rsquo;s goal. A draft is always text
                in the composer to review — the app never sends one.
              </p>
            </div>
            <form
              onSubmit={(event) => void submit(event)}
              className="divide-y divide-border"
            >
              <section className="p-4">
                <div className="space-y-3">
                  <Field
                    label="Draft a reply from importance"
                    hint={`${REPLY_DRAFT_MIN_IMPORTANCE_MIN} to ${REPLY_DRAFT_MIN_IMPORTANCE_MAX}. Every draft is one API call, so the routine mail below this is left alone.`}
                  >
                    <input
                      type="number"
                      min={REPLY_DRAFT_MIN_IMPORTANCE_MIN}
                      max={REPLY_DRAFT_MIN_IMPORTANCE_MAX}
                      step={1}
                      value={minImportance}
                      onChange={(event) => setMinImportance(event.target.value)}
                      className={inputClass}
                    />
                  </Field>
                  <label className="flex items-start gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={goalCheckEnabled}
                      onChange={(event) =>
                        setGoalCheckEnabled(event.target.checked)
                      }
                      className="mt-0.5"
                    />
                    <span>
                      <span className="font-medium text-foreground">
                        Check each reply against its goal
                      </span>
                      <span className="mt-0.5 block">
                        After you send, one extra call asks whether the reply
                        moves the thread toward its goal, and offers a follow-up
                        when it does not. Turning it off costs no drafts or
                        topics.
                      </span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={autoContextEnabled}
                      onChange={(event) =>
                        setAutoContextEnabled(event.target.checked)
                      }
                      className="mt-0.5"
                    />
                    <span>
                      <span className="font-medium text-foreground">
                        Update the goal and contact profile automatically
                      </span>
                      <span className="mt-0.5 block">
                        One extra call per thread that gains messages, so the
                        goal and each correspondent&rsquo;s profile follow the
                        mail instead of waiting to be filled in. It costs more
                        tokens than a topic alone, so it is off unless you turn
                        it on. Blank fields are never cleared, and every change
                        appears under recent changes below with an Undo.
                      </span>
                    </span>
                  </label>
                  {contextRevisions.length > 0 ? (
                    <div className="rounded-md border border-border bg-muted/20 p-3">
                      <p className="text-xs font-medium text-foreground">
                        Recent context changes
                      </p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        What the app changed, and what it replaced. Undo puts
                        the old value back and keeps the change in this list.
                      </p>
                      <ul className="mt-2 space-y-1.5">
                        {contextRevisions.map((revision) => (
                          <li
                            key={revision.id}
                            className="flex items-start justify-between gap-3 text-[11px] text-muted-foreground"
                          >
                            <span className="min-w-0">
                              <span className="font-medium text-foreground">
                                {contextRevisionLabel(revision.field)}
                              </span>{' '}
                              {revision.previousValue ? (
                                <>
                                  <span className="line-through">
                                    {revision.previousValue}
                                  </span>{' '}
                                  →{' '}
                                </>
                              ) : null}
                              <span>{revision.nextValue ?? 'cleared'}</span>
                              {revision.subject ? (
                                <span className="block truncate opacity-80">
                                  {revision.subject}
                                </span>
                              ) : null}
                            </span>
                            <button
                              type="button"
                              disabled={busy || revision.undone}
                              onClick={() => void undoRevision(revision.id)}
                              className="shrink-0 rounded border border-border px-2 py-0.5 font-medium text-foreground disabled:opacity-40"
                            >
                              {revision.undone ? 'Undone' : 'Undo'}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              </section>

              <div className="space-y-3 p-4">
                {error ? (
                  <p
                    role="alert"
                    className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  >
                    {error}
                  </p>
                ) : null}
                {message ? (
                  <p
                    role="status"
                    className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
                  >
                    {message}
                  </p>
                ) : null}

                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                >
                  {busy ? 'Saving…' : 'Save settings'}
                </button>
              </div>
            </form>
          </section>
        ) : null}

        {/* Same rule below: two unrelated topics, so neither gets a half-width slot. */}
        <div className="mt-6 space-y-5">
          {activePanel === 'senders' ? (
            <section className="rounded-lg border border-border bg-card p-4">
              <h2 className="text-sm font-semibold text-foreground">
                Can&rsquo;t reply to
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Senders whose mail has no one to answer: a company writing from
                an ordinary address with view-only content, a receipt nobody
                reads. Add an address here — one mailbox at a time — and it
                keeps the reply box hidden on every thread from that sender,
                including the ones already stored and the ones that arrive
                later. The state is left alone, so the mail is still listed
                where it was. The deterministic markers (<code>noreply@</code>{' '}
                and friends) are handled on their own and are not listed here,
                because there is nothing to take back.
              </p>

              {suggestions.length > 0 ? (
                <div className="mt-4">
                  <p className="text-xs font-medium text-foreground">
                    Senders you have received from
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    The most recent senders this mailbox still shows a reply box
                    for. One click marks them, and the reply box then goes from
                    their threads — including the ones already stored.
                  </p>
                  <ul className="mt-2 space-y-1.5">
                    {suggestions.map((sender) => (
                      <li
                        key={`${sender.accountId}:${sender.email}`}
                        className="flex items-center justify-between gap-3 text-xs"
                      >
                        <span className="min-w-0 truncate">
                          {sender.name ? (
                            <>
                              <span className="text-foreground">
                                {sender.name}
                              </span>{' '}
                              <span className="text-muted-foreground">
                                {sender.email}
                              </span>
                            </>
                          ) : (
                            <span className="text-foreground">
                              {sender.email}
                            </span>
                          )}
                        </span>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void addSenderAddress(
                              sender.accountId,
                              sender.email,
                            )
                          }
                          title={`Hide the reply box on every thread from ${sender.email}`}
                          className="shrink-0 rounded-md border border-border px-2 py-1 font-medium text-foreground hover:border-foreground/25 disabled:opacity-50"
                        >
                          Can’t reply
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {accounts.length === 0 ? null : (
                <form
                  onSubmit={(event) => void addSender(event)}
                  className="mt-3 flex flex-wrap items-center gap-2"
                >
                  {suggestions.length > 0 ? (
                    <span className="w-full text-[11px] text-muted-foreground">
                      Or name an address you have not received from yet:
                    </span>
                  ) : null}
                  {accounts.length > 1 ? (
                    <select
                      value={senderAccount}
                      onChange={(event) => setSenderAccount(event.target.value)}
                      disabled={busy}
                      aria-label="Mailbox"
                      className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground disabled:opacity-50"
                    >
                      {accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.email}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  <input
                    type="email"
                    value={senderInput}
                    onChange={(event) => setSenderInput(event.target.value)}
                    disabled={busy}
                    placeholder="updates@example.com"
                    aria-label="Sender address"
                    className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/60 disabled:opacity-50"
                  />
                  <button
                    type="submit"
                    disabled={busy || senderInput.trim() === ''}
                    className="shrink-0 rounded-md border border-border px-2 py-1 font-medium text-foreground hover:border-foreground/25 disabled:opacity-50"
                  >
                    {busy ? 'Adding…' : 'Add'}
                  </button>
                </form>
              )}

              {unreplyableSenders.length === 0 ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  {accounts.length === 0
                    ? 'Connect a mailbox to manage this list.'
                    : 'Nothing marked. Add an address above.'}
                </p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {unreplyableSenders.map((entry) => (
                    <li
                      key={`${entry.accountId}:${entry.senderEmail}`}
                      className="flex items-center justify-between gap-3 text-xs"
                    >
                      <span className="min-w-0 truncate text-foreground">
                        {entry.senderEmail}
                        <span className="ml-2 text-muted-foreground">
                          {entry.accountId}
                        </span>
                      </span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void allowReplies(entry.accountId, entry.senderEmail)
                        }
                        className="shrink-0 rounded-md border border-border px-2 py-1 font-medium text-foreground hover:border-foreground/25 disabled:opacity-50"
                      >
                        Allow replies
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {senderError ? (
                <p
                  role="alert"
                  className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  {senderError}
                </p>
              ) : null}
              {senderMessage ? (
                <p
                  role="status"
                  className="mt-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
                >
                  {senderMessage}
                </p>
              ) : null}
            </section>
          ) : null}

          {activePanel === 'mailboxes' ? (
            <section className="rounded-lg border border-border bg-card p-4">
              <h2 className="text-sm font-semibold text-foreground">
                Connected mailboxes
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Deleting a mailbox removes the conversations and attachments
                stored on this machine. Nothing is deleted from Gmail — connect
                it again and it syncs fresh. Useful when mail was stored by an
                older version and you want to see what the current one makes of
                it.
              </p>
              <ul className="mt-3 space-y-2">
                {accounts.map((account) => (
                  <li
                    key={account.id}
                    className="flex items-center justify-between gap-3 text-xs"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-foreground">
                        {account.email}
                      </span>
                      <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                        {account.provider === 'microsoft' ? 'Outlook' : 'Gmail'}
                      </span>
                    </span>

                    {pendingDelete === account.id ? (
                      <span className="flex shrink-0 items-center gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void removeMailbox(account.id)}
                          className="rounded-md border border-destructive bg-destructive/10 px-2 py-1 font-medium text-destructive disabled:opacity-50"
                        >
                          {busy ? 'Deleting…' : 'Delete everything'}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setPendingDelete(null)}
                          className="rounded-md border border-border px-2 py-1 font-medium text-muted-foreground disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void removeMailbox(account.id)}
                        className="shrink-0 rounded-md border border-destructive/40 px-2 py-1 font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                      >
                        Delete stored mail
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <a
                  href="/auth/google"
                  className="inline-flex h-8 items-center rounded-md border border-border bg-background px-3 font-medium text-foreground hover:border-foreground/25"
                >
                  Add Gmail
                </a>
                <a
                  href="/auth/microsoft"
                  className="inline-flex h-8 items-center rounded-md border border-border bg-background px-3 font-medium text-foreground hover:border-foreground/25"
                >
                  Add Outlook
                </a>
              </div>
              {mailboxError ? (
                <p
                  role="alert"
                  className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  {mailboxError}
                </p>
              ) : null}
              {mailboxMessage ? (
                <p
                  role="status"
                  className="mt-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
                >
                  {mailboxMessage}
                </p>
              ) : null}
              <p className="mt-3 text-[11px] text-muted-foreground">
                To add a mailbox,{' '}
                <a href="/auth/google" className="text-primary hover:underline">
                  connect Gmail
                </a>
                .
              </p>{' '}
            </section>
          ) : null}
        </div>
      </div>
    </AppShell>
  )
}
