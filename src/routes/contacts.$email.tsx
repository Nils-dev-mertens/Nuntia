/**
 * One correspondent, seen as a whole.
 *
 * A thread view can only show the messages in that thread, which is a poor place
 * to understand a relationship that spans months of mail. This page collects the
 * short description the context updater maintains and every stored thread the
 * address appears on, so the user can see the relationship and its history in one
 * place.
 *
 * The one thing edited here is the user's own tags for the person: they belong
 * to how the user files a contact rather than to what the mail says, so this is
 * where they can be changed without opening a thread. The notes themselves are
 * still edited from the thread overview, where the mail that supports them is on
 * screen.
 */

import { useState } from 'react'
import { createServerFn } from '@tanstack/react-start'
import {
  createFileRoute,
  Link,
  redirect,
  useRouter,
} from '@tanstack/react-router'
import { Plus, X } from 'lucide-react'

import { AppShell } from '#/components/app-shell.tsx'
import { ContactNav } from '#/components/contact-nav.tsx'
import { getSession, listAccounts } from '#/lib/auth/index.ts'
import { getContactContext } from '#/lib/contacts/context.ts'
import type { ContactContext } from '#/lib/contacts/context.ts'
import { contactContextDescription } from '#/lib/contacts/description.ts'
import { contactNamesFor } from '#/lib/contacts/index.ts'
import { listContactThreads } from '#/lib/contacts/history.ts'
import type { ContactThread } from '#/lib/contacts/history.ts'
import { normaliseContactEmail } from '#/lib/contacts/matching.ts'
import { getContactTags, setContactTag } from '#/lib/contacts/tags.ts'
import { listStateLabels } from '#/lib/organization/store.ts'
import type { StateLabels } from '#/lib/organization/labels.ts'
import { STATE_META } from '#/lib/conversation-state'
import { cn } from '#/lib/utils'

type ConnectedAccount = { id: string; email: string }

type ContactPageData =
  | { signedIn: false }
  | { signedIn: true; found: false; accounts: ConnectedAccount[] }
  | {
      signedIn: true
      found: true
      email: string
      name: string | null
      context: ContactContext | null
      threads: ContactThread[]
      /** The user's own tags for this person, in display order. */
      tags: string[]
      stateLabels: StateLabels
      accounts: ConnectedAccount[]
    }

const fetchContact = createServerFn({ method: 'GET' })
  .validator((data: { email: string }) => data)
  .handler(async ({ data }): Promise<ContactPageData> => {
    const session = await getSession()
    if (!session) return { signedIn: false }

    const accounts = (await listAccounts(session.userId)).map((account) => ({
      id: account.id,
      email: account.email,
    }))
    const email = normaliseContactEmail(data.email)
    if (!email) return { signedIn: true, found: false, accounts }

    const [context, threads, names, stateLabels, tags] = await Promise.all([
      getContactContext(session.userId, email),
      listContactThreads(session.userId, email),
      contactNamesFor(accounts.map((account) => account.id)),
      listStateLabels(session.userId),
      getContactTags(session.userId, email),
    ])

    return {
      signedIn: true,
      found: true,
      email,
      name: names.get(email) ?? null,
      context,
      threads,
      tags,
      stateLabels,
      accounts,
    }
  })

/**
 * Add or remove one of the user's own tags for this contact.
 *
 * No revision log and no reversal: a tag is the user's own word, not something
 * the app inferred, so removing it is itself the undo. Returning the list
 * rather than only an error means the chips render exactly what storage holds —
 * including when a case-only duplicate was refused and nothing changed.
 */
const setContactTagAction = createServerFn({ method: 'POST' })
  .validator((data: { email: string; tag: string; present: boolean }) => data)
  .handler(
    async ({ data }): Promise<{ error: string | null; tags: string[] }> => {
      const session = await getSession()
      if (!session) return { error: 'Not signed in.', tags: [] }

      const tags = await setContactTag(
        session.userId,
        data.email,
        data.tag,
        data.present,
      )
      // The only refusal: not a tag at all, or too long for a chip.
      if (!tags) return { error: 'A tag is 1–32 characters.', tags: [] }

      return { error: null, tags }
    },
  )

export const Route = createFileRoute('/contacts/$email')({
  loader: async ({ params }) => {
    // Path params are normally decoded already; decoding again leaves a plain
    // address untouched and rescues a link built with a raw `@` escape.
    let email = params.email
    try {
      email = decodeURIComponent(email)
    } catch {
      // A malformed escape is still the user's best guess at the address.
    }
    const payload = await fetchContact({ data: { email } })
    // Without a user there is no relationship to show, the same reason the
    // inbox redirects rather than rendering an empty page.
    if (!payload.signedIn) throw redirect({ to: '/sign-in' })
    return payload
  },
  component: ContactPage,
})

/** One or two letters for the avatar; the page does not need the full helper. */
function initialsOf(name: string | null, email: string): string {
  const words = (name ?? '')
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0)
  if (words.length > 0) {
    const first = words[0]?.at(0) ?? ''
    const last = words.length > 1 ? (words.at(-1)?.at(0) ?? '') : ''
    return (first + last).toUpperCase()
  }
  return (email.split('@')[0] ?? email).slice(0, 2).toUpperCase()
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(iso))
}

/**
 * The user's tags for this person, and the only field on this page they write.
 *
 * Kept apart from the context fields on purpose: those say what the app
 * understands and are written from the mail, while a tag says how the user files
 * the person. Mixing them would suggest a refresh could touch a tag, which it
 * never does.
 */
