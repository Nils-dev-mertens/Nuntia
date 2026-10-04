/**
 * Quote, signature and greeting detection.
 *
 * The output feeds a chat-style renderer, so the goal is: given a normal email
 * body, recover the text the human actually typed. Everything we remove is
 * returned separately so the send path can restore it.
 *
 * These are pure functions over strings. No Gmail, no I/O, no framework.
 */

/**
 * Unambiguous quote boundaries.
 *
 * These only ever appear where a mail client introduced quoted history, so they
 * match at any position in the body — including near the top, which happens in
 * short replies.
 */
const STRONG_QUOTE_MARKERS: RegExp[] = [
  // Outlook desktop: "-----Original Message-----"
  /^-{2,}\s*original message\s*-{2,}$/i,
  // Generic forward header
  /^\s*-{2,}\s*forwarded(\s+message)?\s*-{2,}\s*$/i,
  // Apple Mail / Gmail web: "On <date>, <person> wrote:"
  /^\s*on .{0,200}\bwrote:\s*$/i,
]

/**
 * Ambiguous quote boundaries.
 *
 * A bare "From:" line or a long run of dashes could plausibly be part of the
 * message itself, so these only count once we're past the opening of the body.
 */
const WEAK_QUOTE_MARKERS: RegExp[] = [
  /^-{5,}$/,
  // Outlook Web reply header block: "From: ... / Sent: ... / Subject: ..."
  /^\s*from:\s*\S+.*$/i,
]

/**
 * Lines that are pure quoting artifacts rather than content.
 *
 * `>` prefix is the near-universal convention. We also treat a leading
 * "On ... wrote:" style attribution line as an artifact even when the body
 * below it is unquoted (Outlook desktop does this).
 */
const QUOTED_LINE = /^\s*>/

/**
 * Closings that mark the start of a signature block.
 *
 * Multi-lingual for the same reason the greetings are: a closing the list does
 * not know is not stripped, so it stays in the bubble. `met vriendelijke
 * groet(en)` is the Dutch standard and the one this mailbox actually uses.
 *
 * Each pattern is anchored to the whole line and matches a closing *by itself*,
 * so a sentence that merely contains the word is never treated as a signature.
 */
const SIGNATURE_MARKERS = [
  /^\s*--\s*$/, // RFC 3676 sig delimiter: "-- "
  /^\s*__+\s*$/,
  /^\s*sent from my /i, // "Sent from my iPhone"
  // English
  /^\s*best regards,?\s*$/i,
  /^\s*kind regards,?\s*$/i,
  /^\s*warm regards,?\s*$/i,
  /^\s*regards,?\s*$/i,
  /^\s*cheers,?\s*$/i,
  /^\s*best,\s*$/i,
  /^\s*thanks,?\s*$/i,
  /^\s*thank you,?\s*$/i,
  /^\s*sincerely,?\s*$/i,
  // Dutch / Flemish
  /^\s*alvast bedankt!?\s*$/i,
  /^\s*met vriendelijke groet(en)?,?\s*$/i,
  /^\s*vriendelijke groet(en)?,?\s*$/i,
  /^\s*hartelijke groet(en)?,?\s*$/i,
  /^\s*groet(en)?,?\s*$/i,
  /^\s*mvg,?\s*$/i,
  // German
  /^\s*mit freundlichen gr(ü|u)(ß|ss)en,?\s*$/i,
  /^\s*viele gr(ü|u)(ß|ss)e,?\s*$/i,
  // French / Spanish / Italian
  /^\s*cordialement,?\s*$/i,
  /^\s*salutations,?\s*$/i,
  /^\s*un saludo,?\s*$/i,
  /^\s*saludos,?\s*$/i,
  /^\s*cordiali saluti,?\s*$/i,
]

/**
 * Greeting openers.
 *
 * Multi-lingual on purpose. A greeting the pattern does not know is not
 * stripped — it stays in the chat bubble, which is precisely what the parser
 * exists to prevent. The mailbox this runs against is Dutch, so `dag`, `hoi`,
 * `beste` and `geachte` are as load-bearing as `hi`.
 *
 * Only ever matched against the first short line (see `stripGreeting`), which is
 * what keeps a common word like `dag` from being mistaken for content. The `\b`
 * after the alternation stops `dag` matching `Dagelijks`.
 */
