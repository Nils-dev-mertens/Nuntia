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
}

/** Everything needed to build the pipeline, with keys decrypted in memory. */
export type AiPipelineConfig = {
  jev: { apiKey: string; model: string } | null
  llm: { provider: LlmProvider; apiKey: string; model: string } | null
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
  }
}

/** Decrypted config for building the pipeline. Server-only. */
export async function getAiPipelineConfig(): Promise<AiPipelineConfig> {
  const row = await settingsRow()
  if (!row) return { jev: null, llm: null }

  const jevKey = tryDecrypt(row.jevApiKeyEncrypted)
  const llmKey = tryDecrypt(row.llmApiKeyEncrypted)
  const provider = normaliseProvider(row.llmProvider)

  return {
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
