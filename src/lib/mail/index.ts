/**
 * Mail parsing layer.
 *
 * Import from here rather than the individual modules — the split between
 * parse/strip/compose is an implementation detail.
 */

export type {
  CleanedMessage,
  MailPart,
  ParsedMessage,
  StripOptions,
} from './types.ts'

export {
  cleanBody,
  findQuoteStart,
  stripCidPlaceholders,
  stripGreeting,
  stripInvisibleCharacters,
  stripQuotedText,
  stripSignature,
} from './strip.ts'

export {
  extractHtmlBody,
  hasQuotedHtml,
  htmlToPlainText,
  stripHtmlGreeting,
  stripHtmlSignature,
  stripQuotedHtml,
} from './html.ts'

// Dependency-free, so importing it does not pull the parser into a client bundle.
export { isRichHtml } from './rich.ts'

export { sanitizeEmailHtml } from './sanitize.ts'

export {
  hasInlineImage,
  parseRawMessage,
  selectAttachments,
  selectBodyPart,
} from './parse.ts'

export {
  buildMimeMessage,
  composeNewMessage,
  composeReply,
  encodeQuotedPrintable,
} from './compose.ts'

export type { ComposeInput, MimeAttachment } from './compose.ts'
