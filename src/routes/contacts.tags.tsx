/**
 * The tag vocabulary, on a screen of its own.
 *
 * Settings gives every subject its own panel, and the tags earn the same
 * treatment: the directory answers "who is this person", this answers "what does
 * this word mean, and is it still worth keeping". The description is the part
 * that makes the second question answerable — a tag added a year ago can be read
 * as what it was meant for instead of guessed at — and rename and delete sit
 * beside it because both apply to every contact carrying the word.
 */

import { useEffect, useRef, useState } from 'react'
import { createServerFn } from '@tanstack/react-start'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { Sparkles } from 'lucide-react'

import { AppShell } from '#/components/app-shell.tsx'
import { ContactNav } from '#/components/contact-nav.tsx'
import { getAiPipelineConfig } from '#/lib/ai/settings.ts'
import { getSession, listAccounts } from '#/lib/auth/index.ts'
import { suggestContactTagDescription } from '#/lib/contacts/tag-ai.ts'
// The limits come from the pure module, not the tag store: this file renders, so
// a constant imported from `tags.ts` would drag the database (and `file:` SQL)
// into the browser bundle. Only the server functions may import the store.
import {
  CONTACT_TAG_LIMITS,
  tagDescriptionNeedsRefresh,
} from '#/lib/contacts/tag-name.ts'
import {
  autoDraftNewTag,
  refreshStaleTagDescriptions,
  suggestNewTags,
} from '#/lib/contacts/tag-refresh.ts'
import {
  createContactTag,
  deleteContactTag,
  listContactTagHistory,
  listContactTagSummary,
  renameContactTag,
  setContactTagDescription,
} from '#/lib/contacts/tags.ts'
import type {
  ContactTagChange,
  ContactTagSummary,
} from '#/lib/contacts/tags.ts'

type ConnectedAccount = { id: string; email: string }

type TagsPageData =
  | { signedIn: false }
  | {
      signedIn: true
      /** Every tag in use, with how widely it is used and what it means. */
      tags: ContactTagSummary[]
      /**
       * How many app-written descriptions the tag's changes have outrun.
       *
       * Counted by the loader, which stays a read: the drafts are asked for once
       * the page is on screen, because a model call can take seconds and must
       * not hold up a render.
       */
      staleDescriptions: number
      accounts: ConnectedAccount[]
    }

const fetchTags = createServerFn({ method: 'GET' }).handler(
  async (): Promise<TagsPageData> => {
    const session = await getSession()
    if (!session) return { signedIn: false }

    const [tags, accounts] = await Promise.all([
      listContactTagSummary(session.userId),
      listAccounts(session.userId),
    ])

    return {
      signedIn: true,
      tags,
      staleDescriptions: tags.filter((entry) =>
        tagDescriptionNeedsRefresh({
          source: entry.descriptionSource,
          lastChangeAt: entry.lastChangeAt,
          updatedAt: entry.updatedAt,
          contacts: entry.contacts,
        }),
      ).length,
      accounts: accounts.map((account) => ({
        id: account.id,
        email: account.email,
      })),
    }
  },
)

/**
 * What every mutation returns: the whole list, so the page renders what storage
 * holds rather than the draft it sent.
 */
type TagMutationResult = { error: string | null; tags: ContactTagSummary[] }

const renameTagAction = createServerFn({ method: 'POST' })
  .validator((data: { from: string; to: string }) => data)
  .handler(async ({ data }): Promise<TagMutationResult> => {
    const session = await getSession()
    if (!session) return { error: 'You are not signed in.', tags: [] }

    const tags = await renameContactTag(session.userId, data.from, data.to)
    if (!tags) return { error: 'A tag is 1–32 characters.', tags: [] }

    return { error: null, tags }
  })

