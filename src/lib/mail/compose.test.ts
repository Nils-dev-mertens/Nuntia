/**
 * A new message restores the greeting and signature the same way a reply does —
 * the user types only what they want to say. These are the parts of that
 * restoration that are pure: what the two representations contain, and what
 * happens when there is nothing to restore.
 */

import { describe, expect, test } from 'bun:test'

import { composeNewMessage, composeReply } from './compose.ts'

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

  test('renders a styled signature in HTML and strips its markers in text', () => {
    const composed = composeNewMessage({
      body: 'Talk soon.',
      greeting: null,
      signature:
        '**Bram de Vries**\n*Available Tue–Thu*\n[Book a call](https://example.com/meet)',
    })

    expect(composed.html).toContain('<strong>Bram de Vries</strong>')
    expect(composed.html).toContain('<em>Available Tue–Thu</em>')
    expect(composed.html).toContain(
      '<a href="https://example.com/meet">Book a call</a>',
    )
    expect(composed.text).toContain('Bram de Vries')
    expect(composed.text).not.toContain('**')
    expect(composed.text).not.toContain('](')
  })

  test('never turns a non-http link into an anchor', () => {
    const composed = composeNewMessage({
      body: 'Hi.',
      greeting: null,
      signature: '[click](javascript:alert(1))',
    })

    expect(composed.html).not.toContain('<a ')
    expect(composed.html).not.toContain('href=')
  })
})

describe('composeReply', () => {
  test('keeps a styled signature in the HTML part even without a rich quote', () => {
    const composed = composeReply({
      body: 'Sure.',
      greeting: 'Hi,',
      signature: '**Bram**',
    })

    expect(composed.html).toContain('<strong>Bram</strong>')
    expect(composed.text).toContain('Bram')
    expect(composed.text).not.toContain('**')
  })

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
