/**
 * Auth layer.
 *
 * `crypto.ts`  — AES-256-GCM token encryption at rest
 * `users.ts`   — people who sign in, password hashing, bootstrap
 * `session.ts` — server-side sessions: one revocable row per device
 * `oauth.ts`   — shared state + PKCE round trip
 * `google.ts`  — OAuth2 + PKCE against Google
 * `microsoft.ts` — OAuth2 + PKCE against Microsoft Graph
 * `accounts.ts`— mailboxes, scoped by owner; the only place tokens are decrypted
 */

export { decrypt, encrypt, tryDecrypt } from './crypto.ts'
export {
  createSession,
  destroySession,
  getSession,
  listSessions,
  revokeAllSessions,
} from './session.ts'
export type { SessionData } from './session.ts'
export {
  authenticateUser,
  bootstrapDefaultUser,
  countUsers,
  ensureBootstrapUser,
  getUser,
  registerUser,
} from './users.ts'
export type { PublicUser, RegisterInput } from './users.ts'
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
  assertOwnedAccount,
  deleteAccount,
  findAccountByEmail,
  getAccount,
  getAccountEnvelope,
  getDerivedVersion,
  getCursor,
  getLastSyncedAt,
  getPushExpiresAt,
  listAccounts,
  ownsAccount,
  setCursor,
  setDerivedVersion,
  setPushExpiresAt,
  upsertAccount,
} from './accounts.ts'
export type {
  CursorKind,
  StoredAccount,
  UpsertAccountInput,
} from './accounts.ts'