const deleteTagAction = createServerFn({ method: 'POST' })
  .validator((data: { tag: string }) => data)
  .handler(async ({ data }): Promise<TagMutationResult> => {
    const session = await getSession()
    if (!session) return { error: 'You are not signed in.', tags: [] }

    return {
      error: null,
      tags: await deleteContactTag(session.userId, data.tag),
    }
  })

const setTagDescriptionAction = createServerFn({ method: 'POST' })
  .validator((data: { tag: string; description: string }) => data)
  .handler(async ({ data }): Promise<TagMutationResult> => {
    const session = await getSession()
    if (!session) return { error: 'You are not signed in.', tags: [] }

    const tags = await setContactTagDescription(
      session.userId,
      data.tag,
      data.description,
    )
    if (!tags) {
      return {
        error: `A description is at most ${CONTACT_TAG_LIMITS.description} characters.`,
        tags: [],
      }
    }

    return { error: null, tags }
  })

/** Add a word to the vocabulary, before anyone carries it. */
const createTagAction = createServerFn({ method: 'POST' })
  .validator((data: { tag: string }) => data)
  .handler(async ({ data }): Promise<TagMutationResult> => {
    const session = await getSession()
    if (!session) return { error: 'You are not signed in.', tags: [] }

    const tags = await createContactTag(session.userId, data.tag)
    if (!tags) return { error: 'A tag is 1–32 characters.', tags: [] }

    // A new word with no sentence is the case this screen exists to fix, so the
    // draft is asked for straight away. A failure is silent: the tag is created
    // either way, and Improve is still there to retry.
    return {
      error: null,
      tags: (await autoDraftNewTag(session.userId, data.tag)) ?? tags,
    }
  })

/**
 * Draft what a tag means, for the user to review and save.
 *
 * Nothing is written here: the draft lands in the row's own field, and the Save
 * beside it is still the only thing that reaches storage.
 */
const suggestTagDescriptionAction = createServerFn({ method: 'POST' })
  .validator((data: { tag: string; current: string }) => data)
  .handler(
    async ({
      data,
    }): Promise<{ suggestion: string | null; error: string | null }> => {
      const session = await getSession()
      if (!session) return { suggestion: null, error: 'You are not signed in.' }

      try {
        const config = await getAiPipelineConfig(session.userId)
        if (!config.llm) {
          return {
            suggestion: null,
            error:
              'Configure an LLM provider in AI settings to have a description drafted.',
          }
        }

        const suggestion = await suggestContactTagDescription(config.llm, {
          tag: data.tag,
          current: data.current.trim() || null,
          examples: [],
        })
        return { suggestion, error: null }
      } catch (error) {
        return {
          suggestion: null,
          error:
            error instanceof Error
              ? error.message
              : 'Could not draft a description.',
        }
      }
    },
  )

/** Read one tag's full change log, when the row asks for it. */
const tagHistoryAction = createServerFn({ method: 'POST' })
  .validator((data: { tag: string }) => data)
  .handler(
    async ({
      data,
    }): Promise<{ changes: ContactTagChange[]; error: string | null }> => {
      const session = await getSession()
      if (!session) return { changes: [], error: 'You are not signed in.' }

      return {
        changes: await listContactTagHistory(session.userId, data.tag),
        error: null,
      }
    },
  )

/**
 * Ask for tags the address book does not have yet.
 *
 * Proposals only: nothing is created until the user adds one, which is also what
 * keeps a model from quietly growing the vocabulary.
 */
const suggestTagsAction = createServerFn({ method: 'POST' }).handler(
  async (): Promise<{ suggestions: string[]; error: string | null }> => {
    const session = await getSession()
    if (!session) return { suggestions: [], error: 'You are not signed in.' }

    try {
      const config = await getAiPipelineConfig(session.userId)
      if (!config.llm) {
        return {
          suggestions: [],
          error:
            'Configure an LLM provider in AI settings to have tags suggested.',
        }
      }

      return {
        suggestions: await suggestNewTags(session.userId, config.llm),
        error: null,
      }
    } catch (error) {
      return {
        suggestions: [],
        error:
          error instanceof Error ? error.message : 'Could not suggest tags.',
      }
    }
  },
)

