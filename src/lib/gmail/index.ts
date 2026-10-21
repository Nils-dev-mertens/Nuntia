/**
 * Gmail integration.
 *
 * `client.ts` defines the narrow interface sync depends on; `sync.ts` is the
 * orchestration; `message.ts` converts Gmail's wire format into the same
 * `ParsedMessage` the rest of the app already uses.
 */

export type {
  AttachmentPayload,
  MailboxClient,
  GmailMessage,
  GmailPart,
  GmailThread,
  HistoryPage,
  ThreadListPage,
} from '#/lib/gmail/client.ts'

export {
  createGmailApiClient,
  GmailAuthError,
  GmailNotFoundError,
  GmailRateLimitError,
  wrapGmailError,
} from '#/lib/gmail/client.ts'

export {
  decodeGmailData,
  isDraft,
  isTrashed,
  toAttachmentRefs,
  toParsedMessage,
} from '#/lib/mailbox/message.ts'
export type { GmailAttachmentRef } from '#/lib/mailbox/message.ts'

export { backfill, sync, syncIncremental } from '#/lib/mailbox/sync.ts'
export type {
  SyncEvent,
  SyncOptions,
  SyncProgress,
  SyncResult,
} from '#/lib/mailbox/sync.ts'

export {
  attachmentPath,
  attachmentRowId,
  downloadAttachment,
  isCached,
  MAX_ATTACHMENT_BYTES,
  removeAttachmentCache,
  safeFilename,
} from '#/lib/gmail/attachments.ts'
export type { DownloadResult } from '#/lib/gmail/attachments.ts'

export { DEFAULT_STALE_AFTER_MS, isCursorStale } from './freshness.ts'

export {
  BACKFILL_QUERY,
  forgetAccount,
  loadInbox,
} from '#/lib/gmail/service.ts'
export type {
  ConversationSummary,
  InboxPayload,
  LoadInboxOptions,
} from '#/lib/gmail/service.ts'
