import { describe, expect, test } from 'bun:test'

import { isServiceContact } from './person.ts'

describe('isServiceContact', () => {
  test('recognises the mailboxes a desk answers from', () => {
    expect(isServiceContact('support@acme.com')).toBe(true)
    expect(isServiceContact('Billing@Acme.com')).toBe(true)
    expect(isServiceContact('info@acme.com')).toBe(true)
    expect(isServiceContact('no-reply@acme.com')).toBe(true)
  })

  test('strips sub-addressing before matching', () => {
    expect(isServiceContact('support+eu@acme.com')).toBe(true)
    expect(isServiceContact('invoices+2026@acme.com')).toBe(true)
  })

  test('recognises a desk spelled with separators', () => {
    expect(isServiceContact('support.team@acme.com')).toBe(true)
    expect(isServiceContact('customer_service@acme.com')).toBe(true)
  })

  test('leaves a person alone, including a first-last mailbox', () => {
    expect(isServiceContact('jane@acme.com')).toBe(false)
    expect(isServiceContact('jane.smith@acme.com')).toBe(false)
    // The precision case: a person in sales is still a person.
    expect(isServiceContact('sales.jane@acme.com')).toBe(false)
    expect(isServiceContact('support.jane@acme.com')).toBe(false)
  })

  test('reads the local part only, so a person at a support company stays a person', () => {
    expect(isServiceContact('jane@support.example')).toBe(false)
  })

  test('never calls an unusable input a service', () => {
    expect(isServiceContact('')).toBe(false)
    expect(isServiceContact('support')).toBe(false)
    expect(isServiceContact('@acme.com')).toBe(false)
  })
})
