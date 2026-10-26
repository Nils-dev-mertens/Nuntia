/**
 * Invite codes: the shape, and how a typed code is normalised.
 *
 * This module is deliberately **browser-safe** — no `node:` imports, no
 * database, nothing that needs a request. The code entry page normalises what
 * was typed before navigating, which makes this file part of the client bundle;
 * a `node:crypto` import here would be externalised by Vite and throw the
 * moment someone opened the form.
 *
 * The parts that need randomness or hashing live in `secrets.ts`, which is only
 * ever imported by server code. Keeping the split in two files rather than one
 * is what makes that boundary checkable: `codes.test.ts` asserts this file has
 * no `node:` import at all.
 *
 * The alphabet is Crockford base32 — no `I`, `L`, `O` or `U`. An invite is a
 * credential people read aloud, retype from a screenshot, and paste out of a
 * chat message, so the code has to survive all three. Twelve characters is 60
 * bits: far beyond guessing at any rate a human or a script will reach, and
 * still short enough to say on a call.
 */

/** Crockford base32: 0-9 and A-Z without I, L, O and U. */
export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export const CODE_LENGTH = 12

/** Characters used only for display; they are stripped before hashing. */
const SEPARATORS = /[\s-]+/g

/** `O`/`I`/`L` are the three the alphabet deliberately omits. */
const CONFUSABLES: Record<string, string> = {
  O: '0',
  I: '1',
  L: '1',
}

/**
 * Reduce what was typed to the canonical form, or null when it cannot be one.
 *
 * Case, spaces and dashes are forgiven because they are transcription, not
 * information. `O` and `I`/`L` are mapped rather than rejected for the same
 * reason: they are the mistakes the alphabet was chosen to invite.
 */
export function normaliseCode(input: string): string | null {
  if (typeof input !== 'string') return null

  const stripped = input
    .replace(SEPARATORS, '')
    .toUpperCase()
    .split('')
    .map((char) => CONFUSABLES[char] ?? char)
    .join('')

  if (stripped.length !== CODE_LENGTH) return null
  for (const char of stripped) {
    if (!ALPHABET.includes(char)) return null
  }

  return stripped
}

/** `A1B2C3D4E5F6` becomes `A1B2-C3D4-E5F6`. Accepts either form. */
export function formatCode(code: string): string {
  const canonical = normaliseCode(code) ?? code.replace(SEPARATORS, '')
  return canonical.match(/.{1,4}/g)?.join('-') ?? canonical
}
