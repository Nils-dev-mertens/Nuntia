/**
 * AI settings.
 *
 * The two services are configured here rather than in the environment: the keys
 * are per-install secrets set by the user, stored encrypted, and editable without
 * a redeploy. Each service is independent — you can configure Jev without an LLM,
 * or an LLM without Jev, and an unconfigured service simply falls back to the
 * rule-based behaviour.
 *
 * The loader returns a *summary* only (is it configured, which model). The keys
 * are never sent to the browser.
 */

import { createServerFn } from '@tanstack/react-start'
import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import type { FormEvent } from 'react'

import {
  clearSession,
  getSession,
  listAccounts,
  setSession,
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
        accounts: Array<{ id: string; email: string }>
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

    const accounts = await listAccounts()

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

    return {
      signedIn: true,
      settings: await getAiSettings(),
      accounts: accounts.map((account) => ({
        id: account.id,
        email: account.email,
      })),
      aiLog: { path: aiLogPath(), events: await readRecentAiEvents(20) },
      unreplyableSenders,
      recentSenders,
    }
  },
)

/**
 * Disconnect a mailbox and delete everything synced from it.
 *
 * The id arrives from the browser, so it is checked against the connected
 * mailboxes rather than trusted. Signing out is about the *install* having no
 * mailbox left, not about which row the cookie happens to name: with another
 * mailbox still connected there is nothing to sign out of, so the session is
 * re-pointed at it. Clearing it regardless stranded an install that still had
 * mail on the "connect a mailbox" screen and made the user re-authorise an
 * account they already had.
 */
const forgetAccountAction = createServerFn({ method: 'POST' })
  // `validator`, not `inputValidator`: the latter is deprecated. The other
  // actions in this app still use the old name and should be renamed too.
  .validator((data: { accountId: string }) => data)
  .handler(
    async ({ data }): Promise<{ error: string | null; signedOut: boolean }> => {
      const session = await getSession()
      if (!session) return { error: 'You are not signed in.', signedOut: false }

      const wanted = data.accountId.trim().toLowerCase()
      const connected = await listAccounts()
      if (!connected.some((account) => account.id === wanted)) {
        return { error: 'That mailbox is not connected.', signedOut: false }
      }

      try {
        await forgetAccount(wanted)

        const remaining = await listAccounts()
        const signedOut = remaining.length === 0

        if (signedOut) {
          clearSession()
        } else if (session.accountId === wanted) {
          // The cookie is only a signed-in gate — every screen resolves its own
          // account — but leaving it naming a row that no longer exists is stale
          // state for no reason. Point it at one that still does.
          await setSession(remaining[0].id)
        }

        return { error: null, signedOut }
      } catch (error) {
        console.error('[settings] deleting stored mail failed:', error)
        return { error: 'Could not delete the stored mail.', signedOut: false }
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
      return await removeUnreplyableSender(data.accountId, data.senderEmail)
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
        return await addUnreplyableSender(data.accountId, data.senderEmail)
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
      await saveAiSettings({
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
  loader: () => fetchAiSettings(),
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
 * Settings, split in two so the signed-out branch cannot change a hook list.
 *
 * The branch used to sit above the form's twenty-odd `useState` calls inside a
 * single component. Re-rendering it in place — which is exactly what invalidating
 * after deleting the session's own mailbox did, flipping the loader from signed in
 * to signed out — then rendered fewer hooks than the pass before and React
 * refused the update. One component per branch keeps each hook list fixed.
 */
function Settings() {
  const result = Route.useLoaderData()

  return result.signedIn ? (
    <SettingsForm result={result} />
  ) : (
    <SignedOutSettings />
  )
}

/** What this page shows when no mailbox is connected at all. */
function SignedOutSettings() {
  return (
    <div className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-bold">Settings</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Connect a mailbox before configuring AI services.
      </p>
      <a
        href="/auth/google"
        className="mt-4 inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
      >
        Connect Gmail
      </a>
    </div>
  )
}

function SettingsForm({ result }: { result: SignedInSettings }) {
  const router = useRouter()

  const { settings, accounts, aiLog, unreplyableSenders, recentSenders } =
    result

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
      setMailboxMessage(
        forgotten.signedOut
          ? 'Deleted. Connect a mailbox to sync it fresh.'
          : 'Deleted.',
      )
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

      <p className="mt-2 text-sm text-muted-foreground">
        Both services are optional. Without them Lumen classifies with rules
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
              <span className="truncate text-foreground">{account.email}</span>

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
