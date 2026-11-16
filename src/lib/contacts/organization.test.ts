import { describe, expect, test } from 'bun:test'

import {
  contactOrganization,
  normaliseOrganizationFocus,
  ORGANIZATION_FOCUS_LIMIT,
} from './organization.ts'

describe('contactOrganization', () => {
  test('reads the company domain as the organisation', () => {
    expect(contactOrganization('jane@acme.com')).toEqual({
      domain: 'acme.com',
      name: 'Acme',
    })
  })

  test('groups a subdomain under the registrable domain', () => {
    expect(contactOrganization('jane@mail.acme.com')).toEqual({
      domain: 'acme.com',
      name: 'Acme',
    })
    expect(contactOrganization('jane@www.acme.com')?.domain).toBe('acme.com')
  })

  test('keeps a two-label country suffix in the domain', () => {
    expect(contactOrganization('jane@acme-corp.co.uk')).toEqual({
      domain: 'acme-corp.co.uk',
      name: 'Acme Corp',
    })
  })

  test('leaves a mailbox provider ungrouped', () => {
    expect(contactOrganization('jane@gmail.com')).toBeNull()
    expect(contactOrganization('jane@proton.me')).toBeNull()
    expect(contactOrganization('jane@Yahoo.co.uk')).toBeNull()
  })

  test('leaves an address without a dotted host ungrouped', () => {
    expect(contactOrganization('jane@localhost')).toBeNull()
    expect(contactOrganization('jane@')).toBeNull()
    expect(contactOrganization('not-an-address')).toBeNull()
    expect(contactOrganization('')).toBeNull()
  })

  test('is case-insensitive and ignores surrounding space', () => {
    expect(contactOrganization('  Jane@ACME.com ')).toEqual({
      domain: 'acme.com',
      name: 'Acme',
    })
  })
})

describe('normaliseOrganizationFocus', () => {
  test('flattens a description to one trimmed line', () => {
    expect(normaliseOrganizationFocus('  builds\nwarehouse   robots ')).toBe(
      'builds warehouse robots',
    )
  })

  test('bounds a runaway description', () => {
    expect(normaliseOrganizationFocus('x'.repeat(400))).toHaveLength(
      ORGANIZATION_FOCUS_LIMIT,
    )
  })

  test('reads anything that is not a string as no description', () => {
    expect(normaliseOrganizationFocus(null)).toBe('')
    expect(normaliseOrganizationFocus(undefined)).toBe('')
    expect(normaliseOrganizationFocus(42)).toBe('')
  })
})