/** Rewrite the app's own descriptions where the tag has changed since. */
const refreshTagDescriptionsAction = createServerFn({ method: 'POST' }).handler(
  async (): Promise<{ tags: ContactTagSummary[]; updated: number }> => {
    const session = await getSession()
    if (!session) return { tags: [], updated: 0 }
    return refreshStaleTagDescriptions(session.userId)
  },
)

export const Route = createFileRoute('/contacts/tags')({
  loader: async () => {
    const payload = await fetchTags()
    if (!payload.signedIn) throw redirect({ to: '/sign-in' })
    return payload
  },
  component: TagsPage,
})

/** A day, not a time: the log is a history, and the hour never matters. */
function formatDay(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(date)
}

function TagsPage() {
  const data = Route.useLoaderData()
  const router = useRouter()
  const [tags, setTags] = useState(data.tags)
  /** Per-row rename draft, keyed by the tag being edited; absent means unchanged. */
  const [renames, setRenames] = useState<Record<string, string | undefined>>({})
  /** Per-row description draft, same convention. */
  const [descriptions, setDescriptions] = useState<
    Record<string, string | undefined>
  >({})
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  /** The name being typed into the add field. */
  const [newTag, setNewTag] = useState('')
  /** Which row is waiting on a draft, so only that row says "Drafting…". */
  const [improving, setImproving] = useState<string | null>(null)
  /** Set by the refresh's cleanup, so a late answer cannot overwrite newer state. */
  const cancelled = useRef(false)
  /** The row whose log is open, if any. */
  const [openHistory, setOpenHistory] = useState<string | null>(null)
  /** Logs already read, keyed by tag, so reopening one costs nothing. */
  const [history, setHistory] = useState<
    Record<string, ContactTagChange[] | undefined>
  >({})
  const [loadingHistory, setLoadingHistory] = useState<string | null>(null)
  /** Words the app proposed and the user has not added yet. */
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [suggesting, setSuggesting] = useState(false)

  /**
   * Bring the app's own descriptions up to date once the page is open.
   *
   * The loader only counted them; drafting here means the list renders first and
   * the updated rows arrive with a message saying they changed. Text the user
   * wrote is never in this set — the rule that decides is pure and shared.
   */
  useEffect(() => {
    if (data.staleDescriptions === 0) return
    cancelled.current = false

    void (async () => {
      try {
        const result = await refreshTagDescriptionsAction()
        if (cancelled.current || result.updated === 0) return
        setTags(result.tags)
        setMessage(
          `${result.updated} ${result.updated === 1 ? 'description was' : 'descriptions were'} updated from recent changes.`,
        )
      } catch {
        // The page still shows the text it has; Improve is the manual retry.
      }
    })()

    return () => {
      cancelled.current = true
    }
  }, [data.staleDescriptions])

  /**
   * One mutation at a time for the whole page: the list is small, and a rename
   * landing halfway through a description save would make the rows disagree with
   * each other.
   */
  async function apply(
    work: () => Promise<TagMutationResult>,
    done: string,
    failure: string,
  ) {
    setPending(true)
    setError(null)
    setMessage(null)
    try {
      const result = await work()
      if (result.error) {
        setError(result.error)
        return
      }
      setTags(result.tags)
      setRenames({})
      setDescriptions({})
      // A rename or delete rewrites what the log is keyed by, so what is cached
      // would describe the wrong word.
      setHistory({})
      setOpenHistory(null)
      setMessage(done)
      // The directory's rows carry these tags too, so its loader re-runs.
      await router.invalidate()
    } catch {
      setError(failure)
    } finally {
      setPending(false)
    }
  }

  /**
   * Ask for a draft and put it in the row's own field.
   *
   * Deliberately not saved: the same reason a rewritten label meaning is shown
   * before it is applied is that a description the model got wrong would
   * otherwise become the definition the next draft is measured against.
   */
  async function improve(entry: ContactTagSummary) {
    setImproving(entry.tag)
    setError(null)
    setMessage(null)
    try {
      const result = await suggestTagDescriptionAction({
        data: {
          tag: entry.tag,
          current: descriptions[entry.tag] ?? entry.description ?? '',
        },
      })
      if (result.error) {
        setError(result.error)
        return
      }
      if (result.suggestion) {
        setDescriptions((current) => ({
          ...current,
          [entry.tag]: result.suggestion ?? '',
        }))
        setMessage('Draft ready — read it, then save.')
      }
    } catch {
      setError('Could not draft a description.')
    } finally {
      setImproving(null)
    }
  }

  /**
   * Open or close one row's log, reading it the first time only.
   *
   * The summary already carries the newest three changes; this is for the rest —
   * what a tag was made for months ago is often the answer to what it means now.
   */
  async function toggleHistory(tag: string) {
    if (openHistory === tag) {
      setOpenHistory(null)
      return
    }

    setOpenHistory(tag)
    if (history[tag]) return

    setLoadingHistory(tag)
    try {
      const result = await tagHistoryAction({ data: { tag } })
      if (result.error) {
        setError(result.error)
        return
      }
      setHistory((current) => ({ ...current, [tag]: result.changes }))
    } catch {
      setError('Could not read that history.')
    } finally {
      setLoadingHistory(null)
    }
  }

  /** Ask which tags the contacts suggest, without adding any. */
  async function suggest() {
    setSuggesting(true)
    setError(null)
    setMessage(null)
    try {
      const result = await suggestTagsAction()
      if (result.error) {
        setError(result.error)
        return
      }
      setSuggestions(result.suggestions)
      if (result.suggestions.length === 0) {
        setMessage(
          'Nothing new to suggest — every word the model proposed is already here.',
        )
      }
    } catch {
      setError('Could not suggest tags.')
    } finally {
      setSuggesting(false)
    }
  }

  /**
   * Add one proposal. The create action drafts its description as well, so an
   * accepted suggestion arrives with something to read rather than a bare word.
   */
  async function addSuggestion(tag: string) {
    await apply(
      async () => {
        const result = await createTagAction({ data: { tag } })
        if (!result.error) {
          setSuggestions((current) => current.filter((item) => item !== tag))
        }
        return result
      },
      `Added "${tag}".`,
      'Could not add that tag.',
    )
  }

  /**
   * Accept the whole proposal at once.
   *
   * Sequential on purpose: each create also asks for a description draft, and
   * firing five model calls in parallel would make the page race its own rows.
   * The first failure stops the run — the rest are still listed, so nothing is
   * silently skipped.
   */
  async function addAllSuggestions() {
    if (suggestions.length === 0) return
    const wanted = suggestions

    await apply(
      async () => {
        let latest: TagMutationResult = { error: null, tags: [] }
        for (const tag of wanted) {
          latest = await createTagAction({ data: { tag } })
          if (latest.error) return latest
        }
        setSuggestions([])
        return latest
      },
      `Added ${wanted.length} ${wanted.length === 1 ? 'tag' : 'tags'}.`,
      'Could not add every tag.',
    )
  }

  const described = tags.filter((entry) => entry.description).length

  return (
    <AppShell accounts={data.accounts} nav={<ContactNav active="tags" />}>
      <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
        <header>
          <h1 className="text-2xl font-bold">Contact tags</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {tags.length === 0
              ? 'The words the directory can be filtered by, and what each one means.'
              : `${tags.length} ${tags.length === 1 ? 'tag' : 'tags'}, ${described} with a description.`}
          </p>
        </header>

        <section className="mt-6 rounded-lg border border-border bg-card">
          <div className="border-b border-border p-4">
            <h2 className="text-sm font-semibold text-foreground">
              Vocabulary
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              A description says what the tag is for, so a word added months ago
              still reads the same way today. Every change to who carries a tag
              is recorded, and a description the app wrote is rewritten when
              that log moves past it. Renaming moves every contact with it;
              deleting removes it from all of them, description and log
              included.
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={pending || suggesting}
                onClick={() => void suggest()}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground hover:border-foreground/25 disabled:opacity-50"
              >
                <Sparkles aria-hidden="true" className="size-3" />
                {suggesting ? 'Thinking…' : 'Suggest tags'}
              </button>
              <span className="text-[11px] text-muted-foreground">
                Drafted from what the app already understands about your
                contacts — nothing is added until you say so.
              </span>
            </div>

            {suggestions.length > 0 ? (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {suggestions.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 py-0.5 pr-0.5 pl-2 text-[11px] text-foreground"
                  >
                    {tag}
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => void addSuggestion(tag)}
                      className="rounded-full px-1.5 py-0.5 font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
                    >
                      Add
                    </button>
                  </span>
                ))}
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void addAllSuggestions()}
                  className="rounded-md bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground disabled:opacity-50"
                >
                  Add all
                </button>
                <button
                  type="button"
                  onClick={() => setSuggestions([])}
                  className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                >
                  Dismiss
                </button>
              </div>
            ) : null}
          </div>

          {/*
           * A word can be added before anyone carries it: the list of tags is
           * something the user owns, not only a summary of what the mail has
           * produced.
           */}
          <form
            onSubmit={(event) => {
              event.preventDefault()
              const name = newTag.trim()
              if (name === '') return
              if (
                tags.some(
                  (entry) => entry.tag.toLowerCase() === name.toLowerCase(),
                )
              ) {
                setError('That tag is already in the list.')
                return
              }
              void apply(
                async () => {
                  const result = await createTagAction({ data: { tag: name } })
                  if (!result.error) setNewTag('')
                  return result
                },
                'Tag added. A description is what keeps the word clear.',
                'Could not add that tag.',
              )
            }}
            className="flex flex-wrap items-center gap-2 border-b border-border p-4"
          >
            <input
              value={newTag}
              onChange={(event) => {
                setNewTag(event.target.value)
                setError(null)
              }}
              disabled={pending}
              placeholder="New tag, e.g. investor"
              aria-label="New tag name"
              maxLength={CONTACT_TAG_LIMITS.tag}
              className="h-8 w-44 rounded-md border border-border bg-background px-2 text-xs text-foreground disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={pending || newTag.trim().length === 0}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              Add tag
            </button>
            <span className="text-[11px] text-muted-foreground">
              A tag can exist before anyone carries it.
            </span>
          </form>

          {tags.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              No tags yet. Add one above, put one on a person from their contact
              page, or let an automatic profile refresh propose one.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {tags.map((entry) => (
                <li key={entry.tag} className="p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs font-medium text-foreground">
                      {entry.tag}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {entry.contacts}{' '}
                      {entry.contacts === 1 ? 'contact' : 'contacts'}
                      {entry.auto > 0 ? ` · ${entry.auto} from AI` : ''}
                    </span>
                    {entry.descriptionSource === 'auto' && entry.description ? (
                      <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        Written by the app
                      </span>
                    ) : null}

                    <div className="ml-auto flex items-center gap-2">
                      <input
                        value={renames[entry.tag] ?? entry.tag}
                        onChange={(event) =>
                          setRenames((current) => ({
                            ...current,
                            [entry.tag]: event.target.value,
                          }))
                        }
                        disabled={pending}
                        aria-label={`Rename ${entry.tag}`}
                        maxLength={CONTACT_TAG_LIMITS.tag}
                        className="w-36 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground disabled:opacity-50"
                      />
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          void apply(
                            () =>
                              renameTagAction({
                                data: {
                                  from: entry.tag,
                                  to: (renames[entry.tag] ?? entry.tag).trim(),
                                },
                              }),
                            'Renamed everywhere it was used.',
                            'Could not rename that tag.',
                          )
                        }
                        className="shrink-0 rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground hover:border-foreground/25 disabled:opacity-50"
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          void apply(
                            () => deleteTagAction({ data: { tag: entry.tag } }),
                            'Tag removed from every contact.',
                            'Could not remove that tag.',
                          )
                        }
                        className="shrink-0 rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground hover:border-destructive/40 hover:text-destructive disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </div>
                  </div>

                  <form
                    onSubmit={(event) => {
                      event.preventDefault()
                      void apply(
                        () =>
                          setTagDescriptionAction({
                            data: {
                              tag: entry.tag,
                              description:
                                descriptions[entry.tag] ??
                                entry.description ??
                                '',
                            },
                          }),
                        'Description saved.',
                        'Could not save that description.',
                      )
                    }}
                    className="mt-2 flex items-center gap-2"
                  >
                    <input
                      value={descriptions[entry.tag] ?? entry.description ?? ''}
                      onChange={(event) =>
                        setDescriptions((current) => ({
                          ...current,
                          [entry.tag]: event.target.value,
                        }))
                      }
                      disabled={pending}
                      placeholder="What this tag is for — e.g. people met at the 2025 offsite"
                      aria-label={`Description for ${entry.tag}`}
                      maxLength={CONTACT_TAG_LIMITS.description}
                      className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    />
                    <button
                      type="button"
                      disabled={pending || improving !== null}
                      onClick={() => void improve(entry)}
                      title="Draft a description with the configured LLM"
                      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground hover:border-foreground/25 disabled:opacity-50"
                    >
                      <Sparkles aria-hidden="true" className="size-3" />
                      {improving === entry.tag ? 'Drafting…' : 'Improve'}
                    </button>
                    <button
                      type="submit"
                      disabled={pending}
                      className="shrink-0 rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground hover:border-foreground/25 disabled:opacity-50"
                    >
                      Save
                    </button>
                  </form>

                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => void toggleHistory(entry.tag)}
                      aria-expanded={openHistory === entry.tag}
                      className="text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {openHistory === entry.tag ? 'Hide history' : 'History'}
                      {entry.lastChangeAt
                        ? ` · last change ${formatDay(new Date(entry.lastChangeAt))}`
                        : ''}
                    </button>

                    {openHistory === entry.tag ? (
                      <div className="mt-1 rounded-md border border-border bg-background p-2">
                        {loadingHistory === entry.tag ? (
                          <p className="text-[11px] text-muted-foreground">
                            Reading the log…
                          </p>
                        ) : (history[entry.tag] ?? []).length === 0 ? (
                          <p className="text-[11px] text-muted-foreground">
                            No changes recorded yet.
                          </p>
                        ) : (
                          <ul className="space-y-0.5 text-[11px] text-muted-foreground">
                            {(history[entry.tag] ?? []).map((change, index) => (
                              <li
                                key={`${change.at}:${index}`}
                                className="flex items-baseline justify-between gap-3"
                              >
                                <span className="min-w-0 truncate">
                                  <span
                                    className={
                                      change.action === 'added'
                                        ? 'font-medium text-foreground'
                                        : ''
                                    }
                                  >
                                    {change.action === 'added'
                                      ? 'Added'
                                      : 'Removed'}
                                  </span>{' '}
                                  {change.email}
                                  <span>
                                    {' '}
                                    ·{' '}
                                    {change.source === 'auto'
                                      ? 'by the app'
                                      : 'by you'}
                                  </span>
                                </span>
                                <time
                                  dateTime={new Date(change.at).toISOString()}
                                  className="shrink-0"
                                >
                                  {formatDay(new Date(change.at))}
                                </time>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {error ? (
          <p
            role="alert"
            className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}
        {message ? (
          <p
            role="status"
            className="mt-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
          >
            {message}
          </p>
        ) : null}
      </div>
    </AppShell>
  )
}
