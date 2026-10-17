/**
 * Serve one email attachment.
 *
 * A route rather than a server function: the result is a file, and a plain URL
 * is what gives the browser something it can open in a tab, save, or hand to the
 * OS. The bytes come from Gmail on the first request and from the local cache
 * afterwards, so `loadAttachment` does the work and this only picks a status.
 */

import { createFileRoute } from '@tanstack/react-router'

import { getSession } from '#/lib/auth/index.ts'
import { safeFilename } from '#/lib/gmail/attachments.ts'
import { loadAttachment } from '#/lib/gmail/service.ts'

function textResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}

export const Route = createFileRoute('/attachments/$attachmentId')({
  server: {
    handlers: {
      GET: async ({ request, params }): Promise<Response> => {
        const session = await getSession()
        if (!session) return textResponse('You are not signed in.', 401)

        // The attachment is only unique within its thread, so the thread travels
        // with the request.
        const gmailThreadId = new URL(request.url).searchParams.get('thread')
        if (!gmailThreadId) {
          return textResponse(
            'Missing the thread this attachment belongs to.',
            400,
          )
        }

        const result = await loadAttachment(gmailThreadId, params.attachmentId)

        if (!result.ok) {
          if (result.reason === 'too-large') {
            return textResponse(
              'That attachment is too large to open here. It is still in Gmail.',
              413,
            )
          }
          if (result.reason === 'not-connected') {
            return textResponse(
              'Reconnect this mailbox to Google to open its attachments.',
              409,
            )
          }
          return textResponse('That attachment is no longer available.', 404)
        }

        // A filename reaches this header from the sender, so it is reduced to
        // something no header can be broken with, and offered twice: an ASCII
        // fallback for old clients and RFC 5987 form for the real name.
        const filename = result.file.filename || 'attachment'
        const asciiName = safeFilename(filename)

        return new Response(new Uint8Array(result.file.bytes), {
          status: 200,
          headers: {
            'content-type': result.file.mimeType || 'application/octet-stream',
            'content-length': String(result.file.bytes.byteLength),
            // `inline` so an image or a PDF opens in a tab; the name is what the
            // browser uses when the user chooses to save it.
            'content-disposition': `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
            'cache-control': 'private, max-age=3600',
          },
        })
      },
    },
  },
})
