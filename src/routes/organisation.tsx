/**
 * `/organisation` — the workspace page.
 *
 * What a company shares lives here: the workspace's name, who is in it and with
 * what role, and the AI configuration the whole workspace spends. `/admin` stays
 * the product owner's install-level page; this is the page a member of a company
 * can reach, which is why it is the one that needs role gates.
 *
 * The rule, in one place: the loader decides what to show, every server function
 * re-checks, and the policy itself is in `lib/organization/members.ts`. A disabled
 * input is not an authorisation check, and a browser can call an endpoint without
 * ever loading the page. A member gets the page read-only rather than a 404 —
 * knowing who runs the workspace is not a secret.
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

import { getSession } from '#/lib/auth/index.ts'
import { getAiSettings, saveAiSettings } from '#/lib/ai/index.ts'
import type { AiSettingsSummary, LlmProvider } from '#/lib/ai/index.ts'
import {
  REPLY_DRAFT_MIN_IMPORTANCE_MAX,
  REPLY_DRAFT_MIN_IMPORTANCE_MIN,
} from '#/lib/conversation/draft.ts'
import {
  canManageWorkspace,
  canManageWorkspaceRoles,
  listWorkspaceMembers,
  renameWorkspace,
  setMemberRole,
  workspaceForManager,
} from '#/lib/organization/members.ts'
import type { WorkspaceMember } from '#/lib/organization/members.ts'
import { ensureWorkspace } from '#/lib/organization/workspace.ts'
import { MEMBERSHIP_ROLES } from '#/db/schema.ts'
import type { MembershipRole, OrganizationKind } from '#/db/schema.ts'

const ROLE_LABELS: Record<MembershipRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
}

/** Provider choices for the topic generator. Labels only — no server code. */
const PROVIDERS: Array<{ value: '' | LlmProvider; label: string }> = [
  { value: '', label: 'Off — no topic labels' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'gemini', label: 'Google Gemini' },
]

const PROVIDER_VALUES = new Set(PROVIDERS.map((provider) => provider.value))

type OrganisationData = {
  workspace: {
    id: string
    name: string
    kind: OrganizationKind
    role: MembershipRole
  }
  members: WorkspaceMember[]
  ai: AiSettingsSummary
  canManage: boolean
  canManageRoles: boolean
}

const loadOrganisation = createServerFn({ method: 'GET' }).handler(
  async (): Promise<OrganisationData | null> => {
    const session = await getSession()
    if (!session) return null

    const workspace = await ensureWorkspace(session.userId)
    if (!workspace) return null

    const [members, ai] = await Promise.all([
      listWorkspaceMembers(workspace.organizationId),
      getAiSettings(session.userId),
    ])

    return {
      workspace: {
        id: workspace.organizationId,
        name: workspace.name,
        kind: workspace.kind,
        role: workspace.role,
      },
      members,
      ai,
      canManage: canManageWorkspace(workspace.role),
      canManageRoles: canManageWorkspaceRoles(workspace.role),
    }
  },
)

const renameWorkspaceAction = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => {
    const candidate = data as { name?: unknown } | null
    if (!candidate || typeof candidate.name !== 'string') {
      throw new Error('A workspace name is required.')
    }
    return { name: candidate.name }
  })
  .handler(
    async ({
      data,
    }): Promise<{ error: string | null; name: string | null }> => {
      const session = await getSession()
      if (!session) return { error: 'You are not signed in.', name: null }

      try {
        return await renameWorkspace(session.userId, data.name)
      } catch (error) {
        console.error('[organisation] renaming the workspace failed:', error)
        return { error: 'Could not rename this workspace.', name: null }
      }
    },
  )

