/**
 * `/admin` — the operator page.
 *
 * One page rather than a dashboard: five blocks that answer the beta's three
 * questions in the order they are asked. A non-operator gets a 404, not a 403 —
 * an operator page should not advertise itself to a beta user who guesses the
 * URL.
 *
 * Every server function below re-checks the gate. The loader protects the page;
 * a server function is a separate endpoint reachable without loading it.
 *
 * A code is only ever visible once, at creation, because only its hash is
 * stored. So the page shows the link in the response that made it, and offers
 * "new link" later — which mints a replacement rather than pretending an old
 * code can be recovered.
 */

import { createServerFn } from '@tanstack/react-start'
import {
  createFileRoute,
  notFound,
  useRouter,
} from '@tanstack/react-router'
import { useState } from 'react'

import { currentOperator } from '#/lib/admin/guard.ts'
import { loadAdminData } from '#/lib/admin/service.ts'
import type { AdminData } from '#/lib/admin/service.ts'
import { setFeedbackStatus } from '#/lib/feedback/repository.ts'
import {
  createInvite,
  deleteInvite,
  getInvite,
  revokeInvite,
} from '#/lib/invites/repository.ts'
import { inviteLink, notifyInvite } from '#/lib/invites/notify.ts'
import {
  approveRequest,
  declineRequest,
} from '#/lib/invites/requests.ts'
import { FEEDBACK_STATUSES } from '#/db/schema.ts'
import type { FeedbackStatus } from '#/db/schema.ts'

const loadAdminPage = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ allowed: false } | { allowed: true; data: AdminData }> => {
    const operator = await currentOperator()
    if (!operator) return { allowed: false }

    return { allowed: true, data: await loadAdminData() }
  },
)

/** Every operator action answers in this shape, so the page has one branch. */
type InviteActionReply = {
  error: string | null
  code: string | null
  link: string | null
  sent: boolean
  reason: string | null
}

const approveAction = createServerFn({ method: 'POST' })
  .validator((data: { requestId: string }) => data)
  .handler(async ({ data }): Promise<InviteActionReply> => {
    const operator = await currentOperator()
    if (!operator) {
      return { error: 'Not found.', code: null, link: null, sent: false, reason: null }
    }

    const result = await approveRequest(data.requestId, operator.userId)
    if (!result.ok) {
      return {
        error: result.error,
        code: null,
        link: null,
        sent: false,
        reason: null,
      }
    }

    return {
      error: null,
      code: result.invite.formattedCode,
      link: inviteLink(result.invite.code),
      sent: result.notify.sent,
      reason: result.notify.reason,
    }
  })

const declineAction = createServerFn({ method: 'POST' })
  .validator((data: { requestId: string; reason: string | null }) => data)
  .handler(async ({ data }) => {
    const operator = await currentOperator()
    if (!operator) return { error: 'Not found.' as const }

    const result = await declineRequest(
      data.requestId,
      operator.userId,
      data.reason,
    )

    return { error: result.ok ? null : result.error }
  })

const createInviteAction = createServerFn({ method: 'POST' })
  .validator(
    (data: { label: string | null; email: string | null; maxUses: number }) =>
      data,
  )
  .handler(async ({ data }): Promise<InviteActionReply> => {
    const operator = await currentOperator()
    if (!operator) {
      return { error: 'Not found.', code: null, link: null, sent: false, reason: null }
    }

    try {
      const invite = await createInvite({
        label: data.label,
        email: data.email,
        maxUses: data.maxUses,
        createdBy: operator.userId,
      })

      return {
        error: null,
        code: invite.formattedCode,
        link: inviteLink(invite.code),
        sent: false,
        reason: null,
      }
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : 'Could not create it.',
        code: null,
        link: null,
        sent: false,
        reason: null,
      }
    }
  })

const revokeAction = createServerFn({ method: 'POST' })
  .validator((data: { inviteId: string }) => data)
  .handler(async ({ data }) => {
    const operator = await currentOperator()
    if (!operator) return { error: 'Not found.' as const }

    const revoked = await revokeInvite(data.inviteId)
    return { error: revoked ? null : 'That invite no longer exists.' }
  })

const deleteAction = createServerFn({ method: 'POST' })
  .validator((data: { inviteId: string }) => data)
  .handler(async ({ data }) => {
    const operator = await currentOperator()
    if (!operator) return { error: 'Not found.' as const }

    const deleted = await deleteInvite(data.inviteId)
    return { error: deleted ? null : 'That invite no longer exists.' }
  })

