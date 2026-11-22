/**
 * A new message restores the greeting and signature the same way a reply does —
 * the user types only what they want to say. These are the parts of that
 * restoration that are pure: what the two representations contain, and what
 * happens when there is nothing to restore.
 */

import { describe, expect, test } from 'bun:test'

import {
  applyGreetingName,
  composeNewMessage,
  composeReply,
  nameFromAddress,
} from './compose.ts'

describe('composeNewMessage', () => {
  test('puts the greeting above the body and the signature below it', () => {
    const composed = composeNewMessage({
      body: 'Lunch on Thursday?',
      greeting: 'Hi Nils,',
      signature: 'Kind regards,\nBram',
    })

    expect(composed.text).toBe(
      'Hi Nils,\n\nLunch on Thursday?\n\nKind regards,\nBram',
    )
    // The rich part is always produced for a new message: Graph sends HTML only,
    // and a signature block needs its line breaks either way.
    expect(composed.html).toContain('<p>Hi Nils,</p>')
    expect(composed.html).toContain('<p>Lunch on Thursday?</p>')
    expect(composed.html).toContain('Kind regards,<br>Bram')
  })

  test('quotes nothing — there is no thread to quote', () => {
    const composed = composeNewMessage({
      body: 'Hello there.',
      greeting: 'Hi,',
      signature: 'Bram',
    })

    expect(composed.text).not.toContain('>')
    expect(composed.html).not.toContain('<blockquote>')
  })

  test('sends the body alone when neither is known', () => {
    const composed = composeNewMessage({
      body: 'Hello there.',
      greeting: null,
      signature: null,
    })

    expect(composed.text).toBe('Hello there.')
    expect(composed.html).toBe('<div><p>Hello there.</p></div>')
  })

  test('keeps a signature on an attachment-only message', () => {
    const composed = composeNewMessage({
      body: '',
      greeting: null,
      signature: 'Bram',
    })

    expect(composed.text).toBe('Bram')
  })

  test('escapes the user’s text in the rich part', () => {
    const composed = composeNewMessage({
      body: '5 < 6 & 7 > 6',
      greeting: null,
      signature: null,
    })

    expect(composed.html).toContain('5 &lt; 6 &amp; 7 &gt; 6')
  })
})

describe('applyGreetingName', () => {
  test('puts the first name into the greeting', () => {
    expect(applyGreetingName('Hi {name},', 'Sarah de Vries')).toBe('Hi Sarah,')
  })

  test('uses the whole stored name for {fullname}', () => {
    expect(applyGreetingName('Hello {fullname},', 'Sarah de Vries')).toBe(
      'Hello Sarah de Vries,',
    )
  })

  test('lists every recipient, in the order addressed', () => {
    expect(
      applyGreetingName('Hi {name},', ['Alice Smith', 'Bob', 'Carol']),
    ).toBe('Hi Alice, Bob, Carol,')
    expect(
      applyGreetingName('Beste {fullname},', ['Alice Smith', 'Bob Jones']),
    ).toBe('Beste Alice Smith, Bob Jones,')
  })

  test('skips recipients with no known name', () => {
    expect(applyGreetingName('Hi {name},', ['Alice', null, '', 'Bob'])).toBe(
      'Hi Alice, Bob,',
    )
  })

  test('replaces every token, case-insensitively', () => {
    expect(applyGreetingName('{NAME}, hallo {name}!', 'Nils')).toBe(
      'Nils, hallo Nils!',
    )
    expect(applyGreetingName('{name} / {FullName}', 'Sarah de Vries')).toBe(
      'Sarah / Sarah de Vries',
    )
  })

  test('drops the token cleanly when no name is known', () => {
    expect(applyGreetingName('Hi {name},', null)).toBe('Hi,')
    expect(applyGreetingName('Hallo {name}, hoe gaat het?', '')).toBe(
      'Hallo, hoe gaat het?',
    )
    expect(applyGreetingName('Hello {fullname},', ['', null])).toBe('Hello,')
  })

  test('leaves a greeting without the token alone', () => {
    expect(applyGreetingName('Hi Sarah,', 'Nils')).toBe('Hi Sarah,')
    expect(applyGreetingName(null, 'Nils')).toBeNull()
  })
})

describe('nameFromAddress', () => {
  test('uses the local part for a plain address', () => {
    expect(nameFromAddress('bob@example.com')).toBe('bob')
  })

  test('turns separators in the local part into words', () => {
    expect(nameFromAddress('bob.stevens@example.com')).toBe('bob stevens')
    expect(nameFromAddress('bob_stevens@example.com')).toBe('bob stevens')
    expect(nameFromAddress('bob-stevens@example.com')).toBe('bob stevens')
  })

  test('leaves casing alone and keeps an address it cannot split', () => {
    expect(nameFromAddress('Bob.Stevens@example.com')).toBe('Bob Stevens')
    expect(nameFromAddress('@example.com')).toBe('@example.com')
  })
})

describe('composeReply', () => {
  test('is unchanged by the shared HTML body builder', () => {
    const composed = composeReply({
      body: 'Sure.',
      greeting: 'Hi,',
      signature: 'Bram',
    })

    // No quote and no HTML to quote, so a reply stays plain text alone.
    expect(composed.text).toBe('Hi,\n\nSure.\n\nBram')
    expect(composed.html).toBeNull()
  })
})
