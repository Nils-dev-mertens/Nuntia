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
 *
 * `img` is deliberately absent and judged separately below: an image can be
 * web content, or it can be a logo attached to the message.
 */
const RICH_HTML_TAGS =
  /<(table|thead|tbody|tfoot|tr|td|th|h[1-6]|ul|ol|li|blockquote|pre|code|figure|figcaption|svg|video|audio|iframe|embed|object|canvas|details|summary|dl|dt|dd|center|font)\b/i

/**
 * An image the sender hosts at a URL — part of the message's design.
 *
 * `cid:` images are excluded because they are *attachments*: the file travels
 * with the message and the app already lists it, so the image does not justify
 * a document of its own. `data:` URIs are likewise embedded, not fetched.
 */
const REMOTE_IMAGE = /<img\b[^>]*\bsrc\s*=\s*["']?(?!cid:|data:)[^"'\s>]/i

/** An attached image (`cid:`), which in practice is usually a signature logo. */
const ATTACHED_IMAGE = /<img\b[^>]*?\bsrc\s*=\s*["']?cid:[^>]*>/gi

/** Outlook and friends use a horizontal rule as their reply separator. */
const HORIZONTAL_RULE = /<hr\b[^>]*>/gi

/**
 * Does this HTML carry layout or formatting worth rendering as HTML?
 *
 * The chat view uses this to choose between a rich sandboxed frame and the
 * ordinary text bubble. Email that is only text should read like every other
 * chat message; putting it in an iframe gives it its own fonts, margins and a
 * white background, which looks worse than the plain bubble it replaced.
 */
export function isRichHtml(html: string | null | undefined): boolean {
  if (!html || !html.trim()) return false

  // Furnishing rather than content. Removed before judging so that neither the
  // element nor its own `style` attributes can force the frame: a plain reply
  // with a signature logo is still a plain reply.
  const markup = html.replace(ATTACHED_IMAGE, '').replace(HORIZONTAL_RULE, '')

  if (RICH_HTML_TAGS.test(markup)) return true
  if (REMOTE_IMAGE.test(markup)) return true
  return hasMeaningfulStyle(markup)
}

/** An inline `style` attribute, both quoting styles. */
const STYLE_ATTRIBUTE = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi

/**
 * Does any inline `style` change how the message looks?
 *
 * The sending client stamps its default typography on every block — Outlook
 * writes `font-family: Aptos; font-size: 12pt; color: rgb(0, 0, 0)` onto each
 * `<div>` of an ordinary reply. That is not the sender choosing a look, and
 * honouring it wrapped plain text in its own document with foreign fonts. Only
 * declarations that actually affect layout or emphasis count.
 */
function hasMeaningfulStyle(html: string): boolean {
  for (const match of html.matchAll(STYLE_ATTRIBUTE)) {
    const value = match[1] ?? match[2] ?? ''
    for (const declaration of value.split(';')) {
      if (isMeaningfulDeclaration(declaration)) return true
    }
  }
  return false
}

/** Classify one `property: value` pair from a `style` attribute. */
function isMeaningfulDeclaration(declaration: string): boolean {
  const separator = declaration.indexOf(':')
  if (separator < 0) return false

  const property = declaration.slice(0, separator).trim().toLowerCase()
  const value = declaration.slice(separator + 1).trim().toLowerCase()
  if (!property || !value) return false

  // The client's own font choice and size, never the sender's emphasis.
  if (property === 'font-family' || property === 'font-size') return false
  // Outlook's own housekeeping (`mso-line-height-rule` and the like).
  if (property.startsWith('mso-')) return false

  // Properties that matter, but whose neutral value is ordinary boilerplate.
  if (property === 'font-weight' || property === 'font-style') {
    return value !== 'normal'
  }
  if (property === 'text-decoration') return value !== 'none'
  if (property === 'color') return !isNearBlack(value)
  if (property === 'background' || property === 'background-color') {
    return value !== 'transparent'
  }
  if (property === 'border' || property.startsWith('border-')) {
    return value !== 'none' && value !== '0' && value !== '0px'
  }
  if (property.startsWith('margin') || property.startsWith('padding')) {
    return !isZeroLengths(value)
  }

  return true
}

/** `#000`, `black`, `rgb(0, 0, 0)` — the colour plain text already is. */
function isNearBlack(value: string): boolean {
  const compact = value.replace(/\s+/g, '')
  return (
    compact === 'black' ||
    compact === '#000' ||
    compact === '#000000' ||
    /^rgba?\(0,0,0([,)]|$)/.test(compact)
  )
}

/** True for a shorthand that sets every side to zero, e.g. `0`, `0px 0px`. */
function isZeroLengths(value: string): boolean {
  return /^0[a-z%]*(\s+0[a-z%]*)*$/.test(value)
}
