/**
 * The MCP tool surface.
 *
 * Every tool is a thin translation between an agent's arguments and a function
 * the web app already calls. Nothing here reaches into the database directly:
 * the value of the service is that ownership checks, state-override rules,
 * provider calls and the reply-style resolution stay in one implementation
 * rather than being re-derived for a second entry point.
 *
 * Handlers are exported separately from `registerTools` so they can be tested
 * without a protocol round trip.
 *
 * Two deliberate differences from the browser:
 *
 * - `draft_reply` returns the generated text. It cannot put it in the composer,
 *   because the MCP service is a separate process from the open tab, and
 *   pretending otherwise would mean claiming a draft was saved when it was not.
 * - `send_reply` needs `confirm: true` on top of whatever approval the MCP
 *   client already applies. Mail leaves the building and cannot be recalled, so
 *   the one irreversible action is not available by a single accidental call.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { listAccounts } from '#/lib/auth/accounts.ts'
import {
  CONTACT_CONTEXT_LIMITS,
  getContactContext,
  saveContactContext,
} from '#/lib/contacts/context.ts'
import type { ContactContextFields } from '#/lib/contacts/context.ts'
import { normaliseContactEmail } from '#/lib/contacts/matching.ts'
import { loadContactHistory } from '#/lib/contacts/history.ts'
import {
  getContactTags,
  listContactTagSummary,
  setContactTag,
} from '#/lib/contacts/tags.ts'
import type { ConversationState } from '#/db/schema.ts'
import { CONVERSATION_STATES, STATE_ORDER } from '#/lib/conversation-state.ts'
import {
  getParsingProfileContext,
  replyAccountsFor,
  resolveReplyStyle,
} from '#/lib/conversation/index.ts'
import {
  applyUserStateOverride,
  draftReply as generateReplyDraft,
  loadConversation,
  loadInbox,
  setConversationFolder,
} from '#/lib/gmail/service.ts'
import {
  refreshThread,
  requireConversationByThreadId,
  sendReply as sendThreadReply,
} from '#/lib/gmail/send.ts'
import { MAIL_FOLDERS } from '#/lib/mail-folders.ts'
import type { MailFolder } from '#/lib/mail-folders.ts'
import { createMailboxClientFor } from '#/lib/mailbox/provider.ts'
import {
  listOrganizationLabels,
  listStateLabels,
} from '#/lib/organization/store.ts'

/** What a tool handler returns: JSON as text, or an error the agent can read. */
export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

function ok(value: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  }
}

function fail(message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] }
}

/**
 * Read stored threads without asking a provider for anything.
 *
 * `loadInbox` normally syncs when the cursor is stale. A tool call is a read of
 * what the app already synced — the browser keeps that current — so the
 * staleness threshold is effectively infinite here and a query cannot turn into
 * a multi-minute backfill. The one exception is an install that has never
 * synced: `loadInbox` starts the first sync in the background, which only
 * makes later calls more useful.
 */
async function storedThreads(userId: string, search?: string) {
  const payload = await loadInbox(userId, {
    search,
    staleAfterMs: Number.POSITIVE_INFINITY,
  })

  if (!payload.signedIn) {
    throw new Error('No mailboxes are connected for that account.')
  }

  return payload.conversations
}

/** The compact row an agent sees for a thread. */
function summarise(conversation: {
  providerThreadId: string
  subject: string
  state: ConversationState
  folder: MailFolder
  participants: Array<{ name: string | null; email: string }>
  tags: string[]
  messageCount: number
  attachmentCount: number
  lastMessageAt: string
  topic: string | null
  goal: string | null
  importance: number
  urgency: number
  unseen: boolean
  done: boolean
  isAutomated: boolean
  replyable: boolean
  accountEmail: string
}) {
  return {
    threadId: conversation.providerThreadId,
    account: conversation.accountEmail,
    subject: conversation.subject,
    state: conversation.state,
    folder: conversation.folder,
    participants: conversation.participants.map((participant) => ({
      name: participant.name,
      email: participant.email,
    })),
    tags: conversation.tags,
    topic: conversation.topic,
    goal: conversation.goal,
    importance: conversation.importance,
    urgency: conversation.urgency,
    messageCount: conversation.messageCount,
    attachmentCount: conversation.attachmentCount,
    lastMessageAt: conversation.lastMessageAt,
    unseen: conversation.unseen,
    done: conversation.done,
    automated: conversation.isAutomated,
    replyable: conversation.replyable,
  }
}

