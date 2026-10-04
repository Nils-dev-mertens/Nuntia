import { describe, expect, test } from 'bun:test'

import {
  cleanBody,
  htmlToPlainText,
  stripGreeting,
  stripInvisibleCharacters,
  stripQuotedText,
  stripSignature,
} from './strip.ts'
import {
  selectAttachments,
  selectBodyPart,
  hasInlineImage,
  parseRawMessage,
} from './parse.ts'
import {
  buildMimeMessage,
  composeReply,
  encodeQuotedPrintable,
  encodeHeaderValue,
} from './compose.ts'
import {
  ALL_QUOTE_FORWARD,
  APPLE_MAIL_REPLY,
  GMAIL_WEB_REPLY,
  HTML_ONLY_REPLY,
  MULTIPART_WITH_ATTACHMENTS,
  OUTLOOK_DESKTOP_REPLY,
  PLAIN_MESSAGE,
} from './fixtures.ts'

describe('stripQuotedText', () => {
  test('removes a Gmail web quote and keeps only the reply', () => {
    const { body, quote } = stripQuotedText(
      'Hi Alex,\n\nTuesday works well for me.\n\nOn Sun, 14 Jan 2024 at 18:04 Sarah Chen <sarah@example.com> wrote:\n> Can we move the launch to Tuesday?\n> Wednesday would work for me.',
    )

    expect(body).toContain('Tuesday works well for me.')
    expect(body).not.toContain('wrote:')
    expect(quote).toContain('Can we move the launch to Tuesday?')
  })

  test('removes an Outlook desktop quote including its header block', () => {
    const { body, quote } = stripQuotedText(
      'The revised figures look good to me.\n\n-----Original Message-----\nFrom: Alex Doe\nSent: Monday\nSubject: RE: numbers\n\nHere are the updated numbers.',
    )

    expect(body).toBe('The revised figures look good to me.')
    expect(quote).toContain('Here are the updated numbers.')
  })

  test('keeps a message with no quote intact', () => {
    const { body, quote } = stripQuotedText(
      'Just a plain message with no quotes.',
    )
    expect(body).toBe('Just a plain message with no quotes.')
    expect(quote).toBeNull()
  })

  test('never returns an empty body for an all-quote forward', () => {
    const { body } = stripQuotedText(
      '---------- Forwarded message ----------\nFrom: Dan\n\nHere is the thing.',
    )
    // Everything was quote, so we keep the original rather than rendering nothing.
    expect(body.length).toBeGreaterThan(0)
  })

  test('does not strip a > that appears in the first line of real content', () => {
    // A leading ">" on line 1 of a long body is far more likely to be the message.
    const { body } = stripQuotedText(
      '> This is the whole message and it is long enough to be content',
    )
    expect(body.length).toBeGreaterThan(0)
  })
})