const GREETING_OPENERS = [
  'hi',
  'hey',
  'hello',
  'dear',
  'greetings',
  'yo',
  'howdy',
  'morning',
  'afternoon',
  'evening',
  'good morning',
  'good afternoon',
  'good evening',
  'ciao',
  'hallo',
  'bonjour',
  'bonsoir',
  'salut',
  'hola',
  'ola',
  'hei',
  'hej',
  'hå',
  'moin',
  'servus',
  'grüezi',
  'guten morgen',
  'guten tag',
  'guten abend',
  // Dutch / Flemish
  'dag',
  'hoi',
  'beste',
  'geachte',
  'goedemorgen',
  'goedemiddag',
  'goedenavond',
  'goedendag',
  'goeiemorgen',
  'goeiemiddag',
  'goeienavond',
  'goeiedag',
]

const GREETING_PATTERN = new RegExp(
  `^(${GREETING_OPENERS.join('|')})\\b[^\\n]{0,60},?\\s*$`,
  'i',
)

/** Split into lines while keeping the original line endings out of the way. */
function toLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
}

/**
 * Find where quoted history begins.
 *
 * Scans top to bottom and returns the index of the first line that either
 * matches a client-specific marker or begins a `>` quoted block. Returns -1 if
 * the whole body is the user's own text.
 */
export function findQuoteStart(lines: string[]): number {
  // Weak markers only count past the opening of the body, where content is
  // less likely to be mistaken for a quote header.
  const floor = Math.floor(lines.length * 0.4)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    // A `>` prefix is a near-universal convention, so it counts anywhere —
    // except on the very first line of a body that is otherwise all content.
    if (QUOTED_LINE.test(line)) return i

    if (STRONG_QUOTE_MARKERS.some((m) => m.test(trimmed))) return i

    if (i >= floor && WEAK_QUOTE_MARKERS.some((m) => m.test(trimmed))) {
      return i
    }
  }

  return -1
}

/**
 * Strip quoted history from a plain-text body.
 *
 * Returns the user's text plus the removed quote. The quote is returned rather
 * than discarded so `compose.ts` can re-attach it when replying.
 */
export function stripQuotedText(
  text: string,
  options: { enabled?: boolean } = {},
): { body: string; quote: string | null } {
  if (options.enabled === false) return { body: text.trim(), quote: null }
  if (!text || !text.trim()) return { body: '', quote: null }

  const lines = toLines(text)
  const start = findQuoteStart(lines)

  if (start === -1) return { body: text.trim(), quote: null }

  const body = lines.slice(0, start).join('\n').trim()
  const quote = lines.slice(start).join('\n').trim()

  // If stripping would leave nothing, this message was all quote (e.g. a
  // forward). Keep the original so we never render an empty bubble.
  if (!body) return { body: text.trim(), quote: null }

  return { body, quote: quote || null }
}

/**
 * Detect a trailing signature block.
 *
 * Returns the signature text and the body with it removed. We require either an
 * explicit delimiter ("--", "Sent from my iPhone") or a salutation in the last
 * few lines, because everything after a salutation in a short tail is almost
 * always the signature.
 */
export function stripSignature(text: string): {
  body: string
  signature: string | null
} {
  if (!text || !text.trim()) return { body: '', signature: null }

  const lines = toLines(text)

  // Only look in the last 12 lines.
  const tailStart = Math.max(0, lines.length - 12)

  for (let i = lines.length - 1; i >= tailStart; i--) {
    const line = lines[i]
    if (SIGNATURE_MARKERS.some((m) => m.test(line))) {
      // Walk forward to the end, skipping trailing blank lines.
      let end = lines.length
      while (end > i && !lines[end - 1].trim()) end--

      const signature = lines.slice(i, end).join('\n').trim()
      const body = lines.slice(0, i).join('\n').trim()

      // Never strip the whole message.
      if (!body) return { body: text.trim(), signature: null }

      return { body, signature: signature || null }
    }
  }

  return { body: text.trim(), signature: null }
}

/**
 * Strip a leading greeting.
 *
 * Only the first non-empty line is considered, and only if it is short and
 * matches a greeting shape. A long first line starting with "Hi" is content,
 * not a greeting.
 */
