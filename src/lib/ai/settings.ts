/**
 * AI service settings, stored in the database and edited from the UI.
 *
 * These are the **workspace's** settings, not one person's: a key is a company
 * purchase, and the model choice and reply threshold follow the work rather than
 * the person doing it. They are encrypted at rest with the same AES-256-GCM
 * envelope as the OAuth refresh tokens, and an owner or admin edits them from
 * `/organisation`.
 *
 * Every function still takes a user id, and resolves the workspace from it. That
 * is deliberate: a caller cannot name a workspace it is not in, so the browser
 * has nothing to tamper with, and the pipeline a sync builds for a member is
 * built for their workspace without a second parameter threaded through the
 * sync path.
 *
 * There is deliberately no `getAiSettings()` that returns keys. The UI reads a
 * *summary* (is it configured, which model) and never the secret itself.
 */

import { eq } from 'drizzle-orm'

import { db } from '#/db/index.ts'
import { organizationAiSettings } from '#/db/schema.ts'
import { encrypt, tryDecrypt } from '#/lib/auth/crypto.ts'
import {
  REPLY_DRAFT_MIN_IMPORTANCE_DEFAULT,
  REPLY_DRAFT_MIN_IMPORTANCE_MAX,
  REPLY_DRAFT_MIN_IMPORTANCE_MIN,
} from '#/lib/conversation/draft.ts'
import { ensureWorkspace } from '#/lib/organization/workspace.ts'

import { DEFAULT_LLM_MODELS, LLM_PROVIDERS } from './llm.ts'
import type { LlmProvider } from './llm.ts'

export type AiSettingsSummary = {
  /** A Jev key is stored (regardless of whether it still decrypts). */
  jevConfigured: boolean
  jevModel: string | null
  llmConfigured: boolean
  llmProvider: LlmProvider | null
  llmModel: string | null
  /**
   * Importance at or above which a reply draft is offered, 1–10.
   *
   * Part of the summary rather than of the decrypted config because it is not a
   * secret and the conversation view needs it: the draft control explains itself
   * with the number it was compared against.
   */
  suggestReplyMinImportance: number
  /**
   * Whether a sent reply is judged against the thread's goal.
   *
   * Part of the summary so the settings form shows the stored answer rather than
   * re-deriving it from "an LLM is configured".
   */
  goalCheckEnabled: boolean
  /**
   * Whether the app refreshes the thread's goal and the contact profile.
   *
   * Part of the summary so the form shows the stored answer rather than
   * inferring "on" from an LLM being configured: the key and the switch are two
   * different decisions.
   */
  autoContextEnabled: boolean
}

export type AiSettingsInput = {
  jevModel: string | null
  llmProvider: LlmProvider | null
  llmModel: string | null
  /**
   * New key. `undefined`/`null` leaves the stored key unchanged, `''` clears it,
   * anything else replaces it (encrypted).
   */
  jevApiKey?: string | null
  llmApiKey?: string | null
  suggestReplyMinImportance: number
  /** Omitted leaves the stored answer alone; new rows default to on. */
  goalCheckEnabled?: boolean
  /** Omitted leaves the stored answer alone; new rows default to off. */
  autoContextEnabled?: boolean
}

/** Everything needed to build the pipeline, with keys decrypted in memory. */
export type AiPipelineConfig = {
  jev: { apiKey: string; model: string } | null
  llm: { provider: LlmProvider; apiKey: string; model: string } | null
  /** Same row, same read: the reply draft threshold travels with the keys. */
  suggestReplyMinImportance: number
  /** Omitted means on, so an older settings row keeps the check enabled. */
  goalCheckEnabled?: boolean
  /**
   * Omitted means off. The updater writes user-owned fields, so a row written
   * before this column existed must not start rewriting profiles unasked.
   */
  autoContextEnabled?: boolean
}

/**
 * Clamp a stored threshold into the range the score it compares against uses.
 *
 * Read defensively: a row written by an older build, a hand-edited database or a
 * bad import should never be able to make every draft eligible (0) or none of
 * them (11+).
 */
export function normaliseMinImportance(
  value: number | null | undefined,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return REPLY_DRAFT_MIN_IMPORTANCE_DEFAULT
  }
  const rounded = Math.round(value)
  return Math.min(
    REPLY_DRAFT_MIN_IMPORTANCE_MAX,
    Math.max(REPLY_DRAFT_MIN_IMPORTANCE_MIN, rounded),
  )
}

type SettingsRow = typeof organizationAiSettings.$inferSelect