/**
 * Mint a fresh code for an existing invite's address.
 *
 * A resend cannot reuse the old code — only its hash was ever stored — so the
 * honest operation is a replacement: the old invite is revoked and a new one is
 * sent.
 */
const newLinkAction = createServerFn({ method: 'POST' })
  .validator((data: { inviteId: string }) => data)
  .handler(async ({ data }): Promise<InviteActionReply> => {
    const operator = await currentOperator()
    if (!operator) {
      return { error: 'Not found.', code: null, link: null, sent: false, reason: null }
    }

    const existing = await getInvite(data.inviteId)
    if (!existing) {
      return {
        error: 'That invite no longer exists.',
        code: null,
        link: null,
        sent: false,
        reason: null,
      }
    }

    const replacement = await createInvite({
      label: existing.label,
      email: existing.email,
      maxUses: existing.maxUses,
      createdBy: operator.userId,
    })

    await revokeInvite(existing.id)

    if (!existing.email) {
      return {
        error: null,
        code: replacement.formattedCode,
        link: inviteLink(replacement.code),
        sent: false,
        reason: 'No address on the invite, so copy the link instead.',
      }
    }

    const notify = await notifyInvite({
      inviteId: replacement.id,
      code: replacement.code,
      to: existing.email,
      operatorId: operator.userId,
    })

    return {
      error: null,
      code: replacement.formattedCode,
      link: inviteLink(replacement.code),
      sent: notify.sent,
      reason: notify.reason,
    }
  })

const feedbackStatusAction = createServerFn({ method: 'POST' })
  .validator(
    (data: { id: string; status: FeedbackStatus; note: string | null }) => data,
  )
  .handler(async ({ data }) => {
    const operator = await currentOperator()
    if (!operator) return { error: 'Not found.' as const }

    const updated = await setFeedbackStatus(data.id, data.status, data.note)
    return { error: updated ? null : 'That feedback no longer exists.' }
  })

export const Route = createFileRoute('/admin/')({
  loader: async () => {
    const state = await loadAdminPage()
    if (!state.allowed) throw notFound()

    return { data: state.data }
  },
  component: AdminPage,
})

