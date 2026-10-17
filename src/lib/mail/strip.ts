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
  // Outlook web / new Outlook: a long machine-drawn rule of underscores above
  // the "From:" block. Long enough that it is not a person underlining a word.
  /^_{10,}$/,
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
 * A person-name-shaped phrase: one to three capitalised words.
 *
 * Used for the optional name a sign-off carries on the same line
 * (`Groetjes, Nils`) and for a bare-name greeting or signature line (`Nils,`).
 *
 * The `(?![IA]\b)` guard keeps a lone English pronoun from reading as a name,
 * so `Thanks, I'll …` never matches `Thanks,` as a sign-off.
 */
const NAME_PHRASE =
  "(?![IA]\\b)[\\p{Lu}][\\p{L}'’.-]*(?:\\s+[\\p{Lu}][\\p{L}'’.-]*){0,2}"

/**
 * Build a signature-closer pattern from raw regex fragments.
 *
 * Each closer matches a whole line, with an optional person-name after it on
 * the same line and optional trailing punctuation: `Groetjes`, `Groetjes,`,
 * `Groetjes, Nils` and `Best regards!` are all the same closer.
 */
function signoff(...fragments: string[]): RegExp {
  const closer = `(?:${fragments.join('|')})`
  return new RegExp(
    // One closing, or several chained with `/` (see `ALL_CLOSINGS`).
    `^\\s*${closer}(?:\\s*[/|]\\s*${closer})*` +
      `(?:[\\s,]+${NAME_PHRASE})?[,!]?\\s*$`,
    'iu',
  )
}

/**
 * Closings that mark the start of a signature block.
 *
 * Multi-lingual for the same reason the greetings are: a closing the list does
 * not know is not stripped, so it stays in the bubble. `met vriendelijke
 * groeten`, `groetjes` and `bedankt` are the Dutch standards this mailbox
 * actually uses.
 *
 * Each pattern is anchored to the whole line, so a sentence that merely
 * mentions the word is never treated as a signature. A sign-off may carry the
 * sender's name on the same line (`Groetjes, Nils`); everything from the
 * matched line to the end of the body is taken as the signature either way.
 */
/** English closings. */
const ENGLISH_CLOSINGS = [
  'best regards',
  'kind regards',
  'warm regards',
  'regards',
  'cheers',
  'best',
  'thanks(?: so much)?',
  'thank you',
  'many thanks',
  'sincerely',
  'take care',
  'all the best',
  'best wishes',
  'talk soon',
  'speak soon',
  'have a (?:nice|great) day',
  'yours',
]

/** Dutch / Flemish closings. */
const DUTCH_CLOSINGS = [
  'alvast bedankt',
  'hartstikke bedankt',
  'hartelijk dank',
  'dank je wel',
  'dankjewel',
  'bedankt',
  'dank',
  'met vriendelijke groet(?:en)?',
  'vriendelijke groet(?:en)?',
  'hartelijke groet(?:en)?',
  'groet(?:en)?',
  'groetjes',
  'mvg',
  'fijne (?:dag|avond)',
  'tot (?:snel|morgen|gauw)',
]

/** German closings. */
const GERMAN_CLOSINGS = [
  'mit freundlichen gr(?:ü|u)(?:ß|ss)en',
  'viele gr(?:ü|u)(?:ß|ss)e',
  'liebe gr(?:ü|u)(?:ß|ss)e',
  'gr(?:ü|u)(?:ß|ss)e',
  'lg',
]

/** French / Spanish / Italian closings. */
const ROMANCE_CLOSINGS = [
  'cordialement',
  'salutations',
  'bien à vous',
  'amicalement',
  'un saludo',
  'saludos',
  'atentamente',
  'cordiali saluti',
  'un abbraccio',
]

/**
 * Every closing the parser knows, matched as one alternation.
 *
 * Grouping the list by language is for the reader; matching has to be done
 * against all of them at once, because a signature is often written in several
 * languages on one line — `Best regards / Met vriendelijke groeten /
 * Cordialement,`. Judging each language separately could never see that as a
 * closing, so the whole signature stayed in the bubble.
 */
