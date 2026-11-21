/**
 * The folders a thread can be filed in.
 *
 * Provider labels decide most of these on every sync — Gmail's `SPAM` and
 * `TRASH` are the mailbox's own answer, and a thread with no `INBOX` label is
 * archived — while a matching spam rule can move inbox mail to spam without the
 * provider knowing. Keeping the vocabulary in one client-safe module lets the
 * schema, the sync layer and the sidebar agree on the same four values.
 */

export const MAIL_FOLDERS = ['inbox', 'archive', 'trash', 'spam'] as const

export type MailFolder = (typeof MAIL_FOLDERS)[number]

export function isMailFolder(value: unknown): value is MailFolder {
  return typeof value === 'string' && MAIL_FOLDERS.includes(value as MailFolder)
}

/** The words the sidebar and folder headings use. */
export const FOLDER_LABELS: Record<MailFolder, string> = {
  inbox: 'Inbox',
  archive: 'Archive',
  trash: 'Deleted',
  spam: 'Spam',
}