function AdminPage() {
  const { data } = Route.useLoaderData()
  const router = useRouter()

  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [created, setCreated] = useState<{
    code: string
    link: string
    sent?: boolean
    reason?: string | null
  } | null>(null)

  const [label, setLabel] = useState('')
  const [email, setEmail] = useState('')
  const [uses, setUses] = useState(1)

  const refresh = async () => {
    await router.invalidate()
  }

  async function onApprove(requestId: string) {
    setError(null)
    const result = await approveAction({ data: { requestId } })
    if (result.error) {
      setError(result.error)
      return
    }
    setCreated({
      code: result.code ?? '',
      link: result.link ?? '',
      sent: result.sent,
      reason: result.reason,
    })
    await refresh()
  }

  async function onDecline(requestId: string) {
    const reason = window.prompt('Why? (stored, never sent)') ?? null
    const result = await declineAction({ data: { requestId, reason } })
    if (result.error) setError(result.error)
    await refresh()
  }

  async function onCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)

    const result = await createInviteAction({
      data: {
        label: label.trim() || null,
        email: email.trim() || null,
        maxUses: uses,
      },
    })

    if (result.error) {
      setError(result.error)
      return
    }

    setCreated({ code: result.code ?? '', link: result.link ?? '' })
    setLabel('')
    setEmail('')
    setUses(1)
    await refresh()
  }

  async function onNewLink(inviteId: string) {
    setError(null)
    const result = await newLinkAction({ data: { inviteId } })
    if (result.error) {
      setError(result.error)
      return
    }
    setCreated({
      code: result.code ?? '',
      link: result.link ?? '',
      sent: result.sent,
      reason: result.reason,
    })
    await refresh()
  }

  return (
    <div className="mx-auto max-w-5xl p-8">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-bold">Nuntia beta</h1>
        <div className="flex items-baseline gap-4 text-xs">
          <a
            href="/admin/forms"
            className="text-primary hover:underline"
          >
            Forms
          </a>
          <a href="/" className="text-muted-foreground hover:underline">
            Back to the app
          </a>
        </div>
      </header>

      {error ? (
        <p
          role="alert"
          className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      {created ? (
        <div className="mt-4 rounded-md border border-border bg-muted/40 p-3 text-sm">
          <p className="font-medium">
            {created.sent ? 'Link created and emailed.' : 'Link created.'}
          </p>
          <p className="mt-1 font-mono text-xs">{created.code}</p>
          <p className="mt-1 break-all font-mono text-xs">{created.link}</p>
          {!created.sent && created.reason ? (
            <p className="mt-1 text-xs text-muted-foreground">{created.reason}</p>
          ) : null}
          <p className="mt-2 text-xs text-muted-foreground">
            Stored encrypted and hashed — Copy link in the list below shows it
            again.
          </p>
        </div>
      ) : null}

      <section className="mt-8">
        <h2 className="text-sm font-semibold">Funnel</h2>
        <div className="mt-2 grid grid-cols-3 gap-2 text-sm md:grid-cols-6">
          {(
            [
              ['Requested', data.funnel.requested],
              ['Approved', data.funnel.approved],
              ['Redeemed', data.funnel.redeemed],
              ['Activated', data.funnel.activated],
              ['Used', data.funnel.used],
              ['Returned', data.funnel.returned],
            ] as const
          ).map(([labelText, value]) => (
            <div key={labelText} className="rounded-md border border-border p-2">
              <div className="text-xs text-muted-foreground">{labelText}</div>
              <div className="text-lg font-semibold">{value}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold">
          Requests{' '}
          <span className="font-normal text-muted-foreground">
            ({data.requests.filter((row) => row.status === 'pending').length}{' '}
            pending)
          </span>
        </h2>

        <div className="mt-2 space-y-2">
          {data.requests.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing yet.</p>
          ) : null}

          {data.requests.map((request) => (
            <article
              key={request.id}
              className="rounded-md border border-border p-3 text-sm"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <span className="font-medium">{request.email}</span>
                  {request.name ? (
                    <span className="text-muted-foreground"> · {request.name}</span>
                  ) : null}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {request.createdAt.toLocaleDateString()}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {request.status}
                  {request.source ? ` · ${request.source}` : ''}
                </span>
              </div>

              <p className="mt-2 whitespace-pre-wrap text-muted-foreground">
                {request.note}
              </p>

              {request.status === 'pending' ? (
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => void onApprove(request.id)}
                    className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
                  >
                    Approve and email
                  </button>
                  <button
                    onClick={() => void onDecline(request.id)}
                    className="rounded-md border border-border px-3 py-1 text-xs"
                  >
                    Decline
                  </button>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold">Invites</h2>

        <form onSubmit={(event) => void onCreate(event)} className="mt-2 space-y-2">
          <div className="flex flex-wrap gap-2">
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Who it is for"
              className="min-w-48 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            />
            <input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="Email (optional, locks it)"
              className="min-w-48 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            />
            <input
              type="number"
              min={1}
              max={100}
              value={uses}
              onChange={(event) => setUses(Number(event.target.value))}
              className="w-20 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            />
            <button
              type="submit"
              className="rounded-md border border-border px-3 py-1.5 text-sm"
            >
              Create invite
            </button>
          </div>
        </form>

        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="py-1 pr-3">Label</th>
                <th className="py-1 pr-3">Email</th>
                <th className="py-1 pr-3">Redeemed</th>
                <th className="py-1 pr-3">Activated</th>
                <th className="py-1 pr-3">State</th>
                <th className="py-1">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.invites.map((invite) => (
                <tr key={invite.id} className="border-t border-border">
                  <td className="py-1 pr-3">{invite.label ?? '—'}</td>
                  <td className="py-1 pr-3">{invite.email ?? 'open'}</td>
                  <td className="py-1 pr-3">
                    {invite.redeemed}/{invite.maxUses}
                  </td>
                  <td className="py-1 pr-3">{invite.activated}</td>
                  <td className="py-1 pr-3">
                    {invite.revokedAt
                      ? 'revoked'
                      : invite.expiresAt &&
                          invite.expiresAt.getTime() <= Date.now()
                        ? 'expired'
                        : invite.notifiedAt
                          ? 'sent'
                          : invite.notifyError
                            ? 'send failed'
                            : 'issued'}
                  </td>
                  <td className="py-1 whitespace-nowrap">
                    {/* The code is stored encrypted as well as hashed, so the
                        link can be handed over again without minting a new
                        one. Older invites (created before the key was set)
                        have no code and only offer a replacement. */}
                    {invite.link ? (
                      <button
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(invite.link!)
                            setCopied(invite.id)
                          } catch {
                            setError(
                              'The browser refused the clipboard — use New link and copy it from there.',
                            )
                          }
                        }}
                        className="text-xs text-primary hover:underline"
                      >
                        {copied === invite.id ? 'Copied' : 'Copy link'}
                      </button>
                    ) : null}
                    <button
                      onClick={() => void onNewLink(invite.id)}
                      className="ml-3 text-xs text-primary hover:underline"
                    >
                      New link
                    </button>
                    {!invite.revokedAt ? (
                      <button
                        onClick={async () => {
                          const result = await revokeAction({
                            data: { inviteId: invite.id },
                          })
                          if (result.error) setError(result.error)
                          await refresh()
                        }}
                        className="ml-3 text-xs text-muted-foreground hover:underline"
                      >
                        Revoke
                      </button>
                    ) : null}
                    <button
                      onClick={async () => {
                        if (
                          !window.confirm(
                            'Delete this invite? Its redemptions disappear from the funnel too.',
                          )
                        ) {
                          return
                        }

                        const result = await deleteAction({
                          data: { inviteId: invite.id },
                        })
                        if (result.error) setError(result.error)
                        await refresh()
                      }}
                      className="ml-3 text-xs text-destructive hover:underline"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold">People</h2>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="py-1 pr-3">Person</th>
                <th className="py-1 pr-3">Role</th>
                <th className="py-1 pr-3">Mailboxes</th>
                <th className="py-1 pr-3">Threads</th>
                <th className="py-1 pr-3">Last active</th>
              </tr>
            </thead>
            <tbody>
              {data.people.map((person) => (
                <tr key={person.id} className="border-t border-border">
                  <td className="py-1 pr-3">{person.id}</td>
                  <td className="py-1 pr-3">{person.role}</td>
                  <td className="py-1 pr-3">{person.mailboxes}</td>
                  <td className="py-1 pr-3">{person.threads}</td>
                  <td className="py-1 pr-3">
                    {person.lastActiveAt
                      ? person.lastActiveAt.toLocaleDateString()
                      : 'never'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold">AI activity</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Every call to Jev or the topic model, newest last. A failure the rules
          paper over is recorded here too, which is what makes &ldquo;the AI did
          nothing&rdquo; answerable. Operator-only: the records carry no user id,
          so this cannot be scoped to one person.
        </p>

        {data.aiLog.events.length === 0 ? (
          <p className="mt-3 text-xs text-muted-foreground">
            Nothing logged yet. Sync or re-analyse a conversation.
          </p>
        ) : (
          <ul className="mt-3 space-y-1">
            {data.aiLog.events.map((event, index) => (
              <li
                key={`${event.at}-${index}`}
                className={
                  event.outcome === 'ok'
                    ? 'flex items-baseline gap-2 text-[11px] text-muted-foreground'
                    : 'flex items-baseline gap-2 text-[11px] text-destructive'
                }
              >
                <time dateTime={event.at} className="shrink-0">
                  {event.at.slice(11, 19)}
                </time>
                <span className="shrink-0 font-medium">{event.service}</span>
                <span className="shrink-0">
                  {event.outcome}
                  {event.status ? ` ${event.status}` : ''}
                </span>
                {event.model ? (
                  <span className="shrink-0 text-muted-foreground/70">
                    {event.model}
                  </span>
                ) : null}
                {event.detail ? (
                  <span className="min-w-0 truncate">{event.detail}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        <p className="mt-3 text-[11px] text-muted-foreground">
          Full history: <code>{data.aiLog.path}</code>
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold">Feedback</h2>
        <div className="mt-2 space-y-2">
          {data.feedback.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing yet.</p>
          ) : null}

          {data.feedback.map((row) => (
            <article
              key={row.id}
              className="rounded-md border border-border p-3 text-sm"
            >
              <div className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  {row.email ?? row.userId}
                  {row.rating ? ` · ${row.rating}/5` : ''}
                </span>
                <span>{row.createdAt.toLocaleDateString()}</span>
              </div>
              <p className="mt-1 whitespace-pre-wrap">{row.message}</p>
              {row.context ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {row.context}
                </p>
              ) : null}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <select
                  value={row.status}
                  onChange={async (event) => {
                    const result = await feedbackStatusAction({
                      data: {
                        id: row.id,
                        status: event.target.value as FeedbackStatus,
                        note: null,
                      },
                    })
                    if (result.error) setError(result.error)
                    await refresh()
                  }}
                  className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                >
                  {FEEDBACK_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}
