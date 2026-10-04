/**
 * HTML body extraction via DOM parsing.
 *
 * Replaces the earlier regex approach, which could not handle nested containers:
 * Outlook wraps quoted history in several nested `div`s, so a non-greedy regex
 * either stopped at the first closing tag (leaving quote text behind) or ran to
 * the end (eating real content).
 *
 * The approach here is a stack walk over the parsed DOM. When we enter an
 * element that looks like a quote container, everything beneath it is marked as
 * quoted regardless of how deeply it nests.
 */

import { parseDocument } from 'htmlparser2'
// Node types and type guards both come from domhandler. `isTag` from
// domelementtype has its own Node type, which does not narrow correctly here.
import { hasChildren, isTag, isText } from 'domhandler'
import type { AnyNode, Element, ParentNode, Text } from 'domhandler'
import { render } from 'dom-serializer'

/**
 * Elements that introduce quoted history, matched against the `class`,
 * `id`, and `data-*` attributes mail clients actually set.
 */
const QUOTE_CLASS_PATTERNS = [
  /gmail_quote/i,
  /yahoo_quoted/i,
  /quoted/i,
  /moz-cite-prefix/i,
  /moz-signature/i,
  /ms-outlook-mobile-reference-message/i,
]

const QUOTE_ID_PATTERNS = [
  /^divRplyFwdMsg$/i, // Outlook web reply
  /^appendonsend$/i, // Outlook desktop
  /^divRplyFwdMsg/i,
  /^O365Note$/i, // Outlook OWA
]

/** Structural containers that mean "everything below is quoted". */
const QUOTE_TAGS = new Set(['blockquote'])

/** Block-level elements that should become line breaks in plain text. */
const BLOCK_TAGS = new Set([
  'p',
  'div',
  'tr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'table',
  'section',
  'article',
  'header',
  'footer',
  'blockquote',
  'pre',
])

/** Elements whose text content is never shown to the user. */
const HIDDEN_TAGS = new Set([
  'script',
  'style',
  'head',
  'title',
  'meta',
  'link',
  'noscript',
])

/** Tags inside which text is verbatim and must not be whitespace-collapsed. */
const PRESERVE_TAGS = new Set(['pre', 'textarea', 'code'])

/** True when this element is a quote container. */
function isQuoteContainer(el: Element): boolean {
  if (QUOTE_TAGS.has(el.name.toLowerCase())) return true

  const attrs = el.attribs
  const haystack = [attrs.class, attrs.id, attrs['data-id']]
    .filter(Boolean)
    .join(' ')

  if (QUOTE_CLASS_PATTERNS.some((p) => p.test(haystack))) return true
  if (QUOTE_ID_PATTERNS.some((p) => p.test(attrs.id))) return true

  return false
}

type Segment = {
  text: string
  quoted: boolean
}

/**
 * Walk the DOM, splitting text into quoted and unquoted segments.
 *
 * `depth` counts how many quote containers we are currently inside, so nested
 * containers are handled without special-casing.
 */
function walk(node: AnyNode, depth: number, out: Segment[]): void {
  if (!hasChildren(node)) return

  for (const child of node.children) {
    if (isText(child)) {
      out.push({ text: child.data, quoted: depth > 0 })
      continue
    }

    if (!isTag(child)) continue

    const tag = child.name.toLowerCase()
    if (HIDDEN_TAGS.has(tag)) continue

    // Depth must advance for *every* quote container, including ones that are
    // also block elements (a gmail_quote div is both). Check it first, before
    // the block/branches below take an early continue.
    const nextDepth = isQuoteContainer(child) ? depth + 1 : depth

    const isBreak =
      tag === 'br' ||
      tag === 'hr' ||
      (BLOCK_TAGS.has(tag) && !PRESERVE_TAGS.has(tag))

    if (isBreak) {
      out.push({ text: '\n', quoted: depth > 0 })
      walk(child, nextDepth, out)
      continue
    }

    // A list item reads better with a bullet.
    if (tag === 'li') {
      out.push({ text: '\n- ', quoted: depth > 0 })
      walk(child, nextDepth, out)
      continue
    }

    walk(child, nextDepth, out)
  }
}

