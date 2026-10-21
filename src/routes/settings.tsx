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
  destroySession,
  getSession,
  getUser,
  listAccounts,
  listSessions,
  revokeAllSessions,
} from '#/lib/auth/index.ts'
import {
  aiLogPath,
  getAiSettings,
  readRecentAiEvents,
  saveAiSettings,
} from '#/lib/ai/index.ts'
import type {
  AiLogRecord,
  AiSettingsSummary,
  LlmProvider,
} from '#/lib/ai/index.ts'
import {
  addUnreplyableSender,
  forgetAccount,
  removeUnreplyableSender,
} from '#/lib/gmail/service.ts'
import {
  listIncomingSenders,
  listUnreplyableSenders,
} from '#/lib/conversation/index.ts'
// The draft limits are imported from the pure module that defines them, not from
// the conversation barrel: the barrel also re-exports the repository and the
// decision pipeline, and a browser import of it drags `node:fs` (the AI log)
// into the client graph. Only server functions may use the barrel.
import {
  REPLY_DRAFT_MIN_IMPORTANCE_MAX,
  REPLY_DRAFT_MIN_IMPORTANCE_MIN,
} from '#/lib/conversation/draft.ts'
import { cn } from '#/lib/utils'
import { getPreferences, savePreferences } from '#/lib/settings/preferences.ts'

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
        settings: AiSettingsSummary /** Connected mailboxes, so they can be listed and cleared out. */
        accounts: Array<{
          id: string
          email: string
          provider: 'google' | 'microsoft'
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
        /** Recent AI calls, with the file they were written to. */
        aiLog: { path: string; events: AiLogRecord[] }
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
      accounts: accounts.map((account) => ({
        id: account.id,
        email: account.email,
        provider: account.provider,
      })),
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
      aiLog: { path: aiLogPath(), events: await readRecentAiEvents(20) },
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
 * Settings, one component.
 *
 * There used to be a signed-out branch here, split out so flipping the loader's
 * state did not change a hook list. The loader redirects a signed-out visitor
 * now, so the only variable left is how many mailboxes the user has — and a user
 * with none still has an account, keys to set, and devices to sign out.
 */
function Settings() {
  return <SettingsForm result={Route.useLoaderData()} />
}

function SettingsForm({ result }: { result: SignedInSettings }) {
  const router = useRouter()

  const {
    settings,
    accounts,
    aiLog,
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
        'Saved. New decisions and topics apply from the next sync; the draft threshold applies to the next draft you ask for.',
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
    <div className="mx-auto max-w-2xl p-8">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-bold">Settings</h1>
        <Link
          to="/"
          className="text-xs font-medium text-primary hover:underline"
        >
          ← Back to inbox
        </Link>
      </div>

      <section className="mt-6 rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold text-foreground">Account</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Signed in as{' '}
          <span className="text-foreground">
            {viewer.name ? `${viewer.name} — ` : ''}
            {viewer.email}
          </span>
          . Your mailboxes, keys and sender marks belong to this account alone.
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
              <span className="min-w-0 truncate" title={device.userAgent ?? ''}>
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
            onChange={(event) => void toggleGravatar(event.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="text-foreground">Load avatars from Gravatar</span>{' '}
            — contacts always get initials; this sends an MD5 of each sender's
            address to gravatar.com. Leave it off to keep addresses on this
            machine.
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

      <p className="mt-6 text-sm text-muted-foreground">
        Both AI services are optional. Without them Lumen classifies with rules
        only and conversations have no topic. Keys are encrypted at rest.
      </p>

      <form onSubmit={(event) => void submit(event)} className="mt-6 space-y-8">
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-semibold text-foreground">
            Decision model — Jev
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Rates importance and urgency, and fills in the state when the rules
            cannot decide it.
          </p>
          <p className={statusClass}>
            {settings.jevConfigured
              ? 'A key is stored. Enter a new one to replace it.'
              : 'Not configured.'}
          </p>

          <div className="mt-3 space-y-3">
            <Field label="Jev API key">
              <input
                type="password"
                value={jevApiKey}
                disabled={clearJevKey}
                placeholder={settings.jevConfigured ? '••••••••' : 'ts-...'}
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
                  onChange={(event) => setClearJevKey(event.target.checked)}
                />
                Remove the stored Jev key
              </label>
            ) : null}
          </div>
        </section>

        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-semibold text-foreground">
            Topics and drafts — LLM
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Writes a short topic label for each conversation, and drafts a reply
            on the ones that ask for one and clear the threshold below. A draft
            is always text in the composer to review — the app never sends it.
          </p>
          <p className={statusClass}>
            {settings.llmConfigured
              ? 'A key is stored. Enter a new one to replace it.'
              : 'Not configured.'}
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
                placeholder={settings.llmConfigured ? '••••••••' : 'sk-...'}
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
            {settings.llmConfigured ? (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={clearLlmKey}
                  onChange={(event) => setClearLlmKey(event.target.checked)}
                />
                Remove the stored LLM key
              </label>
            ) : null}
          </div>
        </section>

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
      </form>

      <section className="mt-8 rounded-lg border border-border bg-card p-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold text-foreground">AI activity</h2>
          <button
            type="button"
            disabled={busy}
            onClick={() => void router.invalidate()}
            className="rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground disabled:opacity-50"
          >
            Refresh
          </button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Every call to Jev or the topic model, newest last. A failure the rules
          paper over is recorded here too, which is what makes "the AI did
          nothing" answerable.
        </p>

        {aiLog.events.length === 0 ? (
          <p className="mt-3 text-xs text-muted-foreground">
            Nothing logged yet. Sync or re-analyse a conversation.
          </p>
        ) : (
          <ul className="mt-3 space-y-1">
            {aiLog.events.map((event, index) => (
              <li
                key={`${event.at}-${index}`}
                className={cn(
                  'flex items-baseline gap-2 text-[11px]',
                  event.outcome === 'ok'
                    ? 'text-muted-foreground'
                    : 'text-destructive',
                )}
              >
                <time dateTime={event.at} className="shrink-0">
                  {event.at.slice(11, 19)}
                </time>
                <span className="shrink-0 font-medium">{event.service}</span>
                <span className="shrink-0">
                  {event.outcome}
                  {event.status ? ` ${event.status}` : ''}
                </span>
                {event.model ? (
                  <span className="shrink-0 text-muted-foreground/70">
                    {event.model}
                  </span>
                ) : null}
                {event.detail ? (
                  <span className="min-w-0 truncate">{event.detail}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        <p className="mt-3 text-[11px] text-muted-foreground">
          Full history: <code>{aiLog.path}</code>
        </p>
      </section>

      <section className="mt-8 rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold text-foreground">
          Can&rsquo;t reply to
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Senders whose mail has no one to answer: a company writing from an
          ordinary address with view-only content, a receipt nobody reads. Add
          an address here — one mailbox at a time — and it keeps the reply box
          hidden on every thread from that sender, including the ones already
          stored and the ones that arrive later. The state is left alone, so the
          mail is still listed where it was. The deterministic markers (
          <code>noreply@</code> and friends) are handled on their own and are
          not listed here, because there is nothing to take back.
        </p>

        {suggestions.length > 0 ? (
          <div className="mt-4">
            <p className="text-xs font-medium text-foreground">
              Senders you have received from
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              The most recent senders this mailbox still shows a reply box for.
              One click marks them, and the reply box then goes from their
              threads — including the ones already stored.
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
                        <span className="text-foreground">{sender.name}</span>{' '}
                        <span className="text-muted-foreground">
                          {sender.email}
                        </span>
                      </>
                    ) : (
                      <span className="text-foreground">{sender.email}</span>
                    )}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void addSenderAddress(sender.accountId, sender.email)
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

      <section className="mt-8 rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold text-foreground">
          Connected mailboxes
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Deleting a mailbox removes the conversations and attachments stored on
          this machine. Nothing is deleted from Gmail — connect it again and it
          syncs fresh. Useful when mail was stored by an older version and you
          want to see what the current one makes of it.
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
        </p>
      </section>
    </div>
  )
}
