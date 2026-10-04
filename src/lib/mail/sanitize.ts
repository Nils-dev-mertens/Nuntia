/**
 * Sanitising email HTML.
 *
 * Anything from an email body eventually reaches `dangerouslySetInnerHTML`, and
 * email HTML is attacker-controlled by definition — a sender can put a `<script>`
 * or an `onerror` handler in a newsletter as easily as in a phishing mail. So
 * the stored `body_html` is not the raw part we received: it is the part after
 * quote-stripping, greeting/signature removal, and this allowlist pass.
 *
 * Sanitising happens once, at parse time, rather than at render time. That way
 * the string in the database is already safe, so no component has to remember to
 * clean before it injects.
 *
 * Quote stripping runs *before* this module, not after: it keys off the
 * `class` / `id` attributes clients put on quote containers, and the allowlist
 * keeps both, so the order is load-bearing rather than incidental.
 */

import sanitizeHtml from 'sanitize-html'

/**
 * Structural and text-level tags that appear in real mail.
 *
 * Deliberately excludes `script`, `style`, `iframe`, `object`, `form` and
 * friends — anything that executes, loads a document, or submits data. Email
 * layout leans on tables and inline styles, so those stay.
 */
const ALLOWED_TAGS = [
  'a', 'abbr', 'address', 'article', 'aside', 'b', 'blockquote', 'br',
  'caption', 'center', 'cite', 'code', 'col', 'colgroup', 'dd', 'del',
  'details', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'footer',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img', 'ins',
  'kbd', 'li', 'main', 'mark', 'nav', 'ol', 'p', 'pre', 'q', 's', 'samp',
  'section', 'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul', 'var',
  'wbr',
]

/**
 * Attributes kept per tag.
 *
 * `class` and `style` are allowed because email formatting lives in them; the
 * result is rendered inside a sandboxed iframe precisely so those styles cannot
 * reach the surrounding page. `align`, `valign`, `bgcolor` and `width` are kept
 * because table-based mail is unreadable without them.
 */
const ALLOWED_ATTRIBUTES: sanitizeHtml.IOptions['allowedAttributes'] = {
  '*': ['class', 'style', 'title', 'dir', 'lang'],
  a: ['href', 'name'],
  img: ['src', 'alt', 'width', 'height', 'align'],
  table: ['width', 'align', 'bgcolor', 'cellpadding', 'cellspacing', 'border'],
  td: ['width', 'height', 'align', 'valign', 'bgcolor', 'colspan', 'rowspan', 'nowrap'],
  th: ['width', 'height', 'align', 'valign', 'bgcolor', 'colspan', 'rowspan', 'nowrap', 'scope'],
  tr: ['align', 'valign', 'bgcolor'],
  col: ['width', 'span'],
  colgroup: ['width', 'span'],
  ol: ['start', 'type'],
  li: ['type', 'value'],
  time: ['datetime'],
  blockquote: ['cite'],
  del: ['datetime', 'cite'],
  ins: ['datetime', 'cite'],
}

/**
 * URL schemes permitted in `href` / `src`.
 *
 * `https` and `http` are how every remote image and link works. `mailto` is
 * needed for contact links. `cid` is how inline attachments are referenced
 * (`<img src="cid:image001">`).
 */
const ALLOWED_SCHEMES = ['http', 'https', 'mailto', 'cid', 'tel']

/**
 * Tags whose *contents* are discarded along with the tag.
 *
 * A `<script>` or `<style>` body is code, not prose a reader should ever see.
 * This is the default for `script`/`style`/`textarea`/`option`; `noscript` and
 * `iframe` are added because their contents are markup we do not control.
 */
const NON_TEXT_TAGS = ['style', 'script', 'textarea', 'option', 'noscript', 'iframe']

/**
 * Dangerous constructs that survive attribute-level filtering.
 *
 * `sanitize-html` checks `href`/`src` schemes, but a `style` attribute is an
 * opaque string to it, so `background: url(javascript:…)` and the legacy IE
 * `expression(…)` both pass through untouched. The iframe the HTML is rendered
 * in has no script permission, so these cannot execute — this is belt and
 * braces, so a future move out of the sandbox is not the day that becomes
 * exploitable.
 */
const DANGEROUS_CSS = /(?:javascript|vbscript)\s*:|expression\s*\(|@import|behaviou?r\s*:|-moz-binding/gi

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: ALLOWED_ATTRIBUTES,
  allowedSchemes: ALLOWED_SCHEMES,
  allowedSchemesAppliedToAttributes: ['href', 'src', 'cite'],
  nonTextTags: NON_TEXT_TAGS,
  // Comments carry MSO conditionals and Outlook layout hacks; they render
  // nothing and only add bytes.
  allowedClasses: undefined,
}

/** Strip dangerous constructs from every `style` attribute value. */
function scrubStyleAttributes(html: string): string {
  return html.replace(
    /\sstyle="([^"]*)"/gi,
    (match, value: string) =>
      DANGEROUS_CSS.test(value) ? '' : match,
  )
}

/**
 * Reduce email HTML to what is safe to render.
 *
 * Always returns a string — an empty one when nothing survives, so callers can
 * treat "no renderable HTML" and "all HTML removed" the same way and fall back
 * to plain text.
 */
export function sanitizeEmailHtml(html: string): string {
  if (!html || !html.trim()) return ''

  let clean: string
  try {
    clean = sanitizeHtml(html, OPTIONS).trim()
  } catch {
    // Markup the sanitizer cannot handle at all. Dropping the body beats
    // rendering something we could not vouch for.
    return ''
  }

  return scrubStyleAttributes(clean).trim()
}