const ALL_CLOSINGS = [
  ...ENGLISH_CLOSINGS,
  ...DUTCH_CLOSINGS,
  ...GERMAN_CLOSINGS,
  ...ROMANCE_CLOSINGS,
]

const SIGNATURE_MARKERS: RegExp[] = [
  /^\s*--\s*$/, // RFC 3676 sig delimiter: "-- "
  /^\s*__+\s*$/,
  /^\s*sent from my /i, // "Sent from my iPhone"
  signoff(...ALL_CLOSINGS),
]

/**
 * Lines a signature tail is allowed to be made of.
 *
 * Beyond the name itself, a signature carries the sender's contact details,
 * and those are the shapes a phone number, an email address and a link have.
 */
const CONTACT_LINE_PATTERNS = [
  /^[+\d][\d\s()./-]{5,}$/,
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  /^(?:https?:\/\/|www\.)\S+$/i,
]

/**
 * Punctuation that marks a sentence, which a signature line does not carry.
 *
 * Checked after the contact patterns, so the dot in `nils@example.com` and in
 * a URL is not mistaken for a full stop.
 */
const SENTENCE_PUNCTUATION = /[.!?;:]/

/** True when a line is just a person's name, with an optional comma. */
function isNameLine(line: string): boolean {
  return new RegExp(`^${NAME_PHRASE},?$`, 'u').test(line.trim())
}

/** True when a line reads as a name or a single contact detail. */
function isContactOrNameLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed || trimmed.length > 60) return false
  if (CONTACT_LINE_PATTERNS.some((p) => p.test(trimmed))) return true
  if (SENTENCE_PUNCTUATION.test(trimmed)) return false
  return isNameLine(trimmed)
}

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
  // A known opener plus at most a short, punctuation-free tail: `Hi Alex,`,
  // `Hallo allemaal,`. The tail cap is what keeps `Hi, I was wondering …` out.
  // `(?!\p{L})` rather than `\b` so a non-ASCII opener (`grüezi`, `hå`) still
  // matches at a word end.
  `^(?:${GREETING_OPENERS.join('|')})(?!\\p{L})[^.!?;:\\n]{0,16}[,!]?\\s*$`,
  'iu',
)

/**
 * A bare salutation line: `Nils,`, `Guillaume,`.
 *
 * The positional fallback for an opener the list does not know. Only the first
 * line is tested, it must be short, and discourse openers (`Anyway,`,
 * `However,`) are excluded so a transition still reads as content.
 */
// The comma is required here. It is what separates a salutation (`Nils,`) from
// an ALL-CAPS headline of two capitalised words (`AWESOME NEWS`), which the
// name shape alone would otherwise match.
const NAME_GREETING_PATTERN = new RegExp(`^${NAME_PHRASE},\\s*$`, 'u')

/**
 * A greeting that shares its line with the message: `Hi Sarah, how are you?`.
 *
 * The comma is required, and that is the whole safety mechanism. It keeps a
 * body that merely starts with an opener word (`Morning light streamed in`) from
 * being read as a salutation, while still splitting the greeting off the front
 * of the one-line opener most people actually write.
 */
const OPENER_INLINE_PATTERN = new RegExp(
  `^((?:${GREETING_OPENERS.join('|')})(?!\\p{L})[^.!?;:\\n,]{0,20},)[ \\t]+(\\S.*)$`,
  'iu',
)

/**
 * Longest first line the inline split is allowed to touch.
 *
 * A whole sentence that opens with `Hi,` is content, and the existing rule is
 * that a long opening line is left alone. A short one is a salutation plus a
 * question (`Hi Sarah, how are you?`), and only the salutation is removed.
 */
const INLINE_GREETING_MAX_LINE = 60

