/**
 * The inbox list lives in the `_mailbox` layout.
 *
 * That layout renders the list on every mailbox URL, including an open thread, so
 * this route has nothing of its own to draw. It exists to give `/` a route in the
 * tree — without it the layout would only match the thread URLs.
 */
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_mailbox/')({
  component: MailboxIndex,
})

function MailboxIndex() {
  return null
}