/**
 * Split an HTML body into its own content and the quoted history beneath it.
 *
 * Returns `body` (what the user wrote) and `quote` (everything a client marked
 * as quoted). Both are plain text; `quote` is null when the message had no
 * quoted history.
 */
export function extractHtmlBody(html: string): {
  body: string
  quote: string | null
} {
  if (!html || !html.trim()) return { body: '', quote: null }

  let doc
  try {
    doc = parseDocument(html)
  } catch {
    // Malformed HTML that the parser rejects outright. Nothing safe to do.
    return { body: '', quote: null }
  }

  const segments: Segment[] = []
  // Depth 0 for the document itself; quote containers increment from there.
  walk(doc, 0, segments)

  let own = ''
  let quoted = ''

  for (const seg of segments) {
    if (seg.quoted) quoted += seg.text
    else own += seg.text
  }

  const cleanOwn = normalizeWhitespace(own)
  const cleanQuote = normalizeWhitespace(quoted)

  // A message that is entirely quote (a forward) must not render as empty.
  // The quoted text *is* the content the user wants to read, so fall back to it
  // rather than rendering a blank bubble.
  if (!cleanOwn) {
    return {
      body: cleanQuote,
      quote: null,
    }
  }

  return {
    body: cleanOwn,
    quote: cleanQuote || null,
  }
}

/** True when the HTML carries any recognised quote markup. */
export function hasQuotedHtml(html: string): boolean {
  return extractHtmlBody(html).quote !== null
}

/**
 * Convert an HTML body to plain text, dropping quoted history.
 *
 * This is the display-side helper. For the full own/quote split (needed by the
 * reply path) use `extractHtmlBody`.
 */
export function htmlToPlainText(html: string): string {
  return extractHtmlBody(html).body
}