/** Words that look like a capitalised name but open a sentence, not a mail. */
const GREETING_STOPWORDS = new Set([
  'anyway',
  'however',
  'also',
  'well',
  'so',
  'but',
  'and',
  'plus',
  'moreover',
  'furthermore',
  'therefore',
  'meanwhile',
  'finally',
  'then',
  'now',
  'ok',
  'okay',
  'sure',
  'yes',
  'no',
  'right',
  'agreed',
  'correct',
  'first',
  'second',
  'lastly',
  'update',
])

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

    // The Outlook reply header marks a boundary wherever it sits. A lone
    // `From:` could be the body (hence the positional weak marker below), but
    // the `From:` + `Sent:`/`Date:` block only appears above quoted history.
    if (isOutlookHeaderBlock(lines, i)) return i

    if (i >= floor && WEAK_QUOTE_MARKERS.some((m) => m.test(trimmed))) {
      return i
    }
  }

  return -1
}

/**
 * A `From:` line followed by `Sent:`/`Date:`, as Outlook writes above a quote.
 *
 * The pair is what makes it unambiguous: a message that merely begins "From:"
 * does not carry the rest of the header block.
 */
function isOutlookHeaderBlock(lines: string[], index: number): boolean {
  if (!/^\s*from:\s*\S/i.test((lines[index] ?? '').trim())) return false

  for (const line of lines.slice(index + 1, index + 4)) {
    if (/^\s*(sent|date):/i.test(line.trim())) return true
  }

  return false
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

/** Index one past the last non-blank line. */
function trimTrailingBlank(lines: string[]): number {
  let end = lines.length
  while (end > 0 && !lines[end - 1].trim()) end--
  return end
}

/**
 * The trailing block, when it reads as a signature card.
 *
 * The positional half of signature detection: some senders sign off with just
 * their name and contact details and no closing word at all. A block qualifies
 * only when a blank line separates it from the prose (a name glued to the last
 * sentence is content), it is at most five lines, and it is made of a name line
 * followed only by name/contact lines.
 */
function trailingSignatureBlock(
  lines: string[],
): { start: number; end: number } | null {
  const end = trimTrailingBlank(lines)
  if (end === 0) return null

  let start = end - 1
  while (start > 0 && lines[start - 1].trim()) start--

  // No blank line above the block means it is the tail of the prose.
  if (start === 0) return null

  const block = lines.slice(start, end)
  if (block.length > 5) return null
  if (!isNameLine(block[0])) return null
  if (!block.every((line) => isContactOrNameLine(line))) return null

  // A lone single word is too weak to call a signature: a newsletter footer
  // ends in `E-mailvoorkeuren` or `Unsubscribe` just as a person ends in their
  // first name. Requiring a second word or line keeps the guess off those
  // footers, and leaving a real first name in the bubble is the cheaper error.
  if (block.length === 1 && nameWordCount(block[0]) < 2) return null

  return { start, end }
}

/** How many capitalised words a name line carries. */
function nameWordCount(line: string): number {
  return line.trim().replace(/,$/, '').split(/\s+/).filter(Boolean).length
}

/**
 * Detect a trailing signature block.
 *
 * Returns the signature text and the body with it removed. Detection is
 * two-pass: a closing word (`Met vriendelijke groeten`, `Groetjes`, `Thanks`)
 * anywhere in the last few lines wins, and only when none is found does the
 * positional fallback try the trailing name/contact block. A known closer is a
 * much stronger signal than position, so it is tried first.
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
    if (!SIGNATURE_MARKERS.some((m) => m.test(lines[i]))) continue

    // Walk forward to the end, skipping trailing blank lines.
    const end = trimTrailingBlank(lines)

    const signature = lines.slice(i, end).join('\n').trim()
    const body = lines.slice(0, i).join('\n').trim()

    // Never strip the whole message.
    if (!body) return { body: text.trim(), signature: null }

    return { body, signature: signature || null }
  }

  // No closing word: a bare name block is still a signature.
  const block = trailingSignatureBlock(lines)
  if (block) {
    const body = lines.slice(0, block.start).join('\n').trim()
    // Never strip the whole message.
    if (body) {
      return {
        body,
        signature: lines.slice(block.start, block.end).join('\n').trim(),
      }
    }
  }

  return { body: text.trim(), signature: null }
}

/**
 * Split a first line into a greeting and whatever the line says after it.
 *
 * Three shapes are accepted, in order of strength: a whole line that is a known
 * opener with a short tail, a whole line that is a bare name (`Nils,`), and a
 * line that starts with an opener and carries the message after the comma
 * (`Hi Sarah, how are you?`). Returns null when the line is content.
 */
function splitGreeting(
  line: string,
): { greeting: string; rest: string } | null {
  if (line.length <= 70 && GREETING_PATTERN.test(line)) {
    return { greeting: line, rest: '' }
  }

  // The positional form is stricter: a short, bare name followed by a comma.
  if (
    line.length <= 40 &&
    NAME_GREETING_PATTERN.test(line) &&
    !GREETING_STOPWORDS.has(line.replace(/,$/, '').trim().toLowerCase())
  ) {
    return { greeting: line, rest: '' }
  }

  if (line.length > INLINE_GREETING_MAX_LINE) return null

  const inline = OPENER_INLINE_PATTERN.exec(line)
  if (!inline) return null

  const greeting = inline[1].trim()
  const rest = inline[2].trim()
  // A salutation longer than this is the start of a sentence, not a greeting.
  if (greeting.length > 40 || !rest) return null

  return { greeting, rest }
}

/**
 * Strip a leading greeting.
 *
 * Only the first non-empty line is looked at. A greeting never costs the
 * message its content: when the line continues past the salutation, only the
 * greeting is removed and the rest of the line is kept as the body's first
 * line. A long sentence that merely starts with "Hi" is content.
 */
export function stripGreeting(text: string): {
  body: string
  greeting: string | null
} {
  if (!text || !text.trim()) return { body: '', greeting: null }

  const lines = toLines(text)
  const firstIdx = lines.findIndex((l) => l.trim())

  if (firstIdx === -1) return { body: '', greeting: null }

  const split = splitGreeting(lines[firstIdx].trim())
  if (!split) return { body: text.trim(), greeting: null }

  const bodyLines = lines.slice(firstIdx + 1)
  if (split.rest) bodyLines.unshift(split.rest)

  const body = bodyLines.join('\n').trim()

  // If the greeting is the entire message, keep it — it's the content.
  if (!body) return { body: text.trim(), greeting: null }

  return { body, greeting: split.greeting }
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
 * A reference to an inline image that a plain-text body shows as literal text.
 *
 * Outlook, Gmail and the calendar invites they emit put the image in the HTML
 * part and write `[cid:logo]` where it belongs in the text part — the filename
 * or the Content-ID, wrapped in brackets. It is a placeholder, not something the
 * sender typed, and it reads as noise in a chat bubble.
 */
const CID_PLACEHOLDER = /\[cid:[^\]\r\n]*\]/i

/** The same token, matched repeatedly for removal. */
const CID_PLACEHOLDER_GLOBAL = /\[cid:[^\]\r\n]*\]/gi

