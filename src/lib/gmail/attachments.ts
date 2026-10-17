/**
 * Attachment cache.
 *
 * Attachments live in Gmail, not in our database — we store a path to a local
 * copy and fetch on demand. This module owns that copy: writing files safely,
 * keeping them out of the way of user-supplied filenames, and never downloading
 * something absurdly large without a caller asking.
 */

import { mkdir, rm, writeFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve, sep } from 'node:path'

import type { GmailAttachmentRef } from './message.ts'
import type { GmailClient } from './client.ts'

/**
 * Default ceiling for a single attachment.
 *
 * Without this, one 40MB video would be pulled into a local-first app nobody
 * asked to be a file manager. Callers can raise it deliberately.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

/** Root for the local cache, alongside the SQLite file. */
export function cacheRoot(): string {
  return (
    process.env.ATTACHMENT_CACHE_DIR ??
    resolve(process.cwd(), 'data/attachments')
  )
}

/**
 * Reduce a user-supplied filename to something safe to write.
 *
 * Mail filenames are attacker-controlled: they can contain `../`, absolute
 * paths, NUL bytes, or Windows reserved device names like `CON`. Everything that
 * is not a plain filename character is replaced, and the result is capped.
 */
export function safeFilename(name: string): string {
  // Strip any directory component, using both separators.
  const base = name.split(/[/\\]/).pop() ?? 'attachment'

  // Remove NUL and control characters.
  // eslint-disable-next-line no-control-regex
  let out = base.replace(/[\u0000-\u001f\u007f]/g, '')

  // Keep only characters that are safe across platforms.
  out = out.replace(/[<>:"|?*]/g, '_')

  // Windows reserves these regardless of extension.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(out)) {
    out = `_${out}`
  }

  // "." and ".." would escape or alias the directory.
  if (out === '.' || out === '..') out = 'attachment'

  out = out.trim()

  // Keep the extension so the OS knows how to open it.
  if (out.length > 120) {
    const dot = out.lastIndexOf('.')
    const ext = dot > 0 ? out.slice(dot).slice(0, 12) : ''
    out = out.slice(0, 120 - ext.length) + ext
  }

  return out || 'attachment'
}

/**
 * Directory one attachment's file is cached in.
 *
 * Keyed on the Gmail attachment id rather than the filename, so two different
 * attachments with the same name do not collide and overwrite each other.
 *
 * The id is hashed rather than used verbatim because its real length is around a
 * thousand characters — it is an opaque token, not a name. Used as a path segment
 * it exceeds what Windows will open (`mkdir` fails with ENOENT on a path past
 * MAX_PATH, which is what happened on the first real download), and a digest
 * keeps the key unique, deterministic, and short.
 */
function attachmentDir(accountId: string, ref: GmailAttachmentRef): string {
  const key = createHash('sha1')
    .update(ref.attachmentId)
    .digest('hex')
    .slice(0, 20)

  return join(cacheRoot(), safeAccountSegment(accountId), key)
}

/** Path an attachment is cached at, if already downloaded. */
export function attachmentPath(
  accountId: string,
  ref: GmailAttachmentRef,
): string {
  return join(attachmentDir(accountId, ref), safeFilename(ref.filename))
}

/** Keep account ids from escaping the cache directory. */
function safeAccountSegment(accountId: string): string {
  return safeFilename(accountId)
}

/**
 * Delete every cached file for one account.
 *
 * Called when a mailbox is disconnected: the rows are gone with it, and without
 * this the downloaded files would sit in the cache with nothing referring to
 * them. Containment is checked the same way as on write, so a crafted account id
 * cannot point this at another directory.
 */
export async function removeAttachmentCache(accountId: string): Promise<void> {
  const dir = join(cacheRoot(), safeAccountSegment(accountId))

  if (!isInside(dir, cacheRoot())) {
    throw new Error(`Refusing to delete outside the cache root: ${dir}`)
  }

  await rm(dir, { recursive: true, force: true })
}

/** True when the attachment is already on disk. */
export async function isCached(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

export type DownloadResult =
  | { status: 'cached'; path: string }
  | { status: 'downloaded'; path: string; bytes: number }
  | { status: 'skipped'; reason: 'too-large'; sizeBytes: number }
  | { status: 'missing' }

/**
 * Download an attachment into the local cache.
 *
 * Idempotent: an already-cached file is not re-fetched. The resolved path is
 * checked to be inside the cache root before anything is written, so a crafted
 * filename cannot escape it even if `safeFilename` missed something.
 */
export async function downloadAttachment(
  client: GmailClient,
  accountId: string,
  messageId: string,
  ref: GmailAttachmentRef,
  opts: { maxBytes?: number } = {},
): Promise<DownloadResult> {
  const maxBytes = opts.maxBytes ?? MAX_ATTACHMENT_BYTES

  // Skip before spending a request when Gmail already told us the size.
  if (ref.sizeBytes > maxBytes) {
    return { status: 'skipped', reason: 'too-large', sizeBytes: ref.sizeBytes }
  }

  const path = attachmentPath(accountId, ref)

  if (await isCached(path)) return { status: 'cached', path }

  let payload: { data: string; size: number }
  try {
    payload = await client.getAttachment(messageId, ref.attachmentId)
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'GmailNotFoundError' ||
        error.name === 'GmailRateLimitError')
    ) {
      // Transient or gone — not a sync failure. The attachment row simply stays
      // without a local path and can be retried on the next sync.
      return { status: 'missing' }
    }
    throw error
  }

  if (!payload.data) return { status: 'missing' }

  const bytes = Buffer.from(
    payload.data.replace(/-/g, '+').replace(/_/g, '/'),
    'base64',
  )

  // Gmail does not always report size accurately, so re-check after decoding.
  if (bytes.byteLength > maxBytes) {
    return {
      status: 'skipped',
      reason: 'too-large',
      sizeBytes: bytes.byteLength,
    }
  }

  const dir = attachmentDir(accountId, ref)

  // Final containment check before writing anything.
  if (!isInside(dir, cacheRoot())) {
    throw new Error(
      `Refusing to write attachment outside the cache root: ${dir}`,
    )
  }

  await mkdir(dir, { recursive: true })
  await writeFile(path, bytes)

  return { status: 'downloaded', path, bytes: bytes.byteLength }
}

/** True when `candidate` resolves to a path inside `root`. */
function isInside(candidate: string, root: string): boolean {
  const resolvedRoot = resolve(root)
  const resolvedCandidate = resolve(candidate)
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(resolvedRoot + sep)
  )
}

/**
 * A stable id for an attachment row.
 *
 * Content-addressed so re-syncing the same attachment updates rather than
 * duplicating.
 */
export function attachmentRowId(
  accountId: string,
  gmailThreadId: string,
  gmailMessageId: string,
  ref: GmailAttachmentRef,
): string {
  const hash = createHash('sha1')
    .update(`${gmailThreadId}:${gmailMessageId}:${ref.attachmentId}`)
    .digest('hex')
    .slice(0, 12)

  return `${accountId}:${gmailThreadId}:${hash}`
}