/** Collapse runs of whitespace while preserving paragraph breaks. */
function normalizeWhitespace(text: string): string {
  return (
    text
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      // Non-breaking spaces are layout noise in plain text. Written as an escape
      // because a literal U+00A0 in source trips the no-irregular-whitespace rule.
      .replace(/\u00a0/g, ' ')
      // Trailing spaces before a break carry no meaning.
      .replace(/[ \t]+\n/g, '\n')
      // Three or more newlines collapse to a blank line.
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

/**
 * Re-serialize an HTML fragment.
 *
 * Used when we want to keep HTML for rich rendering but have already decided
 * which subtree is quoted.
 */
export function serializeNode(node: AnyNode): string {
  return render(node)
}

/**
 * Strip the quoted subtree from HTML, keeping the rest intact.
 *
 * This is what the send path needs: the user composes in a rich editor, and we
 * must not re-attach quoted history that they never asked for.
 */
export function stripQuotedHtml(
  html: string,
  options: { enabled?: boolean } = {},
): string {
  if (!html || !html.trim()) return ''
  if (options.enabled === false) return html

  let doc
  try {
    doc = parseDocument(html)
  } catch {
    return html
  }

  const prune = (node: AnyNode): boolean => {
    if (!hasChildren(node)) return false

    let removed = false
    const kept = []

    for (const child of node.children) {
      if (isTag(child) && isQuoteContainer(child)) {
        removed = true
        continue
      }
      if (isTag(child)) removed = prune(child) || removed
      kept.push(child)
    }

    node.children.length = 0
    node.children.push(...kept)

    return removed
  }

  const removed = prune(doc)

  // Rendering only when something was pruned avoids re-serializing untouched
  // HTML, which would normalise markup the user may be relying on.
  return removed ? render(doc) : html
}

/**
 * Text nodes of the unquoted part of a document, in document order.
 *
 * Greeting and signature trimming work on this list rather than on elements:
 * markup can split a salutation across nodes (`<b>Hi</b> Sarah,`), so any
 * element-level approach has to guess where a phrase starts and ends. Consuming
 * characters off a flat list of text nodes does not care how they are tagged.
 */
function ownTextNodes(node: AnyNode, depth: number, out: Text[]): void {
  if (!hasChildren(node)) return

  for (const child of node.children) {
    if (isTag(child)) {
      const tag = child.name.toLowerCase()
      if (HIDDEN_TAGS.has(tag)) continue

      ownTextNodes(child, isQuoteContainer(child) ? depth + 1 : depth, out)
      continue
    }

    // Quoted history belongs to another message, so its text is never ours to
    // match a greeting or signature against.
    if (depth === 0 && isText(child)) out.push(child)
  }
}

/**
 * Characters that count for comparison: no whitespace, no case.
 *
 * Source HTML wraps and pads unpredictably — `Hi\n  Sarah,` and `Hi&nbsp;Sarah,`
 * are the same greeting — so matching ignores both.
 */
function significant(text: string): string {
  return text.replace(/\s|\u00a0/g, '').toLowerCase()
}

/** True for whitespace, including the non-breaking space mail is full of. */
function isSpace(ch: string): boolean {
  return /\s/.test(ch) || ch === '\u00a0'
}

/**
 * Remove a leading greeting from an HTML body.
 *
 * `greeting` must be the greeting already detected from the plain-text
 * projection (`stripGreeting`); this only deletes it again.
 *
 * Returns the HTML unchanged when the greeting cannot be fully accounted for,
 * because a partial trim would silently mangle the opening line of a real
 * message. `strip.ts` guards the same way.
 */
export function stripHtmlGreeting(
  html: string,
  greeting: string | null,
): string {
  return trimEdgeText(html, greeting, 'start') ?? html
}

/** `stripHtmlGreeting` for a trailing signature. */
export function stripHtmlSignature(
  html: string,
  signature: string | null,
): string {
  return trimEdgeText(html, signature, 'end') ?? html
}

/**
 * Where a node's text must be cut, decided before any of it is applied.
 *
 * The two-pass shape is the point: if the phrase turns out not to reach the end
 * of the node list, nothing has been modified yet and the caller's `?? html`
 * returns the original. A half-applied trim is the one failure mode that cannot
 * be undone.
 */
type TrimPlan = {
  /** Text node → its new data. */
  edits: Map<Text, string>
  /** Nodes consumed entirely, to be removed from the tree. */
  emptied: Text[]
}

/**
 * Consume `phrase` off one edge of a document's text nodes.
 *
 * Returns null when the phrase is not present at that edge.
 */
function trimEdgeText(
  html: string,
  phrase: string | null,
  edge: 'start' | 'end',
): string | null {
  const wanted = significant(phrase ?? '')
  if (!html.trim() || !wanted) return null

  let doc
  try {
    doc = parseDocument(html)
  } catch {
    return null
  }

  const nodes: Text[] = []
  ownTextNodes(doc, 0, nodes)
  if (nodes.length === 0) return null

  const ordered = edge === 'start' ? nodes : [...nodes].reverse()
  const plan: TrimPlan = { edits: new Map(), emptied: [] }

  // What is still to be found, as it appears at the edge being consumed.
  let remaining = wanted

  for (const node of ordered) {
    if (!remaining) break
    if (!isText(node)) continue

    const nodeSig = significant(node.data)
    // Whitespace-only nodes between block elements carry no meaning, so
    // skipping them keeps an indentation gap from ending the match early.
    if (!nodeSig) continue

    const fits =
      edge === 'start'
        ? nodeSig.length <= remaining.length
          ? remaining.startsWith(nodeSig)
          : nodeSig.startsWith(remaining)
        : nodeSig.length <= remaining.length
          ? remaining.endsWith(nodeSig)
          : nodeSig.endsWith(remaining)

    if (!fits) return null

    // The node covers the phrase exactly, or the phrase ends inside it.
    if (nodeSig.length <= remaining.length) {
      plan.emptied.push(node)
      remaining =
        edge === 'start'
          ? remaining.slice(nodeSig.length)
          : remaining.slice(0, remaining.length - nodeSig.length)
      continue
    }

    plan.edits.set(
      node,
      edge === 'start'
        ? cutFromStart(node.data, remaining.length)
        : cutFromEnd(node.data, remaining.length),
    )
    remaining = ''
  }

  // Anything left means the phrase was not at this edge after all.
  if (remaining) return null

  for (const [node, data] of plan.edits) node.data = data

  for (const node of plan.emptied) removeNode(doc, node)

  pruneEmptied(doc)

  return render(doc)
}

/**
 * Raw text with its first `count` significant characters removed.
 *
 * Walks raw characters rather than slicing the significant form, because the two
 * are different strings: the raw text carries the whitespace and entity noise
 * the comparison ignores. `String.indexOf` is deliberately not used to find the
 * cut point — it returns the first match, so a repeated letter would cut in the
 * wrong place.
 */
function cutFromStart(raw: string, count: number): string {
  let seen = 0
  let cut = 0

  for (const ch of raw) {
    // Whitespace after the last significant character still belongs to the
    // greeting — `Hey Nils, welcome` must keep `, welcome` minus the comma,
    // not leave the space glued to the front of the body.
    if (isSpace(ch) && seen >= count) break
    if (isSpace(ch)) {
      cut += ch.length
      continue
    }

    seen++
    if (seen > count) break

    cut += ch.length
  }

  return raw.slice(cut)
}

/** `cutFromStart` for the other end. */
function cutFromEnd(raw: string, count: number): string {
  const chars = [...raw]
  let seen = 0
  let cut = chars.length

  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i]

    if (isSpace(ch) && seen >= count) break
    if (isSpace(ch)) {
      cut = i
      continue
    }

    seen++
    if (seen > count) {
      cut = i
      break
    }
  }

  return raw.slice(0, cut)
}

