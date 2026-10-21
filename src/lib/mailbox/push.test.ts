/**
 * The push parser is the boundary between Google and this app, so it is tested
 * on its own: a body it misreads either starts a sync for the wrong mailbox or
 * silently drops a real notification.
 */

import { describe, expect, test } from 'bun:test'

import { parseGmailPushNotification } from './push.ts'

/** The delivery body Pub/Sub actually posts. */
function envelope(notification: unknown): unknown {
  return {
    message: {
      data: Buffer.from(JSON.stringify(notification)).toString('base64'),
      messageId: '1',
    },
    subscription: 'projects/p/subscriptions/s',
  }
}

describe('parseGmailPushNotification', () => {
  test('reads the address and cursor out of a Pub/Sub envelope', () => {
    expect(
      parseGmailPushNotification(
        envelope({ emailAddress: 'Alice@Example.com', historyId: 42 }),
      ),
    ).toEqual({ email: 'alice@example.com', historyId: '42' })
  })

  test('accepts the decoded notification as well', () => {
    expect(
      parseGmailPushNotification({ emailAddress: 'bob@example.com' }),
    ).toEqual({ email: 'bob@example.com', historyId: null })
  })

  test('refuses a body with no address, so nothing is synced on a guess', () => {
    expect(parseGmailPushNotification(envelope({ historyId: 7 }))).toBeNull()
    expect(parseGmailPushNotification({ emailAddress: '   ' })).toBeNull()
  })

  test('refuses undecodable or non-object bodies', () => {
    expect(
      parseGmailPushNotification({ message: { data: 'not base64 json' } }),
    ).toBeNull()
    expect(
      parseGmailPushNotification({ message: { data: 'bm90IGpzb24=' } }),
    ).toBeNull()
    expect(parseGmailPushNotification('hello')).toBeNull()
    expect(parseGmailPushNotification(null)).toBeNull()
  })
})
