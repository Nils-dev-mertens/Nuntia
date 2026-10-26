/**
 * The parts of an invite code that need a server.
 *
 * Split out of `codes.ts` so the browser never pulls in `node:crypto` — the
 * code-entry page imports the pure helpers, and Vite externalises anything that
 * reaches for a Node built-in, which is a runtime error rather than a build
 * error.
 *
 * Only SHA-256 of a code is stored for lookup; the code itself is stored
 * encrypted (see `repository.ts`) purely so the operator can copy the link
 * again. Neither form is ever sent to the browser of an ordinary user.
 */

import { createHash, randomInt } from 'node:crypto'

import { ALPHABET, CODE_LENGTH, normaliseCode } from './codes.ts'

/**
 * A fresh code, grouped for display.
 *
 * `randomInt` rather than `byte % 32`: modulo over a byte is biased toward the
 * first eight letters, and a credential is not the place to accept that.
 */
export function generateCode(): string {
  let raw = ''
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    raw += ALPHABET[randomInt(0, ALPHABET.length)]
  }
  return group(raw)
}

/** `A1B2C3D4E5F6` becomes `A1B2-C3D4-E5F6`. */
function group(raw: string): string {
  return raw.match(/.{1,4}/g)?.join('-') ?? raw
}

/**
 * The stored lookup form of a code.
 *
 * SHA-256 without a salt is right here: the input is 60 bits of randomness, so
 * a rainbow table would have to enumerate the whole space, and a per-row salt
 * would break the single-index lookup redemption depends on.
 */
export function hashCode(code: string): string {
  return createHash('sha256').update(normaliseCode(code) ?? code).digest('hex')
}
