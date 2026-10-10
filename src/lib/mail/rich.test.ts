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
    expect(isRichHtml('<blockquote>quoted</blockquote>')).toBe(true)
  })

  test('is true for an image the sender hosts at a URL', () => {
    expect(isRichHtml('<p>See <img src="https://cdn.example.com/a.png">')).toBe(
      true,
    )
  })

  test('is true for inline styles that change how the text looks', () => {
    expect(isRichHtml('<div><span style="color:red">red</span></div>')).toBe(
      true,
    )
    expect(isRichHtml('<p style="text-align:center">centred</p>')).toBe(true)
    expect(isRichHtml('<div style="font-weight:bold">loud</div>')).toBe(true)
  })

  test('is false for the client boilerplate stamped on a plain reply', () => {
    // Outlook writes this on every block of otherwise plain text. Honouring it
    // put ordinary mail inside its own document with foreign fonts.
    expect(
      isRichHtml(
        '<div style="font-family:Aptos, Calibri, sans-serif;font-size:12pt;color:rgb(0, 0, 0)">' +
          '<p>Sorry voor het delay.</p></div>',
      ),
    ).toBe(false)
    expect(isRichHtml('<div style="margin:0;padding:0">text</div>')).toBe(false)
    expect(
      isRichHtml('<p style="font-weight:normal;text-decoration:none">text</p>'),
    ).toBe(false)
  })

  test('is false for an image delivered with the message', () => {
    // A `cid:` image is an attachment — the app already lists it — so it is not
    // a reason to render the whole message as a document.
    expect(isRichHtml('<p>See <img src="cid:logo"></p>')).toBe(false)
    expect(
      isRichHtml(
        '<div style="font-family:Arial;font-size:12pt;color:#000">' +
          '<p>Groeten</p><img width="217" height="74" style="width:217px;height:74px" src="cid:53485776-a353" /></div>',
      ),
    ).toBe(false)
  })

  test('is false for an Outlook reply separator', () => {
    expect(isRichHtml('<p>Done.</p><hr style="display:inline-block;width:98%">')).toBe(
      false,
    )
  })

  test('is false for empty or missing html', () => {
    expect(isRichHtml('')).toBe(false)
    expect(isRichHtml('   ')).toBe(false)
    expect(isRichHtml(null)).toBe(false)
    expect(isRichHtml(undefined)).toBe(false)
  })
})