describe('stripSignature', () => {
  test('removes an RFC 3676 signature', () => {
    const { body, signature } = stripSignature(
      'Sounds good.\n\n-- \nPriya Raman\nStaff Engineer',
    )
    expect(body).toBe('Sounds good.')
    expect(signature).toContain('Priya Raman')
  })

  test('removes a salutation-led signature', () => {
    const { body, signature } = stripSignature(
      'Please find the report attached.\n\nBest regards,\nSarah\nHead of Sales',
    )
    expect(body).toBe('Please find the report attached.')
    expect(signature).toContain('Best regards')
  })

  test('leaves a body with no signature alone', () => {
    const { signature } = stripSignature('Your invoice is attached.')
    expect(signature).toBeNull()
  })

  test('does not treat mid-body text as a signature', () => {
    const text =
      'Thanks,\n\nthat fixed it. Here is the next issue we found.\n\nIt happens on line 40.'
    const { body, signature } = stripSignature(text)
    // "Thanks," is not in the tail window, so nothing is stripped.
    expect(signature).toBeNull()
    expect(body).toBe(text.trim())
  })

  test('removes a Dutch sign-off, with or without a comma', () => {
    // The regression: only English/German closings were known, so the standard
    // Dutch "Met vriendelijke groet(en)" stayed in the bubble.
    const withComma = stripSignature(
      'Dit is een test\n\nMet vriendelijke groeten,\nNils',
    )
    expect(withComma.body).toBe('Dit is een test')
    expect(withComma.signature).toContain('Met vriendelijke groeten,')

    const lowerNoComma = stripSignature(
      'testing\n\nmet vriendelijke groet\nNils',
    )
    expect(lowerNoComma.body).toBe('testing')
    expect(lowerNoComma.signature).toContain('Nils')
  })

  test('removes a signature that includes a phone and a url', () => {
    const { body, signature } = stripSignature(
      'Alvast bedankt voor je antwoord.\n\nMet vriendelijke groeten,\nNils Mertens\n+32468127693\nhttps://nilsmertens.dev',
    )
    expect(body).toBe('Alvast bedankt voor je antwoord.')
    expect(signature).toContain('+32468127693')
    expect(signature).toContain('https://nilsmertens.dev')
  })

  test('only a whole line counts as a closing', () => {
    // "groet" inside a sentence must not start a signature.
    const text =
      'De groet van de directeur was kort.\n\nWe gaan verder met het project.'
    const { signature } = stripSignature(text)
    expect(signature).toBeNull()
  })
})

describe('stripGreeting', () => {
  test('removes a short greeting line', () => {
    const { body, greeting } = stripGreeting('Hi Sarah,\n\nTuesday works well.')
    expect(greeting).toBe('Hi Sarah,')
    expect(body).toBe('Tuesday works well.')
  })

  test('keeps a greeting that is really the content', () => {
    const { greeting } = stripGreeting('Hi')
    expect(greeting).toBeNull()
  })

  test('does not strip a long opening line that merely starts with Hi', () => {
    const text =
      'Hi, I was wondering whether we could push the launch date to next Tuesday instead'
    const { greeting } = stripGreeting(text)
    expect(greeting).toBeNull()
  })

  test('removes Dutch greetings, with and without a comma', () => {
    // The regression: only English openers were known, so `Dag Nils` stayed in
    // the bubble and Lumen looked like it was not parsing at all.
    expect(stripGreeting('Dag Nils\n\nDit is een test.').greeting).toBe(
      'Dag Nils',
    )
    expect(stripGreeting('Dag Guillaume,\n\nBedankt.').greeting).toBe(
      'Dag Guillaume,',
    )
    expect(stripGreeting('Hoi Nils,\n\nTot morgen.').greeting).toBe('Hoi Nils,')
    expect(stripGreeting('Beste heer Janssens,\n\nHierbij.').greeting).toBe(
      'Beste heer Janssens,',
    )
  })

  test('a Dutch word that merely starts with a greeting is content', () => {
    const { greeting } = stripGreeting(
      'Dagelijks nieuws van ons team,\n\nLees verder.',
    )
    expect(greeting).toBeNull()
  })
})

describe('cleanBody', () => {
  test('strips quote, signature and greeting in the right order', () => {
    // Order matters and mirrors how a real reply is laid out: the signature sits
    // above the quoted history, so quote-stripping first leaves it intact.
    const result = cleanBody(
      'Hi Alex,\n\nTuesday works for me.\n\nThanks,\nSarah\n\nOn Sun, 14 Jan Sarah <s@e.com> wrote:\n> Can we move it?',
      { stripGreeting: true, stripSignature: true },
    )

    expect(result.body).toBe('Tuesday works for me.')
    expect(result.greeting).toBe('Hi Alex,')
    expect(result.signature).toContain('Thanks')
    expect(result.quote).toContain('Can we move it?')
  })
})

