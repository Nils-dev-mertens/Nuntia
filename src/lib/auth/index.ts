/**
 * Auth layer.
 *
 * `crypto.ts`  — AES-256-GCM token encryption at rest
 * `session.ts` — HMAC-signed cookie holding only an account id
 * `google.ts`  — OAuth2 + PKCE against Google
 * `accounts.ts`— persistence, the only place tokens are decrypted
 */

export { decrypt, encrypt, tryDecrypt } from './crypto.ts'
export { clearSession, getSession, setSession } from './session.ts'
export type { SessionData } from './session.ts'
export {
  buildAuthUrl,
  createGmailClient,
  decryptRefreshToken,
  encryptRefreshToken,
  exchangeCode,
  fetchProfile,
  readState,
  readVerifier,
  SCOPES,
} from './google.ts'
export type { TokenResult } from './google.ts'
export {
  deleteAccount,
  getAccount,
  getAccountEnvelope,
  getDerivedVersion,
  getHistoryId,
  getLastSyncedAt,
  listAccounts,
  setDerivedVersion,
  setHistoryId,
  upsertAccount,
} from './accounts.ts'
export type { StoredAccount, UpsertAccountInput } from './accounts.ts'