export function stripGreeting(text: string): {
  body: string
  greeting: string | null
} {
  if (!text || !text.trim()) return { body: '', greeting: null }

  const lines = toLines(text)
  const firstIdx = lines.findIndex((l) => l.trim())

  if (firstIdx === -1) return { body: '', greeting: null }

  const first = lines[firstIdx].trim()
  if (!GREETING_PATTERN.test(first))
    return { body: text.trim(), greeting: null }

  // A greeting must be short. "Hi, I was wondering whether we could" is content.
  if (first.length > 70) return { body: text.trim(), greeting: null }

  const body = lines
    .slice(firstIdx + 1)
    .join('\n')
    .trim()

  // If the greeting is the entire message, keep it — it's the content.
  if (!body) return { body: text.trim(), greeting: null }

  return { body, greeting: first }
}

/**
 * Full clean of a plain-text body.
 *
 * Order matters: quotes first (they contain the *other* party's signature and
 * greeting, which would otherwise be detected as ours), then our signature,
 * then our greeting.
 */
export function cleanBody(
  text: string,
  options: {
    stripQuotedHistory?: boolean
    stripGreeting?: boolean
    stripSignature?: boolean
  } = {},
): {
  body: string
  greeting: string | null
  signature: string | null
  quote: string | null
} {
  const quoted = stripQuotedText(text, {
    enabled: options.stripQuotedHistory,
  })
  const signed = options.stripSignature
    ? stripSignature(quoted.body)
    : { body: quoted.body, signature: null }
  const greeted = options.stripGreeting
    ? stripGreeting(signed.body)
    : { body: signed.body, greeting: null }

  return {
    body: greeted.body,
    greeting: greeted.greeting,
    signature: signed.signature,
    quote: quoted.quote,
  }
}

/**
 * HTML handling lives in `html.ts`.
 *
 * The DOM-based extractor there replaced an earlier regex implementation that
 * could not handle nested quote containers. Re-exported here so callers only
 * need one import.
 */
export {
  extractHtmlBody,
  hasQuotedHtml,
  htmlToPlainText,
  stripQuotedHtml,
} from './html.ts'
/**
 * Characters that carry no meaning but survive every text transform.
 *
 * Mail is full of them: a BOM at the start of a part, the soft hyphen a
 * newsletter inserts for its own line-breaking, and the invisible spacers
 * marketing templates use between blocks. They are invisible on screen but not
 * inert — they defeat signature detection (a "signature" that is really
 * invisible characters), and they get copied out of the app into whatever the
 * user writes next.
 *
 * These are removed rather than replaced with a space. The format characters
 * and combining marks carry no width at all; the spaces (U+2000–U+200A, U+205F)
 * do occupy space but are only ever decorative here, and swapping them for a
 * normal space would turn an invisible run into a visible gap in a chat bubble.
 *
 * U+034F (combining grapheme joiner) is the one that bites hardest: newsletters
 * use `U+2007 U+034F` pairs as a line of invisible filler, and it survives every
 * transform that only targets Cf.
 *
 * The combining marks sit in their own alternatives rather than in the shared
 * character class. Inside a class a combining mark is a trap: it reads as
 * modifying whatever precedes it, and `no-misleading-character-class` rejects
 * the pattern outright.
 */
const INVISIBLE_CHARACTERS =
  /\u034f|\u061c|[\u00ad\u180e\u2000-\u200f\u202a-\u202e\u205f\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/g

/**
 * Strip invisible formatting characters from a body.
 *
 * Applied last, after quote/signature/greeting detection has already run: the
 * characters interfere with those checks, but removing them first would change
 * offsets for no benefit.
 *
 * A line left with nothing but spaces collapses away. Removing the filler from
 * `a\nU+2007 U+034F\nb` would otherwise leave a blank line where the template
 * used invisible padding to space two blocks apart — and that gap is exactly the
 * layout the filler was faking, so dropping it is closer to the sender's intent
 * than keeping an empty line.
 */
export function stripInvisibleCharacters(text: string): string {
  if (!text) return text

  return text.replace(INVISIBLE_CHARACTERS, '').replace(/[^\S\n]+$/gm, '')
}
