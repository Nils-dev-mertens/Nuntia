import { describe, expect, test } from 'bun:test'

import type { Participant } from '#/db/schema.ts'

import type { ConversationMessage } from './model.ts'
import { isAutomatedSender, isAutomatedThread } from './automated.ts'

const OWNER = 'me@example.com'

function sender(email: string, name?: string): Participant {
  return { email, name: name ?? null }
}

function message(from: Participant, sentAt = new Date(0)): ConversationMessage {
  return {
    providerMessageId: `msg-${from.email}-${sentAt.getTime()}`,
    internetMessageId: null,
    from,
    to: [sender(OWNER)],
    cc: [],
    subject: 'Test',
    snippet: null,
    body: 'Body',
    bodyHtml: null,
    greeting: null,
    signature: null,
    isFromOwner: from.email === OWNER,
    sentAt,
  }
}

describe('isAutomatedSender', () => {
  test('recognises the common no-reply spellings', () => {
    for (const email of [
      'noreply@github.com',
      'no-reply@example.com',
      'no_reply@example.com',
      'no.reply@example.com',
      'do-not-reply@stripe.com',
      'donotreply@stripe.com',
      'do.not.reply@stripe.com',
    ]) {
      expect(isAutomatedSender(sender(email))).toBe(true)
    }
  })

  test('recognises service-prefixed and suffixed forms', () => {
    // Real-world senders bury the marker behind a prefix.
    expect(isAutomatedSender(sender('github-noreply@github.com'))).toBe(true)
    expect(isAutomatedSender(sender('stripe-no-reply@stripe.com'))).toBe(true)
    // Subaddressing for multiple automated streams.
    expect(isAutomatedSender(sender('noreply+ci@github.com'))).toBe(true)
  })

  test('recognises the machine sender roles', () => {
    for (const email of [
      'mailer-daemon@google.com',
      'postmaster@localhost',
      'bounce@stripe.com',
      'notifications@figma.com',
      'alerts@datadoghq.com',
      'automated@internal.example.com',
    ]) {
      expect(isAutomatedSender(sender(email))).toBe(true)
    }
  })

  test('recognises markers in the display name alone', () => {
    // The address is often a real person's; only the name gives it away.
    expect(
      isAutomatedSender(sender('mona@github.com', 'GitHub (no-reply)')),
    ).toBe(true)
    expect(isAutomatedSender(sender('mona@github.com', 'Do Not Reply'))).toBe(
      true,
    )
    expect(
      isAutomatedSender(sender('a@b.com', 'Your automated notification')),
    ).toBe(true)
  })

  test('leaves real people alone', () => {
    for (const email of [
      'alice@example.com',
      'nora.reilly@example.com',
      'nora_reilly@example.com',
      'me.reilly@gmail.com',
      'jane@company.co',
    ]) {
      expect(isAutomatedSender(sender(email))).toBe(false)
    }
  })

  test('does not flag a person whose name merely resembles a marker', () => {
    // The boundary rule: `reply` and `auto` are not markers, so these stay human.
    expect(isAutomatedSender(sender('reply@example.com'))).toBe(false)
    expect(isAutomatedSender(sender('auto@example.com'))).toBe(false)
    // A display name containing a marker word but not a marker phrase.
    expect(isAutomatedSender(sender('a@b.com', 'Reply Later Inc'))).toBe(false)
    expect(isAutomatedSender(sender('a@b.com', 'Alerts Department'))).toBe(false)
  })

  test('ignores the domain when deciding', () => {
    // `no-reply.github.com` is an outbound bounce domain Gmail uses, not a
    // sender. Matching on it would flag unrelated human mail.
    expect(isAutomatedSender(sender('alice@no-reply.github.com'))).toBe(false)
  })

  test('tolerates a malformed address', () => {
    expect(isAutomatedSender(sender('not-an-email'))).toBe(false)
    expect(isAutomatedSender(sender(''))).toBe(false)
  })
})

describe('isAutomatedThread', () => {
  test('a single no-reply message is automated', () => {
    expect(isAutomatedThread([message(sender('noreply@github.com'))], OWNER)).toBe(
      true,
    )
  })

  test('a thread from a real person is not automated', () => {
    expect(isAutomatedThread([message(sender('alice@example.com'))], OWNER)).toBe(
      false,
    )
  })

  test('you replying to a receipt keeps it automated', () => {
    const messages = [
      message(sender('noreply@stripe.com'), new Date(0)),
      message(sender(OWNER), new Date(1000)),
    ]

    expect(isAutomatedThread(messages, OWNER)).toBe(true)
  })

  test('a human replying to a no-reply address turns it back into a chat', () => {
    // The self-correcting case. Nothing is persisted, so the next sync just
    // re-derives this as a conversation.
    const messages = [
      message(sender('noreply@github.com'), new Date(0)),
      message(sender('alice@example.com'), new Date(1000)),
    ]

    expect(isAutomatedThread(messages, OWNER)).toBe(false)
  })

  test('a thread you wrote entirely yourself is not automated', () => {
    // Nothing machine-generated happened, so the "at least one" guard applies.
    const messages = [
      message(sender(OWNER), new Date(0)),
      message(sender(OWNER), new Date(1000)),
    ]

    expect(isAutomatedThread(messages, OWNER)).toBe(false)
  })

  test('the owner is matched case-insensitively', () => {
    const messages = [
      message(sender('noreply@github.com'), new Date(0)),
      message(sender('Me@Example.com'), new Date(1000)),
    ]

    expect(isAutomatedThread(messages, OWNER)).toBe(true)
  })

  test('an empty thread is not automated', () => {
    // Reported as not automated rather than automated: nothing has been received,
    // so there is no evidence of a machine.
    expect(isAutomatedThread([], OWNER)).toBe(false)
  })
})