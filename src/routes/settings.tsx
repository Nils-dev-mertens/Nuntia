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

import { getSession } from '#/lib/auth/index.ts'
import { getAiSettings, saveAiSettings } from '#/lib/ai/index.ts'
import type { AiSettingsSummary, LlmProvider } from '#/lib/ai/index.ts'

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
    { signedIn: false } | { signedIn: true; settings: AiSettingsSummary }
  > => {
    const session = await getSession()
    if (!session) return { signedIn: false }
    return { signedIn: true, settings: await getAiSettings() }
  },
)

type SaveInput = {
  jevModel: string | null
  llmProvider: string
  llmModel: string | null
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

function Settings() {
  const result = Route.useLoaderData()
  const router = useRouter()

  if (!result.signedIn) {
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

  const { settings } = result

  const [jevModel, setJevModel] = useState(settings.jevModel ?? '')
  const [jevApiKey, setJevApiKey] = useState('')
  const [clearJevKey, setClearJevKey] = useState(false)

  const [llmProvider, setLlmProvider] = useState<'' | LlmProvider>(
    settings.llmProvider ?? '',
  )
  const [llmModel, setLlmModel] = useState(settings.llmModel ?? '')
  const [llmApiKey, setLlmApiKey] = useState('')
  const [clearLlmKey, setClearLlmKey] = useState(false)

  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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
      setMessage('Saved. New decisions and topics apply from the next sync.')
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
        <Link to="/" className="text-xs font-medium text-primary hover:underline">
          ← Back to inbox
        </Link>
      </div>

      <p className="mt-2 text-sm text-muted-foreground">
        Both services are optional. Without them Lumen classifies with rules only
        and conversations have no topic. Keys are encrypted at rest.
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
            Topic generation — LLM
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Writes a short topic label for each conversation. Suggested replies
            and drafts come later.
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
            <Field label="Model" hint="Leave blank to use the provider default.">
              <input
                value={llmModel}
                placeholder="gemini-2.5-flash"
                disabled={llmProvider === ''}
                onChange={(event) => setLlmModel(event.target.value)}
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
          <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {message ? (
          <p role="status" className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
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
    </div>
  )
}
