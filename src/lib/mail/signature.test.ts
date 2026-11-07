import { describe, expect, test } from 'bun:test'

import { applySignatureFormat, signatureToHtml } from './signature.ts'

describe('applySignatureFormat', () => {
  test('wraps the selection in bold markers and keeps it selected', () => {
    expect(applySignatureFormat('Hi Sarah', 3, 8, 'bold')).toEqual({
      value: 'Hi **Sarah**',
      selectionStart: 5,
      selectionEnd: 10,
    })
  })

  test('wraps the selection in italic markers', () => {
    expect(applySignatureFormat('Available', 0, 9, 'italic')).toEqual({
      value: '*Available*',
      selectionStart: 1,
      selectionEnd: 10,
    })
  })

  test('selects the URL when a link label already exists', () => {
    expect(applySignatureFormat('Book a call now', 0, 11, 'link')).toEqual({
      value: '[Book a call](https://example.com) now',
      selectionStart: 14,
      selectionEnd: 33,
    })
  })

  test('inserts a placeholder label and selects it when nothing is selected', () => {
    expect(applySignatureFormat('', 0, 0, 'link')).toEqual({
      value: '[link text](https://example.com)',
      selectionStart: 1,
      selectionEnd: 10,
    })
  })

  test('the inserted markup renders as the styling it promises', () => {
    const bold = applySignatureFormat('Sarah', 0, 5, 'bold')
    expect(signatureToHtml(bold.value)).toBe('<p><strong>Sarah</strong></p>')

    const italic = applySignatureFormat('sarah@example.com', 0, 0, 'italic')
    expect(signatureToHtml(italic.value)).toBe(
      '<p><em>italic</em>sarah@example.com</p>',
    )

    const link = applySignatureFormat('Calendar', 0, 8, 'link')
    expect(signatureToHtml(link.value)).toBe(
      '<p><a href="https://example.com">Calendar</a></p>',
    )
  })
})