describe('htmlToPlainText', () => {
  test('drops quoted blocks and converts markup', () => {
    const html =
      '<p>Hi Alex,</p><p>Looks better.</p><div class="gmail_quote"><blockquote>old stuff</blockquote></div>'
    const text = htmlToPlainText(html)

    expect(text).toContain('Looks better.')
    expect(text).not.toContain('old stuff')
    expect(text).not.toContain('<p>')
  })

  test('decodes common entities', () => {
    expect(
      htmlToPlainText('<p>Tom &amp; Jerry &mdash; &quot;hi&quot;</p>'),
    ).toContain('&')
    expect(htmlToPlainText('<p>a&nbsp;b</p>')).toBe('a b')
  })
})

describe('parseRawMessage', () => {
  test('parses a Gmail web reply', async () => {
    const msg = await parseRawMessage(GMAIL_WEB_REPLY)
    expect(msg.subject).toBe('Re: Project launch')
    expect(msg.from).toBe('sarah@example.com')
    expect(msg.to).toEqual(['me@example.com'])
    expect(msg.date).toBeInstanceOf(Date)
  })

  test('decodes an RFC 2047 encoded-word subject', async () => {
    const msg = await parseRawMessage(OUTLOOK_DESKTOP_REPLY)
    expect(msg.subject).toBe('RE: Re: Re: Quarterly numbers')
  })

  test('handles a message with no quotes', async () => {
    const msg = await parseRawMessage(PLAIN_MESSAGE)
    const { text } = selectBodyPart(msg)
    expect(text).toContain('Your invoice is attached')
    const cleaned = stripQuotedText(text!)
    expect(cleaned.quote).toBeNull()
  })

  test('parses an all-quote forward without emptying the body', async () => {
    const msg = await parseRawMessage(ALL_QUOTE_FORWARD)
    const { text } = selectBodyPart(msg)
    const cleaned = stripQuotedText(text!)
    expect(cleaned.body.length).toBeGreaterThan(0)
  })

  test('parses HTML-only mail via the html fallback', async () => {
    const msg = await parseRawMessage(HTML_ONLY_REPLY)
    const { text, html } = selectBodyPart(msg)
    expect(text).toBeNull()
    expect(html).toContain('gmail_quote')
  })

  test('extracts inline image and pdf attachments from multipart', async () => {
    const msg = await parseRawMessage(MULTIPART_WITH_ATTACHMENTS)
    const attachments = selectAttachments(msg)

    const image = attachments.find((a) => a.contentType === 'image/png')
    expect(image?.disposition).toBe('inline')
    expect(image?.filename).toBe('chart.png')

    const pdf = attachments.find((a) => a.contentType === 'application/pdf')
    expect(pdf?.disposition).toBe('attachment')
    expect(pdf?.filename).toBe('report.pdf')

    expect(hasInlineImage(attachments)).toBe(true)
  })

  test('returns an empty message instead of throwing on garbage input', async () => {
    const msg = await parseRawMessage('this is not a mime message at all')
    expect(msg.parts).toEqual([])
  })
})

describe('composeReply', () => {
  test('restores greeting and signature around the body', () => {
    const out = composeReply({
      body: 'Tuesday works for me.',
      greeting: 'Hi Sarah,',
      signature: 'Thanks,\nSarah',
    })

    expect(out.text).toBe(
      'Hi Sarah,\n\nTuesday works for me.\n\nThanks,\nSarah',
    )
  })

  test('quotes the original thread when asked', () => {
    const original = {
      subject: 'Project launch',
      from: 'alex@example.com',
      to: ['sarah@example.com'],
      cc: [],
      date: new Date('2024-01-14T18:04:00Z'),
      parts: [{ contentType: 'text/plain', text: 'Do we have a date yet?' }],
    }

    const out = composeReply({
      body: 'Tuesday works.',
      greeting: 'Hi Alex,',
      quoteOriginal: true,
      original,
    })

    expect(out.text).toContain('wrote:')
    expect(out.text).toContain('> Do we have a date yet?')
    expect(out.text.indexOf('Tuesday works.')).toBeLessThan(
      out.text.indexOf('> Do we'),
    )
  })

  test('puts the signature above the quoted history, not below it', () => {
    const original = {
      subject: 'Project launch',
      from: 'alex@example.com',
      to: ['sarah@example.com'],
      cc: [],
      date: new Date('2024-01-14T18:04:00Z'),
      parts: [{ contentType: 'text/plain', text: 'Do we have a date yet?' }],
    }

    const out = composeReply({
      body: 'Tuesday works.',
      greeting: 'Hi Alex,',
      signature: 'Thanks,\nSarah',
      quoteOriginal: true,
      original,
    })

    // The signature is part of the reply, so quoting it back below the history
    // read as if it belonged to the other person.
    expect(out.text.indexOf('Thanks,')).toBeLessThan(
      out.text.indexOf('> Do we'),
    )
    expect(out.text.indexOf('Tuesday works.')).toBeLessThan(
      out.text.indexOf('Thanks,'),
    )
  })
})

