/**
 * Styled signatures.
 *
 * A signature is the one part of a reply people decorate: a bold name, a quiet
 * line of italic availability, a link to the calendar. Storing a full HTML
 * editor for it would mean a sanitiser at write time, a second editor in every
 * place a reply style can be set, and a plain-text fallback nobody maintains.
 *
 * So the stored value stays one string and a very small markup is understood:
 *
 *   **bold**   *italic*   [label](https://example.com)
 *
 * Both representations are derived from it here — the HTML part carries the
 * styling, the plain-text part carries the same words without the markers — so
 * a signature cannot look different depending on which part a mail client chose.
 * Nothing else is interpreted: no raw HTML, no images, no scripts. That is the
 * whole security model, and it is why this module has no dependencies.
 */

/**
 * A link. Only explicit schemes become anchors, so `[x](javascript:…)` stays
 * text — the signature is user-authored, but the value is stored and mailed
 * later, and an allowlist costs one regex.
 */
const LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g
const LINK_TEST = /\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/

/** Bold before italic, because `**x**` contains what looks like an italic pair. */
const BOLD = /\*\*([^*\n]+)\*\*/g
const ITALIC = /(^|[^*])\*([^*\n]+)\*(?!\*)/g

/** Whether this signature needs an HTML part at all. */
export function signatureHasMarkup(
  signature: string | null | undefined,
): boolean {
  return Boolean(
    signature &&
      (/\*\*[^*\n]+\*\*/.test(signature) ||
        /(^|[^*])\*[^*\n]+\*(?!\*)/.test(signature) ||
        LINK_TEST.test(signature)),
  )
}

/** The signature as plain text: the same words, markers removed. */
export function signatureToText(
  signature: string | null | undefined,
): string | null {
  if (!signature?.trim()) return null

  return signature
    .replace(LINK, '$1')
    .replace(BOLD, '$1')
    .replace(ITALIC, '$1$2')
    .trim()
}

/**
 * The signature as a paragraph of safe HTML.
 *
 * The input is escaped first, then the markers are applied to the escaped text.
 * That order is what keeps a signature containing `<` or `&` from becoming
 * markup, and the link regex runs on the escaped URL (where `&` is `&amp;`),
 * which is still a valid `href`.
 */
export function signatureToHtml(signature: string | null | undefined): string {
  const source = signature?.trim()
  if (!source) return ''

  const html = escapeHtml(source)
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
      '<a href="$2">$1</a>',
    )
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/\n/g, '<br>')

  return `<p>${html}</p>`
}

/** The three things the signature toolbar can do. */
export type SignatureFormat = 'bold' | 'italic' | 'link'

/**
 * What a formatting button does to the signature.
 *
 * The toolbar is a convenience over the markup above, never a second format: it
 * inserts the same markers around the selection and reports where the caret
 * belongs afterwards. Returning a selection rather than touching a textarea is
 * what lets the rule be tested without a DOM, and it keeps the component free
 * of browser state the send path does not share.
 *
 * With nothing selected a placeholder is inserted and left selected, so typing
 * replaces it — the same behaviour as a bold button in a word processor.
 */
export function applySignatureFormat(
  value: string,
  start: number,
  end: number,
  format: SignatureFormat,
): { value: string; selectionStart: number; selectionEnd: number } {
  const from = Math.max(0, Math.min(start, end))
  const to = Math.max(start, end)
  const selected = value.slice(from, to)
  const before = value.slice(0, from)
  const after = value.slice(to)

  if (format === 'link') {
    const label = selected || 'link text'
    // A complete URL rather than a bare `https://`: the renderer only anchors a
    // link with a host, and a placeholder that previews as literal markup would
    // look broken at exactly the moment the user is checking it.
    const url = 'https://example.com'
    const inserted = `[${label}](${url})`

    return {
      value: `${before}${inserted}${after}`,
      // With a label to keep, the URL is the part still to fill in; without one,
      // the placeholder label is, and the URL can wait.
      selectionStart: selected ? from + label.length + 3 : from + 1,
      selectionEnd: selected
        ? from + label.length + 3 + url.length
        : from + 1 + label.length,
    }
  }

  const marker = format === 'bold' ? '**' : '*'
  const text = selected || format
  const inserted = `${marker}${text}${marker}`

  return {
    value: `${before}${inserted}${after}`,
    selectionStart: from + marker.length,
    selectionEnd: from + marker.length + text.length,
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
