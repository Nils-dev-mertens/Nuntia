import { describe, expect, test } from 'bun:test'

import type { GmailMessage, GmailPart } from './client.ts'
import { findAttachmentPart } from './message.ts'

/** One leaf part, shaped the way `toGmailPart` leaves a real attachment. */
function attachmentPart(args: {
  partId: string
  filename: string | null
  mimeType: string
  attachmentId: string
  size: number
  contentId?: string
}): GmailPart {
  return {
    partId: args.partId,
    mimeType: args.mimeType,
    filename: args.filename,
    headers: {
      'x-attachment-id': args.attachmentId,
      'x-attachment-size': String(args.size),
      ...(args.contentId ? { 'content-id': `<${args.contentId}>` } : {}),
    },
    children: [],
  }
}

/** A message carrying the given attachment parts. */
function message(id: string, parts: GmailPart[]): GmailMessage {
  return {
    id,
    threadId: 't1',
    labelIds: ['INBOX'],
    internalDate: '1700000000000',
    snippet: '',
    payload: {
      partId: '',
      mimeType: 'multipart/mixed',
      filename: null,
      headers: {},
      children: parts,
    },
  }
}

const PHOTO = {
  filename: 'IMG_1234.jpg',
  mimeType: 'image/jpeg',
  sizeBytes: 4096,
  isInline: false,
  contentId: null,
}

describe('findAttachmentPart', () => {
  test('uses the recorded id when it is still current', () => {
    const messages = [
      message('m1', [
        attachmentPart({
          partId: '1',
          filename: PHOTO.filename,
          mimeType: PHOTO.mimeType,
          attachmentId: 'current-id',
          size: PHOTO.sizeBytes,
        }),
      ]),
    ]

    const found = findAttachmentPart(messages, {
      ...PHOTO,
      gmailAttachmentId: 'current-id',
    })

    expect(found?.messageId).toBe('m1')
    expect(found?.ref.attachmentId).toBe('current-id')
  })

  test('recovers a part whose attachment id Gmail has since changed', () => {
    // The reason this exists: Gmail does not promise attachment ids are stable,
    // so a stored id can be stale long before the user opens the file. Keying the
    // lookup on it alone returned nothing and the download 404'd.
    const messages = [
      message('m1', [
        attachmentPart({
          partId: '1',
          filename: PHOTO.filename,
          mimeType: PHOTO.mimeType,
          attachmentId: 'fresh-id',
          size: PHOTO.sizeBytes,
        }),
      ]),
    ]

    const found = findAttachmentPart(messages, {
      ...PHOTO,
      gmailAttachmentId: 'stale-id-from-yesterday',
    })

    expect(found?.ref.attachmentId).toBe('fresh-id')
  })

  test('tells two same-named files apart by their Content-ID', () => {
    // Two copies of the same photo in one thread is real, and for an inline image
    // the Content-ID is the only thing that distinguishes them.
    const messages = [
      message('m1', [
        attachmentPart({
          partId: '1',
          filename: 'inline',
          mimeType: 'image/png',
          attachmentId: 'a1',
          size: 100,
          contentId: 'logo',
        }),
        attachmentPart({
          partId: '2',
          filename: 'inline',
          mimeType: 'image/png',
          attachmentId: 'a2',
          size: 100,
          contentId: 'screenshot',
        }),
      ]),
    ]

    const found = findAttachmentPart(messages, {
      gmailAttachmentId: 'stale',
      filename: 'inline',
      mimeType: 'image/png',
      sizeBytes: 100,
      isInline: true,
      contentId: 'screenshot',
    })

    expect(found?.ref.attachmentId).toBe('a2')
  })

  test('tells two same-named files apart by their size', () => {
    const messages = [
      message('m1', [
        attachmentPart({
          partId: '1',
          filename: 'report.pdf',
          mimeType: 'application/pdf',
          attachmentId: 'small',
          size: 1024,
        }),
        attachmentPart({
          partId: '2',
          filename: 'report.pdf',
          mimeType: 'application/pdf',
          attachmentId: 'large',
          size: 8192,
        }),
      ]),
    ]

    const found = findAttachmentPart(messages, {
      gmailAttachmentId: 'stale',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 8192,
      isInline: false,
      contentId: null,
    })

    expect(found?.ref.attachmentId).toBe('large')
  })

  test('finds the part in whichever message of the thread holds it', () => {
    const messages = [
      message('m1', []),
      message('m2', [
        attachmentPart({
          partId: '1',
          filename: PHOTO.filename,
          mimeType: PHOTO.mimeType,
          attachmentId: 'att',
          size: PHOTO.sizeBytes,
        }),
      ]),
    ]

    const found = findAttachmentPart(messages, {
      ...PHOTO,
      gmailAttachmentId: 'stale',
    })

    expect(found?.messageId).toBe('m2')
  })

  test('returns null when the thread no longer carries the part', () => {
    const messages = [
      message('m1', [
        attachmentPart({
          partId: '1',
          filename: 'other.pdf',
          mimeType: 'application/pdf',
          attachmentId: 'att',
          size: 10,
        }),
      ]),
    ]

    expect(
      findAttachmentPart(messages, { ...PHOTO, gmailAttachmentId: 'stale' }),
    ).toBeNull()
  })
})