/** Detach a node from wherever it sits in the tree. */
function removeNode(root: AnyNode, target: AnyNode): void {
  const parent = findParent(root, target)
  if (!parent) return

  detach(parent, target)
}

/**
 * Drop elements left with no content after a trim.
 *
 * Empty markup is not harmless here: a `<div>` carries `padding` and `margin`,
 * so stripping a greeting out of `<div style="margin-bottom:20px">Hi Sarah,</div>`
 * leaves a 20px gap where the salutation was. Removing the shell keeps the
 * layout tight.
 *
 * Media and structural elements are exempt — `<img>`, `<br>` and `<hr>` have no
 * children by design, and an empty `<td>` is a table cell the sender asked for.
 */
const STRUCTURAL_TAGS = new Set([
  'img',
  'br',
  'hr',
  'td',
  'th',
  'tr',
  'table',
  'tbody',
  'thead',
  'tfoot',
  'col',
  'colgroup',
  'input',
  'video',
  'audio',
  'iframe',
])

function pruneEmptied(node: AnyNode): void {
  if (!hasChildren(node)) return

  // Snapshot before recursing: splicing out a child while iterating the live
  // array shifts every later sibling down one slot, so half of them would be
  // skipped and left behind.
  for (const child of [...node.children]) {
    if (!isTag(child)) continue

    pruneEmptied(child)

    if (STRUCTURAL_TAGS.has(child.name.toLowerCase())) continue
    if (child.children.length > 0) continue
    if (significant(textContent(child))) continue

    node.children.splice(node.children.indexOf(child), 1)
  }
}

/**
 * Detach a node from its parent.
 *
 * Typed against the parent rather than the root because `findParent` returns a
 * `ParentNode`, whose `children` the compiler can narrow — while the `AnyNode`
 * it is searched from cannot.
 */
function detach(parent: ParentNode, target: AnyNode): void {
  parent.children.splice(parent.children.indexOf(target), 1)
}

/** All text beneath a node, ignoring markup. */
function textContent(node: AnyNode): string {
  if (isText(node)) return node.data
  if (!hasChildren(node)) return ''

  let out = ''
  for (const child of node.children) out += textContent(child)

  return out
}

/** Locate a node's parent. */
function findParent(node: AnyNode, target: AnyNode): ParentNode | null {
  if (!hasChildren(node)) return null

  for (const child of node.children) {
    if (child === target) return node

    const found = findParent(child, target)
    if (found) return found
  }

  return null
}
