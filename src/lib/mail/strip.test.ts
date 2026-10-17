import { describe, expect, test } from 'bun:test'

import {
  cleanBody,
  stripCidPlaceholders,
  stripGreeting,
  stripSignature,
} from './strip.ts'

describe('stripGreeting', () => {
  test('strips a known opener with a name', () => {
    expect(stripGreeting('Dag Guillaume,\n\nVoor het vak.')).toEqual({
      body: 'Voor het vak.',
      greeting: 'Dag Guillaume,',
    })
  })

  test('strips the greeting and keeps the message on the same line', () => {
    // The bug this guards: the whole first line used to be removed, so a
    // greeting that shares its line took the content with it.
    expect(stripGreeting('Hi Sarah, how are you?\n\nAdjust')).toEqual({
      body: 'how are you?\n\nAdjust',
      greeting: 'Hi Sarah,',
    })
  })

  test('splits an opener that ends in a bare comma', () => {
    expect(
      stripGreeting('Hi, I was wondering whether we could push the launch'),
    ).toEqual({
      body: 'I was wondering whether we could push the launch',
      greeting: 'Hi,',
    })
  })

  test('strips a one-word exclamation greeting', () => {
    expect(stripGreeting('Hey!\n\nLong time no see.')).toEqual({
      body: 'Long time no see.',
      greeting: 'Hey!',
    })
  })

  test('keeps a long opening line that merely starts with an opener', () => {
    // A whole sentence that opens with `Hi,` is content; only a short
    // salutation-plus-question is split.
    const text =
      'Hi, I was wondering whether we could push the launch date to next Tuesday instead'
    expect(stripGreeting(text)).toEqual({ body: text, greeting: null })
  })

  test('keeps a sentence that merely starts with an opener word', () => {
    const text = 'Morning light streamed in through the window.'
    expect(stripGreeting(text)).toEqual({ body: text, greeting: null })
  })

  test('strips a bare-name salutation line', () => {
    expect(stripGreeting('Nils,\n\nZet deze volgende stappen')).toEqual({
      body: 'Zet deze volgende stappen',
      greeting: 'Nils,',
    })
  })

  test('keeps a discourse word that looks like a name', () => {
    for (const text of ['Anyway,\n\ndit is de kern.', 'Sure,\n\nik doe het.']) {
      expect(stripGreeting(text)).toEqual({ body: text, greeting: null })
    }
  })

  test('does not mistake a word beginning with an opener for one', () => {
    const text = 'Dagelijks krijg je een mail.'
    expect(stripGreeting(text)).toEqual({ body: text, greeting: null })
  })

  test('does not strip a newsletter headline', () => {
    for (const text of [
      'Suggesties voor u\n\nChris deelde iets.',
      'AWESOME NEWS\n\nIssue 25.',
    ]) {
      expect(stripGreeting(text)).toEqual({ body: text, greeting: null })
    }
  })

  test('keeps a greeting that is the whole message', () => {
    expect(stripGreeting('Hi Alex,')).toEqual({
      body: 'Hi Alex,',
      greeting: null,
    })
  })
})

