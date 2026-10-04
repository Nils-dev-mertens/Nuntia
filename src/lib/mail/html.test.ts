import { describe, expect, test } from 'bun:test'

import {
  extractHtmlBody,
  htmlToPlainText,
  stripHtmlGreeting,
  stripHtmlSignature,
  stripQuotedHtml,
} from './html.ts'

/**
 * Real Outlook desktop reply: the quoted history sits inside three nested divs,
 * which is exactly what broke the old regex implementation.
 */
const OUTLOOK_NESTED = `
<div>
  <p>Hi Alex,</p>
  <p>The revised figures look good.</p>
  <div>
    <div>
      <div>
        <hr>
        <div id="appendonsend"></div>
        <hr>
        <div id="divRplyFwdMsg">
          <p><b>From:</b> Alex Doe</p>
          <p><b>Sent:</b> Monday, January 15, 2024</p>
          <p>Here are the updated numbers.</p>
          <blockquote>Nested deeper still.</blockquote>
        </div>
      </div>
    </div>
  </div>
  <p>Thanks</p>
</div>`

const GMAIL_QUOTE = `
<div dir="ltr">Hi Alex,</div>
<div dir="ltr"><br>The new layout looks much better.</div>
<div class="gmail_quote">
  <div dir="ltr">On Mon, 22 Jan 2024 at 13:00 Alex wrote:<br></div>
  <blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">
    <div dir="ltr">Here is the old layout.</div>
  </blockquote>
</div>`

describe('extractHtmlBody', () => {
  test('removes a deeply nested Outlook quote and keeps the surrounding text', () => {
    const { body, quote } = extractHtmlBody(OUTLOOK_NESTED)

    // Content above the quote survives.
    expect(body).toContain('The revised figures look good.')
    // Content below the quote survives too — the old regex ate this.
    expect(body).toContain('Thanks')
    // Everything inside the quote container is gone.
    expect(body).not.toContain('updated numbers')
    expect(body).not.toContain('Nested deeper still')
    expect(body).not.toContain('Alex Doe')

    expect(quote).toContain('Here are the updated numbers.')
    expect(quote).toContain('Nested deeper still')
  })

  test('handles a Gmail quote block', () => {
    const { body, quote } = extractHtmlBody(GMAIL_QUOTE)

    expect(body).toContain('Hi Alex,')
    expect(body).toContain('The new layout looks much better.')
    expect(body).not.toContain('old layout')
    expect(quote).toContain('old layout')
  })

  test('returns the whole message when there is no quote markup', () => {
    const { body, quote } = extractHtmlBody('<p>Just a simple message.</p>')
    expect(body).toBe('Just a simple message.')
    expect(quote).toBeNull()
  })

  test('never returns an empty body for an all-quote forward', () => {
    const { body } = extractHtmlBody(
      '<div class="gmail_quote"><div>Forwarded content only.</div></div>',
    )
    expect(body).toContain('Forwarded content only.')
  })

  test('drops script and style content', () => {
    const { body } = extractHtmlBody(
      '<style>.x{color:red}</style><script>alert(1)</script><p>Visible</p>',
    )
    expect(body).toBe('Visible')
    expect(body).not.toContain('alert')
  })

  test('converts block elements and list items to line breaks', () => {
    const { body } = extractHtmlBody(
      '<p>One</p><ul><li>First</li><li>Second</li></ul>',
    )
    expect(body).toContain('One')
    expect(body).toContain('- First')
    expect(body).toContain('- Second')
  })

  test('preserves inline formatting as text without tags', () => {
    const { body } = extractHtmlBody(
      '<p>Hello <b>bold</b> and <i>italic</i></p>',
    )
    expect(body).toBe('Hello bold and italic')
  })

  test('survives malformed HTML without throwing', () => {
    expect(() => extractHtmlBody('<div><p>unclosed <b>bold')).not.toThrow()
    expect(() => extractHtmlBody('<<<>>>')).not.toThrow()
    expect(extractHtmlBody('').body).toBe('')
  })

  test('handles nested quotes of the same client (reply to a reply)', () => {
    const { body, quote } = extractHtmlBody(`
      <p>Latest reply.</p>
      <div class="gmail_quote">
        <p>Middle message.</p>
        <div class="gmail_quote">
          <p>Oldest message.</p>
        </div>
      </div>`)

    expect(body).toBe('Latest reply.')
    expect(quote).toContain('Middle message.')
    expect(quote).toContain('Oldest message.')
  })
})

