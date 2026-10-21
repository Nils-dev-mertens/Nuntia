/**
 * Attachment uploads from the composer.
 *
 * The browser hands over base64 and a filename, and neither is trusted: a reply
 * and a new message go through the same checks so the limits cannot drift apart.
 * The decoded bytes are what the provider adapters receive.
 */

import { MAX_ATTACHMENT_BYTES, safeFilename } from '#/lib/gmail/attachments.ts'

/** How many files one message may carry. */
const MAX_ATTACHMENTS = 10

/** Combined ceiling, leaving room for MIME/base64 overhead. */
const MAX_ATTACHMENT_BYTES_TOTAL = 18 * 1024 * 1024

export type AttachmentUpload = {
  filename: string
  contentType: string
  /** Standard base64-encoded bytes from the composer. */
  data: string
}

/** Raised when an upload cannot be sent; the message is shown verbatim. */
export class AttachmentUploadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AttachmentUploadError'
  }
}

/** Detect control characters without embedding them in a regular expression. */
function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((char) => {
    const code = char.codePointAt(0) ?? 0
    return code < 32 || code === 127
  })
}

/**
 * Validate and decode untrusted file uploads before composing a message.
 *
 * `noun` is only for the wording — "per reply" versus "per message" — because
 * the limit itself is identical for both.
 */
export function decodeAttachmentUploads(
  uploads: AttachmentUpload[],
  noun: 'reply' | 'message',
): Array<{ filename: string; contentType: string; data: Uint8Array }> {
  if (uploads.length > MAX_ATTACHMENTS) {
    throw new AttachmentUploadError(
      `Attach no more than ${MAX_ATTACHMENTS} files per ${noun}.`,
    )
  }

  let totalBytes = 0
  return uploads.map((upload) => {
    if (
      typeof upload.filename !== 'string' ||
      !upload.filename.trim() ||
      upload.filename.length > 255 ||
      hasControlCharacter(upload.filename)
    ) {
      throw new AttachmentUploadError('An attachment has an invalid filename.')
    }
    if (
      typeof upload.data !== 'string' ||
      upload.data.length > Math.ceil(MAX_ATTACHMENT_BYTES_TOTAL / 3) * 4 ||
      upload.data.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        upload.data,
      )
    ) {
      throw new AttachmentUploadError('An attachment could not be read.')
    }

    const data = Uint8Array.from(Buffer.from(upload.data, 'base64'))
    if (data.byteLength === 0) {
      throw new AttachmentUploadError('Empty attachments cannot be sent.')
    }
    if (data.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentUploadError(
        `${upload.filename} exceeds the 25 MB per-file limit.`,
      )
    }

    totalBytes += data.byteLength
    if (totalBytes > MAX_ATTACHMENT_BYTES_TOTAL) {
      throw new AttachmentUploadError('Attachments must total 18 MB or less.')
    }

    const contentType =
      typeof upload.contentType === 'string' &&
      /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(upload.contentType)
        ? upload.contentType.toLowerCase()
        : 'application/octet-stream'

    return {
      filename: safeFilename(upload.filename),
      contentType,
      data,
    }
  })
}
