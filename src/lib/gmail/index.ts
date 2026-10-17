/**
 * Gmail integration.
 *
 * `client.ts` defines the narrow interface sync depends on; `sync.ts` is the
 * orchestration; `message.ts` converts Gmail's wire format into the same
 * `ParsedMessage` the rest of the app already uses.
 */

export type {
  AttachmentPayload,
  GmailClient,
  GmailMessage,
  GmailPart,
  GmailThread,
  HistoryPage,
  ThreadListPage,
} from './client.ts'

export {
  createGmailApiClient,
  GmailAuthError,
  GmailNotFoundError,
  GmailRateLimitError,
  wrapGmailError,
} from './client.ts'

export {
  decodeGmailData,
  isDraft,
  isTrashed,
  toAttachmentRefs,
  toParsedMessage,
} from './message.ts'
export type { GmailAttachmentRef } from './message.ts'

export { backfill, sync, syncIncremental } from './sync.ts'
export type {
  SyncEvent,
  SyncOptions,
  SyncProgress,
  SyncResult,
} from './sync.ts'

export {
  attachmentPath,
  attachmentRowId,
  downloadAttachment,
  isCached,
  MAX_ATTACHMENT_BYTES,
  removeAttachmentCache,
  safeFilename,
} from './attachments.ts'
export type { DownloadResult } from './attachments.ts'

export { DEFAULT_STALE_AFTER_MS, isCursorStale } from './freshness.ts'

export { BACKFILL_QUERY, forgetAccount, loadInbox } from './service.ts'
export type {
  ConversationSummary,
  InboxPayload,
  LoadInboxOptions,
} from './service.ts'