describe('stripQuotedHtml', () => {
  test('removes the quote subtree but keeps surrounding HTML', () => {
    const html = stripQuotedHtml(
      '<div><p>Mine</p><div class="gmail_quote"><p>Theirs</p></div><p>Also mine</p></div>',
    )
    expect(html).toContain('Mine')
    expect(html).toContain('Also mine')
    expect(html).not.toContain('Theirs')
  })

  test('returns the input unchanged when there is no quote', () => {
    const html = '<p>Nothing quoted</p>'
    expect(stripQuotedHtml(html)).toBe(html)
  })
})

describe('htmlToPlainText', () => {
  test('is the body half of extractHtmlBody', () => {
    expect(htmlToPlainText(OUTLOOK_NESTED)).toBe(
      extractHtmlBody(OUTLOOK_NESTED).body,
    )
  })

  test('decodes entities that appear in mail', () => {
    const text = htmlToPlainText(
      '<p>Tom &amp; Jerry &mdash; &quot;hi&quot;</p>',
    )
    expect(text).toContain('&')
    expect(text).toContain('—')
    expect(text).toContain('"hi"')
  })

  test('converts non-breaking space to a normal space', () => {
    expect(htmlToPlainText('<p>a&nbsp;b</p>')).toBe('a b')
  })
})
describe('stripHtmlGreeting', () => {
  test('removes the salutation and keeps the body', () => {
    const out = stripHtmlGreeting(
      '<div>Hi Sarah,</div><div>Can you help with this?</div>',
      'Hi Sarah,',
    )

    expect(out).toContain('Can you help with this?')
    expect(out).not.toContain('Hi Sarah')
  })

  test('removes a salutation split across inline tags', () => {
    // The greeting cannot be found by looking at any single element's text.
    const out = stripHtmlGreeting(
      '<p><b>Hi</b> Sarah,</p><p>Body</p>',
      'Hi Sarah,',
    )

    expect(out).toContain('Body')
    expect(out).not.toContain('Sarah')
  })

  test('removes a salutation spread across separate block elements', () => {
    const out = stripHtmlGreeting(
      '<div>Hi</div><div>Sarah,</div><div>Body</div>',
      'Hi Sarah,',
    )

    expect(out).toContain('Body')
    expect(out).not.toContain('Sarah')
  })

  test('leaves the HTML alone when the greeting is not at the start', () => {
    const html = '<div>Hello world</div>'

    expect(stripHtmlGreeting(html, 'Hi Sarah,')).toBe(html)
  })

  test('leaves the HTML alone when the greeting does not match', () => {
    const html = '<div>Hi Sarah,</div><div>Body</div>'

    expect(stripHtmlGreeting(html, 'Hi Everyone,')).toBe(html)
  })

  test('leaves the HTML alone for a null greeting', () => {
    const html = '<div>Hi Sarah,</div>'

    expect(stripHtmlGreeting(html, null)).toBe(html)
  })

  test('drops the emptied element so its spacing goes with it', () => {
    // An empty <div> still occupies its margin, so leaving the shell behind
    // leaves a visible gap where the salutation was.
    const out = stripHtmlGreeting(
      '<div style="margin-bottom:20px">Hi Sarah,</div><div>Body</div>',
      'Hi Sarah,',
    )

    expect(out).not.toContain('margin-bottom')
    expect(out).toBe('<div>Body</div>')
  })

  test('handles a non-breaking space between words', () => {
    const out = stripHtmlGreeting(
      '<div>Hi&nbsp;Sarah,</div><div>Body</div>',
      'Hi Sarah,',
    )

    expect(out).toContain('Body')
    expect(out).not.toContain('Sarah')
  })
})

describe('stripHtmlSignature', () => {
  test('removes a signature spanning several lines', () => {
    const out = stripHtmlSignature(
      '<div>Thanks</div><div>--</div><div>Nils</div><div>+31 6 1234</div>',
      '--\nNils\n+31 6 1234',
    )

    expect(out).toContain('Thanks')
    expect(out).not.toContain('Nils')
    expect(out).not.toContain('+31')
  })

  test('removes a one-line signature', () => {
    const out = stripHtmlSignature(
      '<div>Sent from my iPhone</div>',
      'Sent from my iPhone',
    )

    expect(out).not.toContain('iPhone')
  })

  test('removes a salutation plus name, leaving the body', () => {
    const out = stripHtmlSignature(
      '<div>Body</div><div>Best regards,</div><div>Nils</div>',
      'Best regards,\nNils',
    )

    expect(out).toContain('Body')
    expect(out).not.toContain('regards')
    expect(out).not.toContain('Nils')
  })

  test('leaves the HTML alone when the signature is not at the end', () => {
    const html = '<div>Body</div>'

    expect(stripHtmlSignature(html, '--\nNils')).toBe(html)
  })

  test('leaves the HTML alone for a null signature', () => {
    const html = '<div>Body</div>'

    expect(stripHtmlSignature(html, null)).toBe(html)
  })
})
