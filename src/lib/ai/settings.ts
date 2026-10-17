/**
 * AI service settings, stored in the database and edited from the UI.
 *
 * These are per-install secrets, not environment variables: the user sets them in
 * Settings, and the keys are encrypted at rest with the same AES-256-GCM envelope
 * as the OAuth refresh tokens. Nothing above this module sees ciphertext, and the
 * plaintext key only ever exists in memory while a client is being built.
 *
 * There is deliberately no `getAiSettings()` that returns keys. The UI reads a
 * *summary* (is it configured, which model) and never the secret itself.
 */

import { eq } from 'drizzle-orm'

import { db } from '#/db/index.ts'
import { appSettings } from '#/db/schema.ts'
import { encrypt, tryDecrypt } from '#/lib/auth/crypto.ts'
import {
  REPLY_DRAFT_MIN_IMPORTANCE_DEFAULT,
  REPLY_DRAFT_MIN_IMPORTANCE_MAX,
  REPLY_DRAFT_MIN_IMPORTANCE_MIN,
} from '#/lib/conversation/draft.ts'

import { DEFAULT_LLM_MODELS, LLM_PROVIDERS } from './llm.ts'
import type { LlmProvider } from './llm.ts'

/** The single settings row. */
const SETTINGS_ID = 'app'

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
}

/** Everything needed to build the pipeline, with keys decrypted in memory. */
export type AiPipelineConfig = {
  jev: { apiKey: string; model: string } | null
  llm: { provider: LlmProvider; apiKey: string; model: string } | null
  /** Same row, same read: the reply draft threshold travels with the keys. */
  suggestReplyMinImportance: number
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

type SettingsRow = typeof appSettings.$inferSelect

function settingsRow(): Promise<SettingsRow | undefined> {
  return db.query.appSettings.findFirst({
    where: eq(appSettings.id, SETTINGS_ID),
  })
}

function normaliseProvider(value: string | null | undefined): LlmProvider | null {
  if (!value) return null
  return (LLM_PROVIDERS as readonly string[]).includes(value)
    ? (value as LlmProvider)
    : null
}

/** Non-secret summary for the settings UI. */
export async function getAiSettings(): Promise<AiSettingsSummary> {
  const row = await settingsRow()
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
  }
}

/** Decrypted config for building the pipeline. Server-only. */
export async function getAiPipelineConfig(): Promise<AiPipelineConfig> {
  const row = await settingsRow()
  if (!row) {
    return {
      jev: null,
      llm: null,
      suggestReplyMinImportance: REPLY_DRAFT_MIN_IMPORTANCE_DEFAULT,
    }
  }

  const jevKey = tryDecrypt(row.jevApiKeyEncrypted)
  const llmKey = tryDecrypt(row.llmApiKeyEncrypted)
  const provider = normaliseProvider(row.llmProvider)

  return {
    suggestReplyMinImportance: normaliseMinImportance(
      row.suggestReplyMinImportance,
    ),
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

/** Upsert the settings row. */
export async function saveAiSettings(input: AiSettingsInput): Promise<void> {
  const current = await settingsRow()

  const values = {
    id: SETTINGS_ID,
    jevApiKeyEncrypted: applyKey(current?.jevApiKeyEncrypted ?? null, input.jevApiKey),
    jevModel: input.jevModel,
    llmProvider: input.llmProvider,
    llmModel: input.llmModel,
    suggestReplyMinImportance: normaliseMinImportance(
      input.suggestReplyMinImportance,
    ),
    llmApiKeyEncrypted: applyKey(
      current?.llmApiKeyEncrypted ?? null,
      input.llmApiKey,
    ),
    updatedAt: new Date(),
  }

  await db
    .insert(appSettings)
    .values(values)
    .onConflictDoUpdate({ target: appSettings.id, set: values })
}
