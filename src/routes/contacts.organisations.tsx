/**
 * The organisations the address book knows, grouped by the domain people write
 * from.
 *
 * The directory answers "who is this person"; this answers "who are the people
 * at this company", which is the question the domain can answer without a stored
 * org row or a model guess. Everybody here is still one contact — the grouping is
 * only a reading of the same shared directory read.
 *
 * The description is the exception: a domain cannot say what a company does, so
 * that one line is stored. It is written by the user, or accepted by them after a
 * signature in the mail stated it — never inferred from the domain or from a job
 * title, and a mail-stated line waits here until they keep it.
 *
 * Search is a reading of the same read, not another one: it filters in the
 * browser, matches a company's name, domain or description against the whole
 * card, and matches a person's name, address or tags against that person's row
 * alone. A company hit keeps all its people; a person hit never drags in
 * colleagues who did not match.
 */

import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { createServerFn } from '@tanstack/react-start'
import {
  createFileRoute,
  Link,
  redirect,
  useRouter,
} from '@tanstack/react-router'
import { ChevronRight, Search, X } from 'lucide-react'

import { AppShell } from '#/components/app-shell.tsx'
import { ContactNav } from '#/components/contact-nav.tsx'
import { getSession } from '#/lib/auth/index.ts'
import { fetchContactDirectory } from '#/lib/contacts/directory.ts'
import type { ContactDirectoryItem } from '#/lib/contacts/directory.ts'
import { ORGANIZATION_FOCUS_LIMIT } from '#/lib/contacts/organization.ts'
import {
  acceptOrganizationFocusSuggestion,
  dismissOrganizationFocusSuggestion,
  listOrganizationRecords,
  setOrganizationFocus,
} from '#/lib/contacts/organization-store.ts'
import type { OrganizationRecord } from '#/lib/contacts/organization-store.ts'
import { cn } from '#/lib/utils'

const fetchOrganizationRecords = createServerFn({ method: 'GET' }).handler(
  async (): Promise<OrganizationRecord[]> => {
    const session = await getSession()
    if (!session) return []
    return [...(await listOrganizationRecords(session.userId)).values()]
  },
)

export const Route = createFileRoute('/contacts/organisations')({
  loader: async () => {
    const [payload, records] = await Promise.all([
      fetchContactDirectory(),
      fetchOrganizationRecords(),
    ])
    if (!payload.signedIn) throw redirect({ to: '/sign-in' })
    return { ...payload, records }
  },
  component: OrganisationsPage,
})

/** Every description action answers the same way, so one handler can run them. */
type FocusActionResult = { error: string | null }

const saveFocusAction = createServerFn({ method: 'POST' })
  .validator((data: { domain: string; focus: string }) => data)
  .handler(async ({ data }): Promise<FocusActionResult> => {
    const session = await getSession()
    if (!session) return { error: 'You are not signed in.' }

    const saved = await setOrganizationFocus(
      session.userId,
      data.domain,
      data.focus,
    )
    return { error: saved ? null : 'Could not save that description.' }
  })

const acceptFocusAction = createServerFn({ method: 'POST' })
  .validator((data: { domain: string }) => data)
  .handler(async ({ data }): Promise<FocusActionResult> => {
    const session = await getSession()
    if (!session) return { error: 'You are not signed in.' }

    const saved = await acceptOrganizationFocusSuggestion(
      session.userId,
      data.domain,
    )
    return { error: saved ? null : 'There is no suggestion left to keep.' }
  })

const dismissFocusAction = createServerFn({ method: 'POST' })
  .validator((data: { domain: string }) => data)
  .handler(async ({ data }): Promise<FocusActionResult> => {
    const session = await getSession()
    if (!session) return { error: 'You are not signed in.' }

    await dismissOrganizationFocusSuggestion(session.userId, data.domain)
    return { error: null }
  })

type OrganisationGroup = {
  domain: string
  name: string
  contacts: ContactDirectoryItem[]
  record: OrganizationRecord | null
}