export type ListThreadsArgs = {
  state?: ConversationState
  folder?: MailFolder | 'all'
  person?: string
  tag?: string
  query?: string
  limit?: number
}

/** List stored threads, filtered the way the inbox groups them. */
export async function listThreads(
  userId: string,
  args: ListThreadsArgs = {},
): Promise<ToolResult> {
  const limit = Math.min(Math.max(1, Math.trunc(args.limit ?? 25)), 100)
  const folder = args.folder ?? 'inbox'
  const person = args.person ? normaliseContactEmail(args.person) : null
  const tag = args.tag?.trim().toLowerCase() || null

  const rows = await storedThreads(userId, args.query)

  const filtered = rows.filter((row) => {
    if (folder !== 'all' && row.folder !== folder) return false
    if (args.state && row.state !== args.state) return false
    if (
      person &&
      !row.participants.some(
        (participant) => normaliseContactEmail(participant.email) === person,
      )
    ) {
      return false
    }
    if (
      tag &&
      !row.tags.some((rowTag) => rowTag.trim().toLowerCase() === tag)
    ) {
      return false
    }
    return true
  })

  return ok({
    total: filtered.length,
    returned: Math.min(limit, filtered.length),
    truncated: filtered.length > limit,
    threads: filtered.slice(0, limit).map(summarise),
  })
}

/** Full text search over the mail the app has already stored. */
export async function searchMail(
  userId: string,
  args: { query: string; limit?: number },
): Promise<ToolResult> {
  const query = args.query.trim()
  if (!query) return fail('Give the search a word or phrase to look for.')

  return listThreads(userId, {
    query,
    folder: 'all',
    limit: args.limit,
  })
}

/** One thread with its messages, participants and attachments. */
export async function getThread(
  userId: string,
  args: { threadId: string },
): Promise<ToolResult> {
  const threadId = args.threadId.trim()
  if (!threadId) return fail('Give the thread id to load.')

  const detail = await loadConversation(userId, threadId)
  if (!detail) return fail('That conversation no longer exists.')

  return ok({
    threadId: detail.providerThreadId,
    account: detail.accountEmail,
    subject: detail.subject,
    state: detail.state,
    stateOverride: detail.stateOverride,
    topic: detail.topic,
    goal: detail.goal,
    importance: detail.importance,
    replyable: detail.replyable,
    automated: detail.isAutomated,
    awaitingReply: detail.awaitingReply,
    requiresReply: detail.requiresReply,
    done: detail.done,
    seenAt: detail.seenAt,
    tags: detail.tags,
    participants: detail.participants.map((participant) => ({
      name: participant.name,
      email: participant.email,
    })),
    messages: detail.messages.map((entry) => ({
      id: entry.providerMessageId,
      from: entry.from,
      sentAt: entry.sentAt,
      fromOwner: entry.isFromOwner,
      body: entry.body,
    })),
    attachments: detail.attachments.map((attachment) => ({
      messageId: attachment.providerMessageId,
      attachmentId: attachment.providerAttachmentId,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      inline: attachment.isInline,
      sender: attachment.sender,
      sentAt: attachment.sentAt,
    })),
    contactContext: detail.contactContext,
  })
}

/**
 * A correspondent: what the user has written about them, their tags, and the
 * threads they appear on.
 */