const setMemberRoleAction = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => {
    const candidate = data as { userId?: unknown; role?: unknown } | null
    if (
      !candidate ||
      typeof candidate.userId !== 'string' ||
      typeof candidate.role !== 'string'
    ) {
      throw new Error('A member and a role are required.')
    }
    return { userId: candidate.userId, role: candidate.role as MembershipRole }
  })
  .handler(async ({ data }): Promise<{ error: string | null }> => {
    const session = await getSession()
    if (!session) return { error: 'You are not signed in.' }

    try {
      return await setMemberRole(session.userId, data.userId, data.role)
    } catch (error) {
      console.error('[organisation] changing a role failed:', error)
      return { error: 'Could not change that role.' }
    }
  })

type SaveAiInput = {
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

function validateAiInput(data: SaveAiInput): string | null {
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

const saveWorkspaceAiSettingsAction = createServerFn({ method: 'POST' })
  .inputValidator((data: SaveAiInput) => data)
  .handler(async ({ data }): Promise<{ error: string | null }> => {
    const session = await getSession()
    if (!session) return { error: 'You are not signed in.' }

    // The workspace is resolved from the session, so a member cannot post to
    // someone else's keys by naming their organisation id.
    if (!(await workspaceForManager(session.userId))) {
      return { error: 'Only an owner or admin can change these settings.' }
    }

    const invalid = validateAiInput(data)
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
      console.error('[organisation] saving AI settings failed:', error)
      return { error: 'Could not save these settings.' }
    }
  })

export const Route = createFileRoute('/organisation')({
  loader: async () => {
    const data = await loadOrganisation()
    if (!data) throw redirect({ to: '/sign-in' })
    return data
  },
  component: Organisation,
})

const inputClass =
  'w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-foreground/30 disabled:opacity-60'
const statusClass = 'mt-2 text-xs text-muted-foreground'

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
      {hint ? <span className="mt-0.5 block">{hint}</span> : null}
    </label>
  )
}

