/**
 * Token encryption at rest.
 *
 * OAuth refresh tokens are long-lived credentials: anyone with the database
 * file gets permanent access to the user's mailbox. They are stored encrypted
 * with AES-256-GCM under a key from `TOKEN_ENCRYPTION_KEY`.
 *
 * GCM gives us authenticated encryption, so a tampered ciphertext fails to
 * decrypt rather than yielding garbage. The envelope is versioned so the scheme
 * can be rotated later without ambiguity about stored data.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const KEY_BYTES = 32
/** Bumped if the scheme ever changes; stored in the envelope prefix. */
const ENVELOPE_VERSION = 'v1'
/** The deterministic variant; a separate prefix because the envelope differs. */
const MATCH_ENVELOPE_VERSION = 'v1d'

/**
 * Read and validate the encryption key.
 *
 * Throws rather than falling back to a default — a default key would mean every
 * install shares a key, which is worse than failing loudly at startup.
 */
function loadKey(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY

  if (!raw) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY is not set. Generate one with: openssl rand -hex 32',
    )
  }

  const key = /^[0-9a-f]{64}$/i.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64')

  if (key.length !== KEY_BYTES) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}. ` +
        'Use `openssl rand -hex 32` for a 64-character hex key.',
    )
  }

  return key
}

/**
 * Encrypt a string for storage.
 *
 * Output format: `v1:<iv-base64>:<tag-base64>:<ciphertext-base64>`
 */
export function encrypt(plaintext: string): string {
  const key = loadKey()
  const iv = randomBytes(IV_BYTES)

  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()

  return [
    ENVELOPE_VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':')
}

/**
 * Decrypt a stored envelope.
 *
 * Throws on a wrong key or tampered data — that is the point of GCM, and it
 * must not be swallowed into a silent null.
 */
export function decrypt(envelope: string): string {
  const key = loadKey()

  const parts = envelope.split(':')
  if (parts.length !== 4) {
    throw new Error('Malformed token envelope: expected 4 colon-separated parts')
  }

  const [version, ivB64, tagB64, ciphertextB64] = parts

  if (version !== ENVELOPE_VERSION) {
    throw new Error(
      `Unsupported token envelope version "${version}", expected ${ENVELOPE_VERSION}`,
    )
  }

  const iv = Buffer.from(ivB64, 'base64')
  const tag = Buffer.from(tagB64, 'base64')
  const ciphertext = Buffer.from(ciphertextB64, 'base64')

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    'utf8',
  )
}

/**
 * Deterministic encryption, for columns that have to stay comparable in SQL.
 *
 * A few personal values are also keys: the address on a contact, the sender on
 * a profile, the target of a revision row. Those columns are compared in the
 * database (`WHERE email = ?`, primary keys, uniqueness), so a random IV per
 * row would make equal values look different and every lookup would miss.
 *
 * This variant derives the IV from the plaintext instead of drawing it at
 * random, so the same input always produces the same stored string. Equality,
 * indexes and unique constraints keep working, and the value is still
 * unreadable without the key.
 *
 * The trade is real and belongs in the open: equal values are visibly equal, so
 * a database reader can see *that* two rows share an address (not what it is),
 * and a low-entropy value can be confirmed by guessing candidates. Only columns
 * that must be found by equality use this; everything else uses the random-IV
 * envelope above.
 *
 * Output format: `v1d:<iv-base64>:<tag-base64>:<ciphertext-base64>`. The IV is
 * stored only because decrypt needs it; it is not secret (it is a keyed
 * function of the plaintext, so it leaks nothing the ciphertext does not).
 */
export function encryptMatch(plaintext: string): string {
  const key = loadKey()

  // HMAC rather than a plain hash: a bare hash of the address would let anyone
  // holding the file test candidate addresses without the key.
  const iv = createHmac('sha256', key)
    .update(`${MATCH_ENVELOPE_VERSION}:iv:`)
    .update(plaintext, 'utf8')
    .digest()
    .subarray(0, IV_BYTES)

  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()

  return [
    MATCH_ENVELOPE_VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':')
}

/** True when a stored value is one of the deterministic envelopes. */
export function isMatchEnvelope(value: string): boolean {
  return value.startsWith(`${MATCH_ENVELOPE_VERSION}:`)
}

/** Decrypt a `v1d:` envelope. Throws on a wrong key or tampered data. */
export function decryptMatch(envelope: string): string {
  const key = loadKey()

  const parts = envelope.split(':')
  if (parts.length !== 4) {
    throw new Error(
      'Malformed match envelope: expected 4 colon-separated parts',
    )
  }

  const [version, ivB64, tagB64, ciphertextB64] = parts

  if (version !== MATCH_ENVELOPE_VERSION) {
    throw new Error(
      `Unsupported match envelope version "${version}", expected ${MATCH_ENVELOPE_VERSION}`,
    )
  }

  const iv = Buffer.from(ivB64, 'base64')
  const tag = Buffer.from(tagB64, 'base64')
  const ciphertext = Buffer.from(ciphertextB64, 'base64')

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    'utf8',
  )
}

/**
 * Decrypt without throwing.
 *
 * For call sites where a missing or undecryptable token means "not signed in"
 * rather than "something is broken".
 */
export function tryDecrypt(envelope: string | null | undefined): string | null {
  if (!envelope) return null

  try {
    return decrypt(envelope)
  } catch {
    return null
  }
}