export async function getPerson(
  userId: string,
  args: { email: string },
): Promise<ToolResult> {
  const email = normaliseContactEmail(args.email)
  if (!email) return fail('Give the person an email address.')

  const [context, tags, history] = await Promise.all([
    getContactContext(userId, email),
    getContactTags(userId, email),
    loadContactHistory(userId, email, { limit: 10 }),
  ])

  return ok({
    email,
    context,
    tags,
    recentThreads: history,
  })
}

/** The user's tag vocabulary, with how many contacts carry each tag. */
export async function listTags(userId: string): Promise<ToolResult> {
  const summary = await listContactTagSummary(userId)

  return ok({
    tags: summary.map((entry) => ({
      tag: entry.tag,
      description: entry.description,
      contacts: entry.contacts,
      auto: entry.auto,
    })),
  })
}

/** The four states, with the user's own wording where they have edited it. */
export async function listStates(userId: string): Promise<ToolResult> {
  const labels = await listStateLabels(userId)

  return ok({
    states: STATE_ORDER.map((state) => ({
      state,
      label: labels[state].name,
      description: labels[state].description,
      inboxOrder: STATE_ORDER.indexOf(state) + 1,
    })),
  })
}

/** The user's organisation labels and the rules that file mail under them. */
export async function listOrganizations(userId: string): Promise<ToolResult> {
  const labels = await listOrganizationLabels(userId)

  return ok({
    organizations: labels.map((label) => ({
      id: label.id,
      name: label.name,
      description: label.description,
      enabled: label.enabled,
      rules: label.rules.map((rule) => ({
        field: rule.field,
        value: rule.value,
      })),
    })),
  })
}

/**
 * Move a thread to a state or folder.
 *
 * Both are user-owned answers and are written through the same functions the
 * UI calls, so the override survives the next sync and re-decision.
 */
export async function moveThread(
  userId: string,
  args: { threadId: string; state?: ConversationState; folder?: MailFolder },
): Promise<ToolResult> {
  const threadId = args.threadId.trim()
  if (!threadId) return fail('Give the thread id to move.')
  if (!args.state && !args.folder) {
    return fail('Provide a state, a folder, or both.')
  }

  const applied: Record<string, string> = {}

  if (args.state) {
    await applyUserStateOverride(userId, threadId, args.state)
    applied.state = args.state
  }

  if (args.folder) {
    await setConversationFolder(userId, threadId, args.folder)
    applied.folder = args.folder
  }

  return ok({ moved: true, threadId, ...applied })
}

/**
 * Add or remove the user's tags on a person.
 *
 * Nuntia's tags belong to a correspondent rather than to a thread, so this
 * takes an address. Applying a tag to "all threads from Acme" means tagging the
 * people at Acme once.
 */
export async function updatePersonTags(
  userId: string,
  args: { email: string; add?: string[]; remove?: string[] },
): Promise<ToolResult> {
  const email = normaliseContactEmail(args.email)
  if (!email) return fail('Give the person an email address.')

  const add = args.add ?? []
  const remove = args.remove ?? []
  if (add.length === 0 && remove.length === 0) {
    return fail('Provide at least one tag to add or remove.')
  }

  for (const tag of remove) {
    const result = await setContactTag(userId, email, tag, false)
    if (result === null) return fail(`"${tag}" is not a usable tag.`)
  }

  let tags: string[] = []
  for (const tag of add) {
    const result = await setContactTag(userId, email, tag, true)
    if (result === null) return fail(`"${tag}" is not a usable tag.`)
    tags = result
  }

  if (tags.length === 0) tags = await getContactTags(userId, email)

  return ok({ email, tags })
}

/** Names for the profile fields, so one refusal message names the right one. */
const NOTES_FIELDS = {
  roleCompany: 'role or company',
  relationship: 'relationship',
  topics: 'topics',
  currentWork: 'current work',
} as const

/**
 * Update the notes the user keeps about a person.
 *
 * The stored row is read first and only the supplied fields are replaced: an
 * agent asked to add one sentence must not erase the four fields it was never
 * given. `saveContactContext` then applies the same limits and normalisation
 * the settings form uses.
 */