async function settingsRow(userId: string): Promise<SettingsRow | undefined> {
  const workspace = await ensureWorkspace(userId)
  if (!workspace) return undefined

  return db.query.organizationAiSettings.findFirst({
    where: eq(organizationAiSettings.organizationId, workspace.organizationId),
  })
}

function normaliseProvider(
  value: string | null | undefined,
): LlmProvider | null {
  if (!value) return null
  return (LLM_PROVIDERS as readonly string[]).includes(value)
    ? (value as LlmProvider)
    : null
}

/** Non-secret summary for the settings UI, for one member's workspace. */
export async function getAiSettings(
  userId: string,
): Promise<AiSettingsSummary> {
  const row = await settingsRow(userId)
  const provider = normaliseProvider(row?.llmProvider)

  return {
    jevConfigured: Boolean(row?.jevApiKeyEncrypted),
    jevModel: row?.jevModel ?? null,
    llmProvider: provider,
    llmModel: row?.llmModel ?? null,
    // A provider with no key, or a key with no provider, is not configured.
    llmConfigured: Boolean(row?.llmApiKeyEncrypted && provider),
    suggestReplyMinImportance: normaliseMinImportance(
      row?.suggestReplyMinImportance,
    ),
    // A row written before the column existed reads as on, which is the default
    // the migration itself wrote.
    goalCheckEnabled: row?.goalCheckEnabled ?? true,
    // Off when absent: a row from before the column existed must not begin
    // spending calls on a feature nobody turned on.
    autoContextEnabled: row?.autoContextEnabled ?? false,
  }
}

/** Decrypted config for building the pipeline. Server-only. */
export async function getAiPipelineConfig(
  userId: string,
): Promise<AiPipelineConfig> {
  const row = await settingsRow(userId)
  if (!row) {
    return {
      jev: null,
      llm: null,
      suggestReplyMinImportance: REPLY_DRAFT_MIN_IMPORTANCE_DEFAULT,
      goalCheckEnabled: true,
      autoContextEnabled: false,
    }
  }

  const jevKey = tryDecrypt(row.jevApiKeyEncrypted)
  const llmKey = tryDecrypt(row.llmApiKeyEncrypted)
  const provider = normaliseProvider(row.llmProvider)

  return {
    suggestReplyMinImportance: normaliseMinImportance(
      row.suggestReplyMinImportance,
    ),
    goalCheckEnabled: row.goalCheckEnabled,
    autoContextEnabled: row.autoContextEnabled,
    jev: jevKey
      ? { apiKey: jevKey, model: row.jevModel?.trim() || 'jev-latest' }
      : null,
    llm:
      provider && llmKey
        ? {
            provider,
            apiKey: llmKey,
            model: row.llmModel?.trim() || DEFAULT_LLM_MODELS[provider],
          }
        : null,
  }
}

/** Replace or clear one stored key. */
function applyKey(
  current: string | null,
  next: string | null | undefined,
): string | null {
  if (next === undefined || next === null) return current
  const trimmed = next.trim()
  if (!trimmed) return null
  return encrypt(trimmed)
}

/**
 * Upsert the workspace's settings row.
 *
 * Throws when the member has no workspace, which only happens for a user row
 * that does not exist — the caller's session is proof enough that something is
 * wrong for it to be reported rather than silently dropped.
 */
export async function saveAiSettings(
  userId: string,
  input: AiSettingsInput,
): Promise<void> {
  const workspace = await ensureWorkspace(userId)
  if (!workspace) throw new Error('No workspace for this user.')

  const organizationId = workspace.organizationId
  const current = await db.query.organizationAiSettings.findFirst({
    where: eq(organizationAiSettings.organizationId, organizationId),
  })

  const values = {
    organizationId,
    jevApiKeyEncrypted: applyKey(
      current?.jevApiKeyEncrypted ?? null,
      input.jevApiKey,
    ),
    jevModel: input.jevModel,
    llmProvider: input.llmProvider,
    llmModel: input.llmModel,
    suggestReplyMinImportance: normaliseMinImportance(
      input.suggestReplyMinImportance,
    ),
    goalCheckEnabled:
      input.goalCheckEnabled ?? current?.goalCheckEnabled ?? true,
    autoContextEnabled:
      input.autoContextEnabled ?? current?.autoContextEnabled ?? false,
    llmApiKeyEncrypted: applyKey(
      current?.llmApiKeyEncrypted ?? null,
      input.llmApiKey,
    ),
    updatedAt: new Date(),
  }

  await db.insert(organizationAiSettings).values(values).onConflictDoUpdate({
    target: organizationAiSettings.organizationId,
    set: values,
  })
}