describe('stripSignature', () => {
  test('strips the Dutch standard closing', () => {
    expect(stripSignature('testing\n\nMet vriendelijke groeten\nNils')).toEqual(
      {
        body: 'testing',
        signature: 'Met vriendelijke groeten\nNils',
      },
    )
  })

  test('strips closings the old list did not know', () => {
    expect(stripSignature('Iets.\n\nGroetjes,\nJan').signature).toBe(
      'Groetjes,\nJan',
    )
    expect(stripSignature('Iets.\n\nBedankt!').signature).toBe('Bedankt!')
  })

  test('strips a sign-off that carries the name on the same line', () => {
    expect(stripSignature('Iets.\n\nGroetjes, Nils')).toEqual({
      body: 'Iets.',
      signature: 'Groetjes, Nils',
    })
  })

  test('strips a signature of a name and contact details with no closing word', () => {
    const text =
      'Voor het vak.\n\nNils Mertens\n+32468127693\nhttps://nilsmertens.dev'
    expect(stripSignature(text)).toEqual({
      body: 'Voor het vak.',
      signature: 'Nils Mertens\n+32468127693\nhttps://nilsmertens.dev',
    })
  })

  test('strips a trailing two-word name', () => {
    expect(stripSignature('Katten zijn tof.\n\nNils Mertens')).toEqual({
      body: 'Katten zijn tof.',
      signature: 'Nils Mertens',
    })
  })

  test('keeps a lone single-word tail, which only barely looks like a name', () => {
    // `E-mailvoorkeuren` and `Unsubscribe` end newsletters the same way a person
    // signs their first name. One word is not enough evidence to strip it.
    for (const text of [
      'Katten zijn tof.\n\nNils',
      'Some body.\n\nE-mailvoorkeuren',
    ]) {
      expect(stripSignature(text)).toEqual({ body: text, signature: null })
    }
  })

  test('does not strip a name glued to the last sentence', () => {
    const text = 'Katten zijn tof.\nNils'
    expect(stripSignature(text)).toEqual({ body: text, signature: null })
  })

  test('does not read a sentence as a signature', () => {
    const text = 'Something.\n\nThanks, I will send it'
    expect(stripSignature(text)).toEqual({ body: text, signature: null })
  })

  test('does not strip a contact-only footer', () => {
    const text = 'Some body.\n\nwelkom@superprof.com\nE-mail voorkeuren'
    expect(stripSignature(text)).toEqual({ body: text, signature: null })
  })

  test('never strips the whole message', () => {
    expect(stripSignature('Nils')).toEqual({ body: 'Nils', signature: null })
  })
})

describe('cleanBody', () => {
  test('applies quotes, then signature, then greeting', () => {
    const result = cleanBody(
      [
        'Dag Guillaume,',
        '',
        'Voor het vak.',
        '',
        'Alvast bedankt!',
        'Met vriendelijke groeten,',
        'Nils Mertens',
      ].join('\n'),
      { stripQuotedHistory: true, stripGreeting: true, stripSignature: true },
    )

    expect(result.greeting).toBe('Dag Guillaume,')
    expect(result.signature).toContain('Met vriendelijke groeten')
    expect(result.body).toBe('Voor het vak.\n\nAlvast bedankt!')
  })
})

describe('stripCidPlaceholders', () => {
  test('drops a placeholder on its own line, and the line with it', () => {
    // The shape that reaches us from Outlook: a signature whose last line is a
    // logo the text part could only render as this token.
    const body = 'Groeten,\nNils\n[cid:logo]'
    expect(stripCidPlaceholders(body)).toBe('Groeten,\nNils')
  })

  test('drops a placeholder that has text around it on the same line', () => {
    const out = stripCidPlaceholders('Zie [cid:chart] hierboven.')
    expect(out).toBe('Zie hierboven.')
    expect(out).not.toContain('  ')
  })

  test('drops several placeholders and the blank line they leave', () => {
    expect(stripCidPlaceholders('a\n[cid:one]\n[cid:two]\nb')).toBe('a\nb')
  })

  test('matches the token case-insensitively', () => {
    expect(stripCidPlaceholders('hi\n[CID:Logo]')).toBe('hi')
  })

  test('leaves ordinary bracketed text alone', () => {
    // `[cid:...]` is the only shape a mail client generates; a reader referring
    // to one in prose should not be able to trigger this.
    const body = 'The [cid] parameter and [cider] are fine.\n\nRegards'
    expect(stripCidPlaceholders(body)).toBe(body)
  })

  test('leaves a body with no placeholder untouched, including its spacing', () => {
    const body = 'Column A    Column B\nNext line'
    expect(stripCidPlaceholders(body)).toBe(body)
  })

  test('handles an empty body', () => {
    expect(stripCidPlaceholders('')).toBe('')
  })
})