export async function updatePersonNotes(
  userId: string,
  args: {
    email: string
    roleCompany?: string
    relationship?: string
    topics?: string
    currentWork?: string
    importance?: number | null
  },
): Promise<ToolResult> {
  const email = normaliseContactEmail(args.email)
  if (!email) return fail('Give the person an email address.')

  const existing = await getContactContext(userId, email)

  const merged: ContactContextFields = {
    roleCompany: existing?.roleCompany ?? '',
    relationship: existing?.relationship ?? '',
    topics: existing?.topics ?? '',
    currentWork: existing?.currentWork ?? '',
    importance: existing?.importance ?? null,
  }

  let changed = false
  for (const field of Object.keys(NOTES_FIELDS) as Array<
    keyof typeof NOTES_FIELDS
  >) {
    const value = args[field]
    if (value === undefined) continue
    if (typeof value !== 'string') {
      return fail(`The ${NOTES_FIELDS[field]} note must be text.`)
    }
    const limit = CONTACT_CONTEXT_LIMITS[field]
    if (value.length > limit) {
      return fail(
        `Keep the ${NOTES_FIELDS[field]} note to ${limit} characters or fewer.`,
      )
    }
    merged[field] = value
    changed = true
  }

  if (args.importance !== undefined) {
    if (
      args.importance !== null &&
      (!Number.isInteger(args.importance) ||
        args.importance < 1 ||
        args.importance > 10)
    ) {
      return fail('Importance has to be a whole number from 1 to 10.')
    }
    merged.importance = args.importance
    changed = true
  }

  if (!changed) return fail('Provide at least one note or the importance.')

  const saved = await saveContactContext(userId, email, merged)
  if (!saved) return fail('Those notes could not be saved.')

  return ok({ email, context: saved })
}

/** Draft a reply for the agent to show or edit. Nothing is sent or stored. */
export async function draftReply(
  userId: string,
  args: { threadId: string; instructions?: string | null },
): Promise<ToolResult> {
  const threadId = args.threadId.trim()
  if (!threadId) return fail('Give the thread id to draft a reply for.')

  const outcome = await generateReplyDraft(
    userId,
    threadId,
    args.instructions ?? null,
  )

  if (!outcome.draft) {
    return fail(outcome.error ?? 'No draft could be generated.')
  }

  return ok({
    threadId,
    draft: outcome.draft,
    note: 'Nothing was sent or stored. Show the draft to the user for editing.',
  })
}

/**
 * Send a reply through the mailbox that owns the thread.
 *
 * The order matters and matches the app's route: ownership, the allowed sender
 * addresses, the mailbox client, the user's reply style, then the send. The
 * thread is refreshed afterwards so the sent message is in the local database
 * immediately rather than at the next sync.
 */
export async function sendReply(
  userId: string,
  args: { threadId: string; body: string; fromAccountId?: string },
): Promise<ToolResult> {
  const threadId = args.threadId.trim()
  if (!threadId) return fail('Give the thread id to reply to.')

  const body = args.body
  if (!body.trim()) return fail('Cannot send an empty reply.')

  const { accountId: ownerAccountId, conversation } =
    await requireConversationByThreadId(userId, threadId)

  const accounts = (await listAccounts(userId)).map((account) => ({
    id: account.id,
    email: account.email,
  }))
  const allowed = new Set(
    replyAccountsFor(conversation.messages, accounts, ownerAccountId),
  )
  const accountId =
    args.fromAccountId && allowed.has(args.fromAccountId)
      ? args.fromAccountId
      : ownerAccountId

  const client = await createMailboxClientFor(accountId)
  if (!client) {
    return fail('No mailbox is connected for that thread.')
  }

  const profileContext = await getParsingProfileContext(accountId)
  const incoming = [...conversation.messages]
    .reverse()
    .find((entry) => !entry.isFromOwner)
  const lastOwnerMessage = [...conversation.messages]
    .reverse()
    .find((entry) => entry.isFromOwner)

  const replyStyle = resolveReplyStyle({
    account: {
      greeting: profileContext.replyStyles.account.greeting ?? null,
      signature: profileContext.replyStyles.account.signature ?? null,
    },
    sender: incoming
      ? (profileContext.replyStyles.senders[
          incoming.from.email.trim().toLowerCase()
        ] ?? null)
      : null,
    lastOwnerMessage,
  })

  await sendThreadReply(client, accountId, conversation, body, { replyStyle })
  await refreshThread(client, accountId, threadId)

  return ok({
    sent: true,
    threadId,
    accountId,
    account:
      accounts.find((account) => account.id === accountId)?.email ?? null,
  })
}

