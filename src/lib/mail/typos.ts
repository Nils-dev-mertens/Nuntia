/**
 * A pass over the text before it is sent.
 *
 * Everyone types "the the" now and then, and a mail app is the last place a
 * reader will forgive it. The composer offers this as a button rather than
 * fixing things behind the user's back: the text that goes out is theirs, so a
 * change has to be asked for and has to be undoable.
 *
 * Deliberately not a spell checker. There is no dictionary here and no model
 * call — only the slips that are wrong in any language and cheap to spot: a
 * doubled word, punctuation with a space on the wrong side, a missing space
 * after a comma, and a small list of English words that are almost always a
 * dropped apostrophe. Anything that needs to know what the sentence means is
 * left alone.
 *
 * Pure, so it can be used from the browser without pulling in the mail parser:
 * import this module directly, not through the mail barrel.
 */

export type TypingFixResult = {
  text: string
  /** One sentence per change, for the line the composer shows afterwards. */
  fixes: string[]
}

/**
 * Words that are a dropped apostrophe or a swapped pair far more often than they
 * are real words. Kept short on purpose: every entry is a chance to rewrite
 * something the user meant, and "im" or "its" would be that chance too often.
 */
const COMMON_TYPOS: Record<string, string> = {
  adn: 'and',
  alot: 'a lot',
  arent: "aren't",
  becuase: 'because',
  cant: "can't",
  couldnt: "couldn't",
  definately: 'definitely',
  didnt: "didn't",
  doesnt: "doesn't",
  dont: "don't",
  isnt: "isn't",
  occured: 'occurred',
  recieve: 'receive',
  seperate: 'separate',
  shouldnt: "shouldn't",
  teh: 'the',
  thats: "that's",
  thier: 'their',
  wasnt: "wasn't",
  werent: "weren't",
  whats: "what's",
  wont: "won't",
  wouldnt: "wouldn't",
  youre: "you're",
}

/** Keep the capital the user typed: "Dont" becomes "Don't", not "don't". */
function matchCase(original: string, replacement: string): string {
  const first = original.charAt(0)
  if (first !== first.toUpperCase()) return replacement
  return replacement.charAt(0).toUpperCase() + replacement.slice(1)
}

export function fixTypingSlips(text: string): TypingFixResult {
  if (!text.trim()) return { text, fixes: [] }

  const fixes: string[] = []
  /** Shared wording, noted once however many times it happens. */
  function note(description: string): void {
    if (!fixes.includes(description)) fixes.push(description)
  }

  let result = text

  // A word repeated straight after itself, in either case ("the the", "The the").
  result = result.replace(
    /\b([A-Za-z][A-Za-z'’-]*)([ \t]+)\1\b/gi,
    (match, word: string) => {
      if (word !== match) fixes.push(`removed a doubled “${word}”`)
      return word
    },
  )

  result = result.replace(/[ \t]{2,}/g, () => {
    note('collapsed extra spaces')
    return ' '
  })

  // "Hi ,there" and "really !" — punctuation belongs against the word before it.
  result = result.replace(/[ \t]+([,.;:!?])/g, (_match, mark: string) => {
    note(`moved a space away from “${mark}”`)
    return mark
  })

  result = result.replace(/([,;:])(?=[A-Za-z])/g, (_match, mark: string) => {
    note(`added a space after “${mark}”`)
    return `${mark} `
  })

  // A full stop glued to the next sentence. Capital-then-lowercase keeps this
  // away from abbreviations ("U.S.A") and from file names.
  result = result.replace(/\.(?=[A-Z][a-z])/g, () => {
    note('added a space after a full stop')
    return '. '
  })

  // Typo words are replaced a whitespace chunk at a time, and a chunk holding an
  // address or a URL is skipped entirely: rewriting somebody's email address
  // because its local part happens to be "dont" would be worse than the typo.
  result = result.replace(/\S+/g, (chunk) => {
    if (chunk.includes('@') || chunk.includes('://')) return chunk

    return chunk.replace(/\b[A-Za-z]+(?:'[A-Za-z]+)?\b/g, (word) => {
      const fix = COMMON_TYPOS[word.toLowerCase()]
      if (!fix) return word
      const replacement = matchCase(word, fix)
      fixes.push(`“${word}” → “${replacement}”`)
      return replacement
    })
  })

  result = result.replace(/[ \t]+(?=\r?\n)/g, () => {
    note('trimmed trailing spaces')
    return ''
  })

  return { text: result, fixes }
}