function OrganisationsPage() {
  const data = Route.useLoaderData()
  const router = useRouter()
  /** The domain whose description is being edited, or null. */
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  /** One action at a time per card, so only that card says it is saving. */
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const searchRef = useRef<HTMLInputElement>(null)

  // `/` jumps to the search box, the same shortcut the directory uses. Skipped
  // while the user is already typing somewhere, so the character still works as
  // itself in the description field.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) {
        return
      }
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.isContentEditable ||
          ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      ) {
        return
      }
      event.preventDefault()
      searchRef.current?.focus()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  /** One group per domain, the way the directory derives them. */
  const groups = useMemo(() => {
    const records = new Map(
      data.records.map((record) => [record.domain, record]),
    )
    const byDomain = new Map<string, OrganisationGroup>()
    for (const contact of data.contacts) {
      if (!contact.organization) continue
      const existing = byDomain.get(contact.organization.domain)
      if (existing) {
        existing.contacts.push(contact)
      } else {
        byDomain.set(contact.organization.domain, {
          domain: contact.organization.domain,
          name: contact.organization.name,
          contacts: [contact],
          record: records.get(contact.organization.domain) ?? null,
        })
      }
    }
    return [...byDomain.values()].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    )
  }, [data.contacts, data.records])

  const grouped = groups.reduce(
    (total, group) => total + group.contacts.length,
    0,
  )

  const needle = deferredQuery.trim().toLowerCase()
  const filtering = needle.length > 0

  /**
   * Filter in the browser for the same reason the directory does: the address
   * book is already one read, and a round trip would trail the typing.
   *
   * A company name, domain or description matches the whole card — all of its
   * people. A person only matches their own row, so searching for a name in a
   * large company does not drag the other thirty people along.
   */
  const visibleGroups = useMemo(() => {
    if (needle.length === 0) return groups

    return groups.flatMap((group) => {
      const companyMatches = [
        group.name,
        group.domain,
        group.record?.focus,
        group.record?.suggestedFocus,
      ].some((value) => value?.toLowerCase().includes(needle))
      if (companyMatches) return [group]

      const contacts = group.contacts.filter((contact) =>
        [contact.name, contact.email, ...contact.tags].some((value) =>
          value?.toLowerCase().includes(needle),
        ),
      )
      return contacts.length > 0 ? [{ ...group, contacts }] : []
    })
  }, [groups, needle])

  /** Run one description change, then re-read the records from storage. */
  async function apply(domain: string, work: () => Promise<FocusActionResult>) {
    setPending(domain)
    setError(null)
    try {
      const result = await work()
      if (result.error) {
        setError(result.error)
        return
      }
      setEditing(null)
      await router.invalidate()
    } catch {
      setError('That change could not be saved.')
    } finally {
      setPending(null)
    }
  }

  return (
    <AppShell
      accounts={data.accounts}
      nav={<ContactNav active="organisations" />}
    >
      <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
        <header>
          <h1 className="text-2xl font-bold">Organisations</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {groups.length === 0 ? (
              'Companies group the people who share a mail domain. Personal mailboxes stay ungrouped.'
            ) : filtering ? (
              <>
                {visibleGroups.length} of {groups.length}{' '}
                {groups.length === 1 ? 'organisation' : 'organisations'} match.{' '}
                <button
                  type="button"
                  onClick={() => {
                    setQuery('')
                    searchRef.current?.focus()
                  }}
                  className="font-medium text-primary hover:underline"
                >
                  Clear
                </button>
              </>
            ) : (
              `${groups.length} ${groups.length === 1 ? 'organisation' : 'organisations'} holding ${grouped} of ${data.contacts.length} ${data.contacts.length === 1 ? 'person' : 'people'}. Grouped by the domain people write from; what a company does is noted by you.`
            )}
          </p>
        </header>

        <div className="mt-5 flex items-center gap-2 rounded-lg border border-border bg-card px-3 focus-within:ring-2 focus-within:ring-ring">
          <Search
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setQuery('')
            }}
            placeholder="Search by company, domain, person or tag"
            aria-label="Search organisations"
            className="h-10 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/70"
          />
          {query.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                setQuery('')
                searchRef.current?.focus()
              }}
              aria-label="Clear search"
              className="shrink-0 rounded-[4px] p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X aria-hidden="true" className="size-3.5" />
            </button>
          ) : (
            <kbd className="hidden shrink-0 rounded border border-border px-1.5 text-[10px] text-muted-foreground sm:block">
              /
            </kbd>
          )}
        </div>

        {groups.length === 0 ? (
          <p className="mt-6 rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
            No company addresses yet. People whose mail comes from a work domain
            appear here, grouped by that domain.
          </p>
        ) : visibleGroups.length === 0 ? (
          <p className="mt-6 rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
            No organisation matches that. Try a shorter company name, a domain
            or one of its people.
          </p>
        ) : (
          <ul className="mt-6 space-y-3">
            {visibleGroups.map((group) => (
              <li
                key={group.domain}
                className="overflow-hidden rounded-lg border border-border bg-card"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-sm font-semibold text-foreground">
                      {group.name}
                    </h2>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {group.domain}
                    </p>
                  </div>
                  <span className="text-[11px] text-muted-foreground">
                    {group.contacts.length}{' '}
                    {group.contacts.length === 1 ? 'person' : 'people'}
                  </span>
                </div>

                <div className="border-b border-border px-4 py-2.5">
                  {editing === group.domain ? (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault()
                        void apply(group.domain, () =>
                          saveFocusAction({
                            data: { domain: group.domain, focus: draft },
                          }),
                        )
                      }}
                      className="flex flex-wrap items-center gap-2"
                    >
                      <input
                        autoFocus
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        maxLength={ORGANIZATION_FOCUS_LIMIT}
                        placeholder="e.g. builds warehouse robots"
                        aria-label={`What ${group.name} does`}
                        className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                      <button
                        type="submit"
                        disabled={pending === group.domain}
                        className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditing(null)}
                        className="text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                      >
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <div className="flex flex-wrap items-baseline gap-2">
                      <p
                        className={cn(
                          'min-w-0 text-xs',
                          group.record?.focus
                            ? 'text-foreground'
                            : 'italic text-muted-foreground',
                        )}
                      >
                        {group.record?.focus ?? 'No description yet.'}
                      </p>
                      {group.record?.source === 'mail' ? (
                        <span
                          title="Accepted from a line in their mail"
                          className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground"
                        >
                          from mail
                        </span>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => {
                          setEditing(group.domain)
                          setDraft(group.record?.focus ?? '')
                        }}
                        className="ml-auto shrink-0 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                      >
                        Edit
                      </button>
                      {group.record?.focus ? (
                        <button
                          type="button"
                          disabled={pending === group.domain}
                          onClick={() =>
                            void apply(group.domain, () =>
                              saveFocusAction({
                                data: { domain: group.domain, focus: '' },
                              }),
                            )
                          }
                          className="shrink-0 text-[11px] font-medium text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
                        >
                          Clear
                        </button>
                      ) : null}
                    </div>
                  )}

                  {group.record?.suggestedFocus ? (
                    <div className="mt-2 rounded-md border border-border bg-muted/30 px-2.5 py-2">
                      <p className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground/70 uppercase">
                        From their mail
                      </p>
                      <p className="mt-0.5 text-xs text-foreground">
                        {group.record.suggestedFocus}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          disabled={pending === group.domain}
                          onClick={() =>
                            void apply(group.domain, () =>
                              acceptFocusAction({
                                data: { domain: group.domain },
                              }),
                            )
                          }
                          className="rounded-md bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground disabled:opacity-50"
                        >
                          Keep
                        </button>
                        <button
                          type="button"
                          disabled={pending === group.domain}
                          onClick={() =>
                            void apply(group.domain, () =>
                              dismissFocusAction({
                                data: { domain: group.domain },
                              }),
                            )
                          }
                          className="text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                        >
                          Dismiss
                        </button>
                        <span className="text-[10px] text-muted-foreground">
                          Not used as the description until you keep it.
                        </span>
                      </div>
                    </div>
                  ) : null}
                </div>

                <ul className="divide-y divide-border">
                  {group.contacts.map((contact) => (
                    <li key={contact.email}>
                      <Link
                        to="/contacts/$email"
                        params={{ email: contact.email }}
                        className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/40"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-foreground">
                            {contact.name ?? contact.email}
                          </span>
                          {contact.name ? (
                            <span className="block truncate text-[11px] text-muted-foreground">
                              {contact.email}
                            </span>
                          ) : null}
                          {contact.tags.length > 0 ? (
                            <span className="mt-1 flex flex-wrap items-center gap-1">
                              {contact.tags.map((tag) => (
                                <span
                                  key={tag}
                                  className="rounded-full border border-border bg-muted/40 px-1.5 py-0.5 text-[10.5px] text-muted-foreground"
                                >
                                  {tag}
                                </span>
                              ))}
                            </span>
                          ) : null}
                        </span>
                        <ChevronRight
                          aria-hidden="true"
                          className="size-4 shrink-0 text-muted-foreground"
                        />
                      </Link>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}

        {error ? (
          <p
            role="alert"
            className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}
      </div>
    </AppShell>
  )
}