function Organisation() {
  const data = Route.useLoaderData()
  const router = useRouter()

  const { workspace, members, ai, canManage, canManageRoles } = data

  const [name, setName] = useState(workspace.name)
  const [nameBusy, setNameBusy] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [nameMessage, setNameMessage] = useState<string | null>(null)

  const [roleBusy, setRoleBusy] = useState<string | null>(null)
  const [roleError, setRoleError] = useState<string | null>(null)
  const [roleMessage, setRoleMessage] = useState<string | null>(null)

  const [jevModel, setJevModel] = useState(ai.jevModel ?? '')
  const [jevApiKey, setJevApiKey] = useState('')
  const [clearJevKey, setClearJevKey] = useState(false)
  const [llmProvider, setLlmProvider] = useState<'' | LlmProvider>(
    ai.llmProvider ?? '',
  )
  const [llmModel, setLlmModel] = useState(ai.llmModel ?? '')
  const [llmApiKey, setLlmApiKey] = useState('')
  const [clearLlmKey, setClearLlmKey] = useState(false)
  // Held as text so the field can be emptied while typing; parsed on save, and
  // the server refuses anything that is not a whole 1–10.
  const [minImportance, setMinImportance] = useState(
    String(ai.suggestReplyMinImportance),
  )
  const [goalCheckEnabled, setGoalCheckEnabled] = useState(ai.goalCheckEnabled)
  const [autoContextEnabled, setAutoContextEnabled] = useState(
    ai.autoContextEnabled,
  )
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [aiMessage, setAiMessage] = useState<string | null>(null)

  async function saveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (nameBusy) return

    setNameBusy(true)
    setNameError(null)
    setNameMessage(null)
    try {
      const saved = await renameWorkspaceAction({ data: { name } })
      if (saved.error) {
        setNameError(saved.error)
        return
      }
      setNameMessage('Workspace renamed.')
      await router.invalidate()
    } catch {
      setNameError('Could not rename this workspace.')
    } finally {
      setNameBusy(false)
    }
  }

  async function changeRole(memberUserId: string, role: MembershipRole) {
    if (roleBusy) return

    setRoleBusy(memberUserId)
    setRoleError(null)
    setRoleMessage(null)
    try {
      const saved = await setMemberRoleAction({
        data: { userId: memberUserId, role },
      })
      if (saved.error) {
        setRoleError(saved.error)
        return
      }
      setRoleMessage('Role updated.')
      await router.invalidate()
    } catch {
      setRoleError('Could not change that role.')
    } finally {
      setRoleBusy(null)
    }
  }

  async function saveAi(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (aiBusy) return

    setAiBusy(true)
    setAiError(null)
    setAiMessage(null)
    try {
      const saved = await saveWorkspaceAiSettingsAction({
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
        setAiError(saved.error)
        return
      }
      setJevApiKey('')
      setLlmApiKey('')
      setClearJevKey(false)
      setClearLlmKey(false)
      setAiMessage('Saved for everyone in this workspace.')
      await router.invalidate()
    } catch {
      setAiError('Could not save these settings.')
    } finally {
      setAiBusy(false)
    }
  }

  const roleHint = canManageRoles
    ? 'Only the owner can change a role, and the workspace always keeps one.'
    : 'Only the owner can change a role.'

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-bold">Organisation</h1>
        <Link
          to="/settings"
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Settings
        </Link>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        A workspace owns the client list and the AI configuration. Mailboxes
        stay personal: being in the same workspace does not put anyone's inbox
        in front of anyone else.
      </p>

      <div className="mt-6 space-y-5">
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-semibold text-foreground">Workspace</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {workspace.kind === 'company'
              ? 'A company workspace: several members, one client list.'
              : 'A solo workspace: one person, whose client list is still the workspace’s — so it stays put if this becomes a company.'}{' '}
            You are {ROLE_LABELS[workspace.role].toLowerCase()} here.
          </p>

          {canManage ? (
            <form
              className="mt-3 space-y-3"
              onSubmit={(event) => void saveName(event)}
            >
              <Field label="Name">
                <input
                  value={name}
                  maxLength={80}
                  disabled={nameBusy}
                  onChange={(event) => setName(event.target.value)}
                  className={inputClass}
                />
              </Field>
              <button
                type="submit"
                disabled={nameBusy || name.trim() === ''}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                {nameBusy ? 'Saving…' : 'Save name'}
              </button>
            </form>
          ) : (
            <p className="mt-3 text-sm text-foreground">{workspace.name}</p>
          )}

          {nameError ? (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {nameError}
            </p>
          ) : null}
          {nameMessage ? (
            <p role="status" className="mt-2 text-xs text-muted-foreground">
              {nameMessage}
            </p>
          ) : null}
        </section>

        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-semibold text-foreground">Members</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {members.length} {members.length === 1 ? 'seat' : 'seats'} in this
            workspace. An owner and an admin may rename the workspace and edit
            the AI settings; only the owner changes roles. An organisation admin
            is not an install operator — `/admin` stays the product owner's
            page. {roleHint}
          </p>

          <ul className="mt-3 space-y-2">
            {members.map((member) => (
              <li
                key={member.userId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2.5"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm text-foreground">
                    {member.name ?? member.email}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {member.email} · joined {member.joinedAt.slice(0, 10)}
                  </span>
                </span>

                {canManageRoles ? (
                  <select
                    aria-label={`Role for ${member.email}`}
                    value={member.role}
                    disabled={roleBusy !== null}
                    onChange={(event) =>
                      void changeRole(
                        member.userId,
                        event.target.value as MembershipRole,
                      )
                    }
                    className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground disabled:opacity-50"
                  >
                    {MEMBERSHIP_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {ROLE_LABELS[role]}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {ROLE_LABELS[member.role]}
                  </span>
                )}
              </li>
            ))}
          </ul>

          {roleError ? (
            <p role="alert" className="mt-3 text-xs text-destructive">
              {roleError}
            </p>
          ) : null}
          {roleMessage ? (
            <p role="status" className="mt-3 text-xs text-muted-foreground">
              {roleMessage}
            </p>
          ) : null}

          <p className="mt-3 text-[11px] text-muted-foreground">
            Inviting a member is not built yet: the organisation invite and the
            seat check are the next step.
          </p>
        </section>

        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-semibold text-foreground">AI services</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Both are optional. Without them Nuntia classifies with rules only
            and conversations have no topic. These keys belong to the workspace,
            so one key serves every member's classification and drafting, and
            the keys are encrypted at rest.{' '}
            {canManage ? '' : 'Only an owner or admin can change them.'}
          </p>

          {canManage ? (
            <form
              className="mt-3 space-y-3"
              onSubmit={(event) => void saveAi(event)}
            >
              <p className={statusClass}>
                {ai.jevConfigured
                  ? 'A Jev key is stored. Enter a new one to replace it.'
                  : 'Jev is not connected yet.'}
              </p>
              <Field label="Jev API key">
                <input
                  type="password"
                  value={jevApiKey}
                  disabled={clearJevKey}
                  placeholder={ai.jevConfigured ? '••••••••' : 'ts-...'}
                  onChange={(event) => setJevApiKey(event.target.value)}
                  autoComplete="off"
                  className={inputClass}
                />
              </Field>
              <Field label="Jev model" hint="Defaults to jev-latest.">
                <input
                  value={jevModel}
                  placeholder="jev-latest"
                  onChange={(event) => setJevModel(event.target.value)}
                  className={inputClass}
                />
              </Field>
              {ai.jevConfigured ? (
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={clearJevKey}
                    onChange={(event) => setClearJevKey(event.target.checked)}
                  />
                  Remove the stored Jev key
                </label>
              ) : null}

              <p className={statusClass}>
                {ai.llmConfigured
                  ? 'An LLM key is stored. Enter a new one to replace it.'
                  : 'The LLM is not connected yet.'}
              </p>
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
              <Field label="LLM API key">
                <input
                  type="password"
                  value={llmApiKey}
                  disabled={clearLlmKey || llmProvider === ''}
                  placeholder={ai.llmConfigured ? '••••••••' : 'sk-...'}
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
                hint={`${REPLY_DRAFT_MIN_IMPORTANCE_MIN} to ${REPLY_DRAFT_MIN_IMPORTANCE_MAX}. Every draft is one API call, so routine mail below this is left alone.`}
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
                  </span>{' '}
                  — one extra call after a send, which offers a follow-up when
                  the reply did not move the thread on.
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
                    Update goals and contact profiles automatically
                  </span>{' '}
                  — one extra call per thread that gains messages. Blank fields
                  are never cleared, and every change stays undoable from
                  Settings.
                </span>
              </label>
              {ai.llmConfigured ? (
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={clearLlmKey}
                    onChange={(event) => setClearLlmKey(event.target.checked)}
                  />
                  Remove the stored LLM key
                </label>
              ) : null}

              <button
                type="submit"
                disabled={aiBusy}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {aiBusy ? 'Saving…' : 'Save AI settings'}
              </button>
            </form>
          ) : (
            <dl className="mt-3 space-y-1 text-xs text-muted-foreground">
              <div>
                <dt className="inline text-foreground">Jev:</dt>{' '}
                {ai.jevConfigured ? 'connected' : 'not connected'}
              </div>
              <div>
                <dt className="inline text-foreground">LLM:</dt>{' '}
                {ai.llmConfigured
                  ? `${ai.llmProvider} · ${ai.llmModel ?? 'provider default'}`
                  : 'not connected'}
              </div>
              <div>
                <dt className="inline text-foreground">Drafts from:</dt>{' '}
                {ai.suggestReplyMinImportance}/10 importance
              </div>
            </dl>
          )}

          {aiError ? (
            <p
              role="alert"
              className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {aiError}
            </p>
          ) : null}
          {aiMessage ? (
            <p
              role="status"
              className="mt-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
            >
              {aiMessage}
            </p>
          ) : null}
        </section>
      </div>
    </div>
  )
}
