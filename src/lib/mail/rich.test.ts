import { describe, expect, test } from 'bun:test'

import { isRichHtml } from './rich.ts'

describe('isRichHtml', () => {
  test('is false for the containers a plain message is padded with', () => {
    expect(isRichHtml('<div>Just some words.</div>')).toBe(false)
    expect(isRichHtml('<p>One</p><p>Two</p>')).toBe(false)
    expect(isRichHtml('<span>Hi</span><br><span>there</span>')).toBe(false)
    expect(
      isRichHtml('<div><a href="https://example.com">a link</a></div>'),
    ).toBe(false)
  })

  test('is true when the HTML carries layout', () => {
    expect(isRichHtml('<table><tr><td>cell</td></tr></table>')).toBe(true)
    expect(isRichHtml('<h1>Headline</h1>')).toBe(true)
    expect(isRichHtml('<ul><li>one</li></ul>')).toBe(true)
    expect(isRichHtml('<p>See <img src="cid:logo"></p>')).toBe(true)
    expect(isRichHtml('<blockquote>quoted</blockquote>')).toBe(true)
  })

  test('is true for inline styles, which the plain body cannot reproduce', () => {
    expect(isRichHtml('<div><span style="color:red">red</span></div>')).toBe(
      true,
    )
  })

  test('is false for empty or missing html', () => {
    expect(isRichHtml('')).toBe(false)
    expect(isRichHtml('   ')).toBe(false)
    expect(isRichHtml(null)).toBe(false)
    expect(isRichHtml(undefined)).toBe(false)
  })
})