function ContactTags({
  email,
  initialTags,
}: {
  email: string
  initialTags: string[]
}) {
  const router = useRouter()
  const [tags, setTags] = useState(initialTags)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function change(tag: string, present: boolean) {
    setPending(true)
    setError(null)
    try {
      const result = await setContactTagAction({
        data: { email, tag, present },
      })
      if (result.error) {
        setError(result.error)
        return
      }
      setTags(result.tags)
      setDraft('')
      // The directory lists tags too, so its loader has to re-run.
      await router.invalidate()
    } catch {
      setError('Could not save that tag.')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 py-0.5 pr-1 pl-2 text-[11px] text-foreground"
          >
            {tag}
            <button
              type="button"
              onClick={() => {
                void change(tag, false)
              }}
              disabled={pending}
              aria-label={`Remove tag ${tag}`}
              className="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              <X aria-hidden="true" className="size-3" />
            </button>
          </span>
        ))}
        <form
          onSubmit={(event) => {
            event.preventDefault()
            const tag = draft.trim()
            if (tag.length === 0) return
            void change(tag, true)
          }}
          className="inline-flex items-center gap-1"
        >
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Add a tag"
            aria-label="Add a tag"
            maxLength={32}
            className="h-6 w-28 rounded-[4px] border border-border bg-transparent px-2 text-[11px] text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="submit"
            disabled={pending || draft.trim().length === 0}
            className="inline-flex items-center gap-0.5 rounded-[4px] px-1.5 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
          >
            <Plus aria-hidden="true" className="size-3" />
            Add
          </button>
        </form>
      </div>
      {error ? (
        <p className="mt-1 text-[11px] text-destructive">{error}</p>
      ) : null}
    </div>
  )
}

function ContactPage() {
  const data = Route.useLoaderData()

  if (!data.found) {
    return (
      <AppShell accounts={data.accounts} nav={<ContactNav active="contact" />}>
        <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6">
          <h1 className="text-2xl font-bold">Contact not found</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            That address is not a contact in this mailbox.
          </p>
          <Link
            to="/"
            className="mt-4 inline-flex text-sm font-medium text-primary hover:underline"
          >
            Back to inbox
          </Link>
        </div>
      </AppShell>
    )
  }

  const context = data.context
  const description = contactContextDescription(context)
  const initials = initialsOf(data.name, data.email)

  return (
    <AppShell
      accounts={data.accounts}
      nav={<ContactNav active="contact" email={data.email} />}
    >
      <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
        <header className="flex items-start gap-4">
          <span
            aria-hidden="true"
            className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary"
          >
            {initials}
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-2xl font-bold">
              {data.name ?? data.email}
            </h1>
            {data.name ? (
              <p className="truncate text-sm text-muted-foreground">
                {data.email}
              </p>
            ) : null}
            <p className="mt-3 max-w-2xl whitespace-pre-wrap text-sm text-foreground">
              {description ??
                'No relationship description yet. It is written from the mail when automatic context updates are on.'}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              {context?.roleCompany ? (
                <span className="rounded-full border border-border px-2 py-0.5">
                  {context.roleCompany}
                </span>
              ) : null}
              {context && context.importance !== null ? (
                <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-medium text-primary">
                  Importance · {context.importance}/10
                </span>
              ) : null}
              <span>
                {data.threads.length}{' '}
                {data.threads.length === 1 ? 'thread' : 'threads'}
              </span>
            </div>
          </div>
        </header>

        <ContactTags email={data.email} initialTags={data.tags} />

        {context && (context.topics || context.currentWork) ? (
          <dl className="mt-6 grid gap-4 rounded-lg border border-border bg-card p-4 sm:grid-cols-2">
            {context.topics ? (
              <div>
                <dt className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                  Topics discussed
                </dt>
                <dd className="mt-1 whitespace-pre-wrap text-xs text-foreground">
                  {context.topics}
                </dd>
              </div>
            ) : null}
            {context.currentWork ? (
              <div>
                <dt className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                  Currently working on
                </dt>
                <dd className="mt-1 whitespace-pre-wrap text-xs text-foreground">
                  {context.currentWork}
                </dd>
              </div>
            ) : null}
          </dl>
        ) : null}

        <section className="mt-8">
          <h2 className="text-sm font-semibold text-foreground">All threads</h2>
          {data.threads.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              No stored threads with this address yet.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-border rounded-lg border border-border bg-card">
              {data.threads.map((thread) => (
                <li key={`${thread.accountId}:${thread.providerThreadId}`}>
                  <Link
                    to="/conversations/$providerThreadId"
                    params={{ providerThreadId: thread.providerThreadId }}
                    className="flex items-start justify-between gap-4 px-4 py-3 transition-colors hover:bg-muted/40"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        {thread.unread ? (
                          <span
                            aria-label="Unread"
                            className="size-1.5 shrink-0 rounded-full bg-primary"
                          />
                        ) : null}
                        <span className="truncate text-sm font-medium text-foreground">
                          {thread.subject}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {thread.topic ?? 'No topic yet'}
                        {thread.messageCount > 0
                          ? ` · ${thread.messageCount} ${thread.messageCount === 1 ? 'message' : 'messages'}`
                          : null}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1 text-[11px] text-muted-foreground">
                      <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                        <span
                          aria-hidden="true"
                          className={cn(
                            'size-1.5 rounded-full',
                            STATE_META[thread.state].dotClass,
                          )}
                        />
                        {data.stateLabels[thread.state].name}
                      </span>
                      {thread.done ? <span>Done</span> : null}
                      <time dateTime={thread.lastMessageAt}>
                        {formatDate(thread.lastMessageAt)}
                      </time>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </AppShell>
  )
}