describe('encodeQuotedPrintable', () => {
  test('encodes non-ascii and escapes equals', () => {
    // UTF-8 bytes, not code points: é is U+00E9 but occupies two bytes.
    expect(encodeQuotedPrintable('café')).toBe('caf=C3=A9')
    expect(encodeQuotedPrintable('a=b')).toBe('a=3Db')
  })

  test('passes plain ascii through', () => {
    expect(encodeQuotedPrintable('hello world')).toBe('hello world')
  })

  test('encodes multi-byte characters as UTF-8 bytes, not code points', () => {
    // U+2014 must be =E2=80=94. Encoding the code point gives =2014, which a
    // decoder misreads as =20 (a space) followed by literal "14".
    expect(encodeQuotedPrintable('—')).toBe('=E2=80=94')
  })

  test('round-trips through the decoder', () => {
    const original = 'Grüße aus München — ein längerer Text mit Umlauten.'
    const encoded = encodeQuotedPrintable(original)

    // Soft line breaks are "=" at EOL. Decode =XX as UTF-8 bytes.
    const bytes: number[] = []
    for (const line of encoded.split('\r\n')) {
      const isLast = line === encoded.split('\r\n').at(-1)
      const content = isLast ? line : line.replace(/=$/, '')
      for (let i = 0; i < content.length; i++) {
        if (content[i] === '=') {
          bytes.push(parseInt(content.slice(i + 1, i + 3), 16))
          i += 2
        } else {
          bytes.push(content.charCodeAt(i))
        }
      }
      // Newlines between encoded lines are real line breaks, not soft breaks.
      if (!isLast) bytes.push(10)
    }

    expect(new TextDecoder('utf-8').decode(new Uint8Array(bytes))).toBe(
      original,
    )
  })
})