/**
 * Remove `[cid:...]` image placeholders from a plain-text body.
 *
 * Most often the token is the sender's signature logo, which makes this more
 * than cosmetic: the signature is stored and offered back when replying, so the
 * placeholder would otherwise be pasted into the user's own reply as text.
 *
 * A token alone on its line is dropped together with the line: the image occupied
 * that line, and leaving the blank behind only separates a signature from the
 * name above it.
 */
export function stripCidPlaceholders(text: string): string {
  if (!CID_PLACEHOLDER.test(text)) return text

  // Line-wise rather than with a global replace: a token that is the whole line
  // takes the line with it, and a token inside a sentence leaves a double space
  // behind that has to be closed up. Doing both in one pattern trades one
  // artifact for the other.
  return text
    .split('\n')
    .filter((line) => !WHOLE_LINE_CID.test(line))
    .map((line) => {
      if (!CID_PLACEHOLDER.test(line)) return line
      return line
        .replace(CID_PLACEHOLDER_GLOBAL, ' ')
        .replace(/[ \t]{2,}/g, ' ')
        .trim()
    })
    .join('\n')
}

/** A line that holds nothing but an image placeholder. */
const WHOLE_LINE_CID = /^[ \t]*\[cid:[^\]\r\n]*\][ \t]*\r?$/i

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
