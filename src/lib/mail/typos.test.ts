/**
 * The typing-slip pass the composer offers before a message leaves.
 *
 * The rules are few, so the tests are the specification: what gets fixed, what
 * is deliberately left alone, and the fact that paragraph breaks survive.
 */

import { describe, expect, test } from 'bun:test'

import { fixTypingSlips } from './typos.ts'

describe('fixTypingSlips', () => {
  test('leaves clean text exactly as it was', () => {
    const text = 'Hoi Nils,\n\nTot donderdag.\n\nBram'
    const result = fixTypingSlips(text)

    expect(result.text).toBe(text)
    expect(result.fixes).toEqual([])
  })

  test('removes a doubled word and keeps the capital it started with', () => {
    expect(fixTypingSlips('Thanks for the the update.').text).toBe(
      'Thanks for the update.',
    )
    expect(fixTypingSlips('The the plan works.').text).toBe('The plan works.')
  })

  test('tidies the spacing around punctuation', () => {
    expect(fixTypingSlips('Hi ,there .').text).toBe('Hi, there.')
    expect(fixTypingSlips('Hoi Nils,hier is het.').text).toBe(
      'Hoi Nils, hier is het.',
    )
    expect(fixTypingSlips('Done.Next thing.').text).toBe('Done. Next thing.')
    expect(fixTypingSlips('a  b   c').text).toBe('a b c')
  })

  test('restores the apostrophes people drop', () => {
    expect(fixTypingSlips('I dont know if it wont work.').text).toBe(
      "I don't know if it won't work.",
    )
    expect(fixTypingSlips('Dont worry.').text).toBe("Don't worry.")
  })

  test('never rewrites an address or a link', () => {
    const text = 'Mail dont@example.com or see http://dont.example.com/teh'
    const result = fixTypingSlips(text)

    expect(result.text).toBe(text)
    expect(result.fixes).toEqual([])
  })

  test('keeps paragraph breaks and the line endings they arrived with', () => {
    const text = 'One.\r\n\r\nTwo.\r\n'
    expect(fixTypingSlips(text).text).toBe(text)
  })

  test('returns nothing to do for blank text', () => {
    expect(fixTypingSlips('   ')).toEqual({ text: '   ', fixes: [] })
    expect(fixTypingSlips('')).toEqual({ text: '', fixes: [] })
  })

  test('describes each change, so the composer can say what it did', () => {
    const result = fixTypingSlips('the the teh dont')

    expect(result.text).toBe("the the don't")
    expect(result.fixes.length).toBeGreaterThan(0)
    expect(result.fixes.join(' ')).toContain("don't")
  })
})
