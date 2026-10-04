import { describe, expect, test } from 'bun:test'

import { sanitizeEmailHtml } from './sanitize.ts'

describe('sanitizeEmailHtml', () => {
  test('keeps the structure real mail is built from', () => {
    const html =
      '<table><tr><td bgcolor="#ffffff"><b>Total</b>: €99</td></tr></table>'

    const out = sanitizeEmailHtml(html)

    expect(out).toContain('<table>')
    expect(out).toContain('bgcolor="#ffffff"')
    expect(out).toContain('<b>Total</b>')
    // Non-ASCII content must survive untouched — it is the mail, not markup.
    expect(out).toContain('€99')
  })

  test('removes script tags and their contents', () => {
    const out = sanitizeEmailHtml(
      '<p>Hello</p><script>alert(document.cookie)</script>',
    )

    expect(out).toContain('Hello')
    expect(out).not.toContain('script')
    expect(out).not.toContain('alert')
  })

  test('removes event handler attributes', () => {
    const out = sanitizeEmailHtml(
      '<div onclick="steal()"><img src="x.png" onerror="steal()"></div>',
    )

    expect(out).not.toContain('onclick')
    expect(out).not.toContain('onerror')
    expect(out).toContain('x.png')
  })

  test('removes javascript: urls but keeps real links and images', () => {
    const out = sanitizeEmailHtml(
      '<a href="javascript:steal()">bad</a>' +
        '<a href="https://example.com/x">good</a>' +
        '<a href="mailto:a@b.c">mail</a>' +
        '<img src="https://cdn.example.com/i.png">',
    )

    expect(out).not.toContain('javascript:')
    expect(out).toContain('https://example.com/x')
    expect(out).toContain('mailto:a@b.c')
    expect(out).toContain('https://cdn.example.com/i.png')
  })

  test('strips style blocks that a tag allowlist alone would miss', () => {
    const out = sanitizeEmailHtml(
      '<style>body{display:none}</style><p>visible</p>',
    )

    expect(out).not.toContain('display:none')
    expect(out).toContain('visible')
  })

  test('drops dangerous constructs hidden inside style attributes', () => {
    // `sanitize-html` filters URL attributes by scheme but treats a style value
    // as opaque, so `javascript:` inside a CSS url() passes the allowlist.
    const out = sanitizeEmailHtml(
      '<div style="background:url(javascript:alert(1))">x</div>',
    )

    expect(out).not.toContain('javascript')
  })

  test('drops iframes and forms', () => {
    const out = sanitizeEmailHtml(
      '<iframe src="https://evil.example"></iframe>' +
        '<form action="https://evil.example"><input name="a"></form>',
    )

    expect(out).not.toContain('iframe')
    expect(out).not.toContain('evil.example')
  })

  test('keeps cid: references for inline images', () => {
    // Gmail rewrites `cid:` references when sending, so stripping them would
    // break every inline logo.
    const out = sanitizeEmailHtml('<img src="cid:image001@01D8">')

    expect(out).toContain('cid:image001@01D8')
  })

  test('unwraps document scaffolding but keeps the content', () => {
    const out = sanitizeEmailHtml(
      '<html><head><title>t</title></head><body><p>body text</p></body></html>',
    )

    expect(out).toContain('body text')
    expect(out).not.toContain('<body')
    expect(out).not.toContain('<html')
  })

  test('returns an empty string for empty or blank input', () => {
    expect(sanitizeEmailHtml('')).toBe('')
    expect(sanitizeEmailHtml('   ')).toBe('')
  })

  test('returns an empty string when nothing survives the allowlist', () => {
    expect(sanitizeEmailHtml('<script>x()</script>')).toBe('')
  })
})