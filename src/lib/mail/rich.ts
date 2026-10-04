/**
 * Is this HTML worth rendering as HTML?
 *
 * Lives in its own dependency-free module on purpose: the chat view asks this
 * question on the client, and going through `#/lib/mail/index.ts` would pull
 * htmlparser2, postal-mime and sanitize-html into the browser bundle for the
 * sake of one regular expression.
 */

/**
 * Structural and formatting tags that mean the HTML says more than its text.
 *
 * Deliberately excludes the containers a plain message is padded with (`div`,
 * `p`, `span`, `br`, `a`). Almost every `multipart/alternative` message carries
 * an HTML part, and most of them are the same sentences wrapped in a `div` —
 * there is no reason to render those in their own document.
 */
const RICH_HTML_TAGS =
  /<(img|picture|table|thead|tbody|tfoot|tr|td|th|h[1-6]|ul|ol|li|blockquote|pre|code|hr|figure|figcaption|svg|video|audio|iframe|embed|object|canvas|details|summary|dl|dt|dd|center|font)\b/i

/**
 * Does this HTML carry layout or formatting worth rendering as HTML?
 *
 * The chat view uses this to choose between a rich sandboxed frame and the
 * ordinary text bubble. Email that is only text should read like every other
 * chat message; putting it in an iframe gives it its own fonts, margins and a
 * white background, which looks worse than the plain bubble it replaced.
 *
 * Inline `style` counts too: a coloured or sized span changes how the text
 * looks and cannot be reproduced by the plain body.
 */
export function isRichHtml(html: string | null | undefined): boolean {
  if (!html || !html.trim()) return false
  if (RICH_HTML_TAGS.test(html)) return true
  return /\sstyle\s*=/i.test(html)
}