describe('round trip', () => {
  test('clean then compose restores a recognisable email', () => {
    const source =
      'Hi Sarah,\n\nTuesday works well for me.\n\nThanks,\nSarah\n\nOn Sun, 14 Jan Sarah <s@e.com> wrote:\n> Can we move it?'

    const cleaned = cleanBody(source, {
      stripGreeting: true,
      stripSignature: true,
    })
    expect(cleaned.body).toBe('Tuesday works well for me.')

    const sent = composeReply({
      body: cleaned.body,
      greeting: cleaned.greeting,
      signature: cleaned.signature,
      quoteOriginal: true,
      original: {
        subject: 'Project launch',
        from: 'sarah@example.com',
        to: ['me@example.com'],
        cc: [],
        date: new Date('2024-01-14T18:04:00Z'),
        parts: [{ contentType: 'text/plain', text: 'Can we move it?' }],
      },
    })

    expect(sent.text).toContain('Hi Sarah,')
    expect(sent.text).toContain('Tuesday works well for me.')
    expect(sent.text).toContain('Thanks,')
    expect(sent.text).toContain('> Can we move it?')
  })

  test('apple mail reply survives parse and clean', async () => {
    const msg = await parseRawMessage(APPLE_MAIL_REPLY)
    const { text } = selectBodyPart(msg)
    const cleaned = cleanBody(text!, {
      stripGreeting: true,
      stripSignature: true,
    })

    expect(cleaned.body).toBe('Sounds good, see you then.')
    expect(cleaned.greeting).toBe('Hey!')
    expect(cleaned.quote).toContain('Lunch at 1?')
  })
})
describe('stripInvisibleCharacters', () => {
  test('removes the invisible filler newsletters pad with', () => {
    // U+2007 figure space + U+034F combining grapheme joiner, as used for
    // invisible line filler. These survive every Cf-only filter. Written as
    // escapes because the literal characters trip no-irregular-whitespace.
    const filler = ' ͏  ͏  ͏'
    const filled = `Block one\n${filler}\nBlock two`

    expect(stripInvisibleCharacters(filled)).toBe('Block one\n\nBlock two')
  })

  test('removes a byte order mark from the start of a part', () => {
    expect(stripInvisibleCharacters('﻿Hello')).toBe('Hello')
  })

  test('removes soft hyphens a sender inserted for line breaking', () => {
    expect(stripInvisibleCharacters('ex­tra­ordinary')).toBe('extraordinary')
  })

  test('removes zero-width joiners and directional marks', () => {
    expect(stripInvisibleCharacters('a‍b‮c')).toBe('abc')
  })

  test('leaves real text alone, including non-ASCII punctuation', () => {
    const text = 'Grüße — café, €99, “quoted”, 100% sure'

    expect(stripInvisibleCharacters(text)).toBe(text)
  })

  test('collapses a line left with nothing but spacing', () => {
    // The filler was faking vertical space; keeping the empty line would render
    // a gap the user never asked for.
    expect(stripInvisibleCharacters('Above\n   \nBelow')).toBe('Above\n\nBelow')
  })

  test('returns an empty string unchanged', () => {
    expect(stripInvisibleCharacters('')).toBe('')
  })
})

describe('composeReply html part', () => {
  const original = {
    subject: 'Order 123',
    from: 'shop@example.com',
    to: ['me@example.com'],
    cc: [],
    date: new Date('2024-01-14T18:04:00Z'),
    parts: [
      { contentType: 'text/plain' as const, text: 'Your order shipped.' },
    ],
  }

  test('has no html part when there is nothing rich to quote', () => {
    const out = composeReply({ body: 'Thanks!', original })

    // Sending an empty text/html part would be worse than sending none.
    expect(out.html).toBeNull()
  })

  test('quotes the original html in a blockquote', () => {
    const out = composeReply({
      body: 'Thanks!',
      original,
      quoteOriginal: true,
      originalHtml: '<p>Your order shipped.</p>',
    })

    expect(out.html).toContain('<blockquote>')
    expect(out.html).toContain('<p>Your order shipped.</p>')
  })

  test('keeps the user text out of the html markup', () => {
    const out = composeReply({
      body: 'Thanks <b>!</b>',
      original,
      quoteOriginal: true,
      originalHtml: '<p>x</p>',
    })

    expect(out.html).toContain('&lt;b&gt;')
  })

  test('renders newlines in the body as breaks', () => {
    const out = composeReply({
      body: 'line one\nline two',
      original,
      quoteOriginal: true,
      originalHtml: '<p>x</p>',
    })

    expect(out.html).toContain('line one<br>line two')
  })

  test('puts the signature above the blockquote', () => {
    const out = composeReply({
      body: 'Thanks for the update.',
      signature: 'Best,\nNils',
      original,
      quoteOriginal: true,
      originalHtml: '<p>Your order shipped.</p>',
    })

    expect(out.html).not.toBeNull()
    const html = out.html as string
    expect(html.indexOf('Best,')).toBeLessThan(html.indexOf('<blockquote>'))
    expect(html.indexOf('Thanks for the update.')).toBeLessThan(
      html.indexOf('Best,'),
    )
  })
})

