/**
 * One read of the address book, shared by the directory and the organisations
 * tab.
 *
 * The address book is the mail itself, so this is built from the learned
 * contacts and unioned with any profile that has no contact row — a note must
 * never become invisible because its address was not seen in a recent sync. Both
 * screens then group and filter the same rows in the browser instead of each
 * asking the database for its own cut.
 */

import { createServerFn } from '@tanstack/react-start'

import { getSession, listAccounts } from '#/lib/auth/index.ts'
import { listContactContexts } from './context.ts'
import { contactContextDescription } from './description.ts'
import { listContactActivity } from './history.ts'
import { listContactSuggestions } from './index.ts'
import { normaliseContactEmail } from './matching.ts'
import { contactOrganization } from './organization.ts'
import type { ContactOrganization } from './organization.ts'
import { listContactTags } from './tags.ts'

export type ConnectedAccount = { id: string; email: string }

export type ContactDirectoryItem = {
  email: string
  name: string | null
  description: string | null
  importance: number | null
  /** The newest thread they appear on, or null when only a note exists. */
  latestThreadSubject: string | null
  /** ISO string of that thread's last message. */
  lastInteractionAt: string | null
  /** The user's own tags for this person, in display order. */
  tags: string[]
  /**
   * The company this address belongs to, read from its domain; null for a
   * personal mailbox.
   */
  organization: ContactOrganization | null
}

export type ContactDirectoryData =
  | { signedIn: false }
  | {
      signedIn: true
      contacts: ContactDirectoryItem[]
      accounts: ConnectedAccount[]
    }

export const fetchContactDirectory = createServerFn({ method: 'GET' }).handler(
  async (): Promise<ContactDirectoryData> => {
    const session = await getSession()
    if (!session) return { signedIn: false }

    const accounts = await listAccounts(session.userId)
    const owners = new Set(
      accounts.map((account) => account.email.trim().toLowerCase()),
    )

    const [suggestions, contexts, activity, tagsByEmail] = await Promise.all([
      // A directory is expected to hold everyone, so the list's usual cap is
      // lifted far enough that a real address book fits in one read.
      listContactSuggestions(
        accounts.map((account) => account.id),
        owners,
        1_000,
      ),
      listContactContexts(session.userId),
      listContactActivity(session.userId),
      // One read for every contact's tags: the rows all show them, and a tag is
      // the other half of finding a person quickly.
      listContactTags(session.userId),
    ])

    const byEmail = new Map<string, ContactDirectoryItem>()
    for (const suggestion of suggestions) {
      const email = normaliseContactEmail(suggestion.email)
      if (!email) continue
      byEmail.set(email, {
        email,
        name: suggestion.name,
        description: null,
        importance: null,
        latestThreadSubject: null,
        lastInteractionAt: null,
        tags: tagsByEmail.get(email) ?? [],
        organization: contactOrganization(email),
      })
    }

    // A profile outranks the learned contact only for the fields it owns: the
    // name still comes from the mail, which is what the user last saw there.
    for (const context of contexts) {
      const existing = byEmail.get(context.email)
      byEmail.set(context.email, {
        email: context.email,
        name: existing?.name ?? null,
        description: contactContextDescription(context),
        importance: context.importance,
        latestThreadSubject: null,
        lastInteractionAt: null,
        tags: tagsByEmail.get(context.email) ?? existing?.tags ?? [],
        organization:
          existing?.organization ?? contactOrganization(context.email),
      })
    }

    // One lookup per contact rather than per query: the activity map is already
    // the newest thread for every address the accounts have met.
    for (const contact of byEmail.values()) {
      const latest = activity.get(contact.email)
      contact.latestThreadSubject = latest?.subject ?? null
      contact.lastInteractionAt = latest?.lastMessageAt ?? null
    }

    const contacts = [...byEmail.values()].sort((a, b) =>
      (a.name ?? a.email).localeCompare(b.name ?? b.email),
    )

    return {
      signedIn: true,
      contacts,
      accounts: accounts.map((account) => ({
        id: account.id,
        email: account.email,
      })),
    }
  },
)