/**
 * The send tool's guard, separate from the handler so it can be tested.
 *
 * A host that prompts before every tool call is the normal approval path; this
 * is the second lock, for a client that does not prompt or an agent that decides
 * on its own that it is finished. Either way the body the user approved has to
 * be the body that leaves.
 */
export async function sendReplyConfirmed(
  userId: string,
  args: {
    threadId: string
    body: string
    fromAccountId?: string
    confirm?: boolean
  },
): Promise<ToolResult> {
  if (args.confirm !== true) {
    return fail(
      'Refusing to send without explicit confirmation. Show the user the ' +
        'exact recipient, subject and body, then call again with ' +
        'confirm: true once they approve.',
    )
  }

  return sendReply(userId, {
    threadId: args.threadId,
    body: args.body,
    fromAccountId: args.fromAccountId,
  })
}

/**
 * Register every tool on a server scoped to one user.
 *
 * The user id is closed over rather than taken from tool arguments, so an agent
 * cannot ask for another account's mail by changing a parameter. The HTTP
 * entry point builds one server per authenticated request, which is also what
 * keeps stateless MCP requests from sharing identity.
 */
export function registerTools(server: McpServer, userId: string): void {
  server.registerTool(
    'list_threads',
    {
      title: 'List threads',
      description:
        'List stored mail threads, newest first. Filter by state, folder, ' +
        'correspondent email, contact tag, or a free-text query.',
      inputSchema: {
        state: z
          .enum([...CONVERSATION_STATES] as [string, ...string[]])
          .optional()
          .describe('One of the four Nuntia states.'),
        folder: z
          .enum([...MAIL_FOLDERS, 'all'] as [string, ...string[]])
          .optional()
          .describe(
            'Folder to read; defaults to inbox. Use "all" for every folder.',
          ),
        person: z
          .string()
          .optional()
          .describe('Only threads this address participates in.'),
        tag: z
          .string()
          .optional()
          .describe('Only threads whose correspondent carries this tag.'),
        query: z
          .string()
          .optional()
          .describe('Words that must all appear somewhere in the thread.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Maximum rows to return; defaults to 25.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      listThreads(userId, {
        ...args,
        state: args.state as ConversationState | undefined,
        folder: args.folder as MailFolder | 'all' | undefined,
      }),
  )

  server.registerTool(
    'get_thread',
    {
      title: 'Get a thread',
      description:
        'Load one thread with its messages, participants, attachments and ' +
        'what the user has recorded about it.',
      inputSchema: {
        threadId: z.string().describe('The thread id from list_threads.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ threadId }) => getThread(userId, { threadId }),
  )

  server.registerTool(
    'search_mail',
    {
      title: 'Search mail',
      description:
        'Search stored mail across every folder. Every word must appear ' +
        'somewhere in the subject, topic, participants or message text.',
      inputSchema: {
        query: z.string().describe('Words to look for.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Maximum rows to return; defaults to 25.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => searchMail(userId, { query, limit }),
  )

  server.registerTool(
    'get_person',
    {
      title: 'Get a person',
      description:
        'Load what the user has recorded about a correspondent: context ' +
        'notes, tags and recent threads with them.',
      inputSchema: {
        email: z.string().describe("The correspondent's email address."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ email }) => getPerson(userId, { email }),
  )

  server.registerTool(
    'list_tags',
    {
      title: 'List tags',
      description:
        "The user's contact tag vocabulary, with how many people carry each tag.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => listTags(userId),
  )

  server.registerTool(
    'list_states',
    {
      title: 'List states',
      description:
        "The four conversation states, with the user's own wording and the " +
        'order they read in.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => listStates(userId),
  )

  server.registerTool(
    'list_organizations',
    {
      title: 'List organisations',
      description:
        "The user's organisation labels and the rules that file mail under them.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => listOrganizations(userId),
  )

  server.registerTool(
    'move_thread',
    {
      title: 'Move a thread',
      description:
        "Set a thread's state, move it to a folder (inbox, archive, trash, " +
        "spam), or both. This is the user's own call and survives later syncs.",
      inputSchema: {
        threadId: z.string().describe('The thread id to move.'),
        state: z
          .enum([...CONVERSATION_STATES] as [string, ...string[]])
          .optional()
          .describe('The state to set.'),
        folder: z
          .enum([...MAIL_FOLDERS] as [string, ...string[]])
          .optional()
          .describe('The folder to move the thread to.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      moveThread(userId, {
        threadId: args.threadId,
        state: args.state as ConversationState | undefined,
        folder: args.folder as MailFolder | undefined,
      }),
  )

  server.registerTool(
    'update_person_tags',
    {
      title: 'Update person tags',
      description:
        'Add or remove tags on a correspondent. Tags belong to a person, not ' +
        'to a thread.',
      inputSchema: {
        email: z.string().describe("The correspondent's email address."),
        add: z.array(z.string()).optional().describe('Tags to add.'),
        remove: z.array(z.string()).optional().describe('Tags to remove.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ email, add, remove }) =>
      updatePersonTags(userId, { email, add, remove }),
  )

  server.registerTool(
    'update_person_notes',
    {
      title: 'Update person notes',
      description:
        'Update the notes the user keeps about a correspondent. Only the ' +
        'fields supplied are changed.',
      inputSchema: {
        email: z.string().describe("The correspondent's email address."),
        roleCompany: z.string().optional().describe('Role and company.'),
        relationship: z
          .string()
          .optional()
          .describe('Their relationship to the user.'),
        topics: z
          .string()
          .optional()
          .describe('Topics they usually write about.'),
        currentWork: z
          .string()
          .optional()
          .describe('What they are working on now.'),
        importance: z
          .number()
          .int()
          .min(1)
          .max(10)
          .nullable()
          .optional()
          .describe('How important this person is, 1 to 10; null to clear it.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ email, ...notes }) =>
      updatePersonNotes(userId, { email, ...notes }),
  )

  server.registerTool(
    'draft_reply',
    {
      title: 'Draft a reply',
      description:
        'Generate a reply draft for a thread. Nothing is sent or stored; the ' +
        'draft comes back as text for the user to review.',
      inputSchema: {
        threadId: z.string().describe('The thread to reply to.'),
        instructions: z
          .string()
          .optional()
          .describe('Optional direction for the draft.'),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ threadId, instructions }) =>
      draftReply(userId, { threadId, instructions }),
  )

  server.registerTool(
    'send_reply',
    {
      title: 'Send a reply',
      description:
        'Send a reply from the mailbox that owns the thread. This delivers ' +
        'mail and cannot be undone. Requires confirm: true, and the user must ' +
        'have approved the exact body.',
      inputSchema: {
        threadId: z.string().describe('The thread to reply to.'),
        body: z
          .string()
          .describe('The reply body, without greeting or signature.'),
        fromAccountId: z
          .string()
          .optional()
          .describe(
            'Which connected mailbox to send from; defaults to the owning one.',
          ),
        confirm: z
          .boolean()
          .optional()
          .describe('Must be true. A guard against an accidental send.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ threadId, body, fromAccountId, confirm }) =>
      sendReplyConfirmed(userId, {
        threadId,
        body,
        fromAccountId,
        confirm,
      }),
  )
}