describe('buildMimeMessage', () => {
  test('sends a single text/plain part when there is no html', () => {
    const { raw } = buildMimeMessage({
      to: ['a@b.c'],
      subject: 'Hello',
      body: 'Hi there',
    })

    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"')
    expect(raw).not.toContain('multipart')
  })

  test('sends multipart/alternative with plain first and html second', () => {
    // RFC 2046: clients pick the last part they understand, so the rich part
    // must come second or it is silently ignored.
    const { raw } = buildMimeMessage({
      to: ['a@b.c'],
      subject: 'Hello',
      body: 'Hi there',
      html: '<p>Hi there</p>',
    })

    expect(raw).toContain('multipart/alternative')
    expect(raw.indexOf('text/plain')).toBeLessThan(raw.indexOf('text/html'))
  })

  test('produces identical bytes for identical input', () => {
    // The boundary is content-derived, not random, which is what makes the
    // composed message comparable in a test at all.
    const args = {
      to: ['a@b.c'],
      subject: 'Hello',
      body: 'Hi there',
      html: '<p>Hi there</p>',
    }

    expect(buildMimeMessage(args).raw).toBe(buildMimeMessage(args).raw)
  })

  test('does not let the body collide with the boundary', () => {
    const first = buildMimeMessage({
      to: ['a@b.c'],
      subject: 'Hello',
      body: 'x',
      html: '<p>x</p>',
    })
    const boundary = /boundary="([^"]+)"/.exec(first.raw)?.[1] as string

    const body = `trouble\n--${boundary}\nnot a boundary`
    const { raw } = buildMimeMessage({
      to: ['a@b.c'],
      subject: 'Hello',
      body,
      html: '<p>x</p>',
    })

    expect(/boundary="([^"]+)"/.exec(raw)?.[1]).not.toBe(boundary)
  })

  test('wraps text and html alternatives with binary attachments', () => {
    const { raw } = buildMimeMessage({
      to: ['a@b.c'],
      subject: 'Hello',
      body: 'Hi there',
      html: '<p>Hi there</p>',
      attachments: [
        {
          filename: 'résumé.pdf',
          contentType: 'application/pdf',
          data: new Uint8Array([0, 255, 1, 128]),
        },
      ],
    })

    expect(raw).toContain('Content-Type: multipart/mixed;')
    expect(raw).toContain('Content-Type: multipart/alternative;')
    expect(raw.indexOf('text/plain')).toBeLessThan(raw.indexOf('text/html'))
    expect(raw).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.pdf")
    expect(raw).toContain('Content-Transfer-Encoding: base64')
    expect(raw).toContain('AP8BgA==')
  })

  test('sends a binary attachment even without an html alternative', () => {
    const { raw } = buildMimeMessage({
      to: ['a@b.c'],
      subject: 'Hello',
      body: 'See attached.',
      attachments: [
        {
          filename: 'note.txt',
          contentType: 'text/plain',
          data: new Uint8Array([104, 105]),
        },
      ],
    })

    expect(raw).toContain('Content-Type: multipart/mixed;')
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"')
    expect(raw).toContain('aGk=')
  })

  test('keeps an ascii subject readable', () => {
    expect(
      buildMimeMessage({ to: ['a@b.c'], subject: 'Hello', body: 'x' }).raw,
    ).toContain('Subject: Hello')
  })
})

describe('encodeHeaderValue', () => {
  test('leaves plain ascii untouched', () => {
    expect(encodeHeaderValue('Re: Project launch')).toBe('Re: Project launch')
  })

  test('encodes a subject with an emoji', () => {
    // A raw UTF-8 header is not legal RFC 5322 and clients mangle it.
    const encoded = encodeHeaderValue('Re: \u{1F5A4} deal')

    expect(encoded.startsWith('=?UTF-8?B?')).toBe(true)
    expect(encoded.endsWith('?=')).toBe(true)
    expect(encoded).not.toContain('\u{1F5A4}')
  })

  test('round-trips through the base64 payload', () => {
    const encoded = encodeHeaderValue('Re: \u{1F5A4} deal')
    const payload = /B\?([^?]+)\?=/.exec(encoded)?.[1] as string

    // atob yields one character per *byte*, so the UTF-8 bytes have to be
    // reassembled before they can be read back as text.
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))
    expect(new TextDecoder('utf-8').decode(bytes)).toBe('Re: \u{1F5A4} deal')
  })
})
