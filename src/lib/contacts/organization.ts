/**
 * The organisation a correspondent belongs to, read from their address.
 *
 * Companies and teams are the groups that actually connect people: two addresses
 * at `acme.com` are colleagues even when they have never written to each other,
 * and a reply to one of them is worth knowing about when the other writes next.
 * The domain is the one signal every message carries, and unlike a stored row it
 * cannot drift from the mail or need a migration.
 *
 * Two deliberate limits:
 *
 * - **Derived, never written.** This is a reading of the address, so there is no
 *   table to keep true, no refresh to schedule and nothing for a rename to move.
 *   Where the reading is wrong — two unrelated firms on one domain — the user is
 *   not asked to fix it, because no tag or profile depends on it.
 * - **A readable label, not a brand.** The name is the domain's own label
 *   ("acme.com" → "Acme"), never an invented company name. Guessing a brand from
 *   `roleCompany` would put a model's wording into a grouping the user did not
 *   ask for.
 *
 * Shared mailbox providers are excluded on purpose: `gmail.com` is not an
 * organisation, and grouping every personal contact under "Gmail" would be worse
 * than leaving them ungrouped.
 */

/** Where a domain is a mailbox provider rather than an organisation. */
const SHARED_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'hotmail.co.uk',
  'live.com',
  'live.nl',
  'msn.com',
  'yahoo.com',
  'yahoo.co.uk',
  'ymail.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'tutanota.com',
  'tuta.com',
  'fastmail.com',
  'hey.com',
  'gmx.com',
  'gmx.de',
  'gmx.net',
  'web.de',
  't-online.de',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'yandex.ru',
  'mail.ru',
  'qq.com',
  '163.com',
  '126.com',
  'naver.com',
  'daum.net',
])

/**
 * Country suffixes with two labels, so `acme.co.uk` is one organisation rather
 * than an "Acme" under "Co".
 */
const MULTI_PART_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'co.nz',
  'com.au',
  'net.au',
  'org.au',
  'co.za',
  'com.br',
  'com.ar',
  'com.mx',
  'com.tr',
  'co.jp',
  'ne.jp',
  'co.kr',
  'com.sg',
  'com.hk',
  'co.in',
  'co.il',
  'com.cn',
  'com.pl',
  'co.id',
])

export type ContactOrganization = {
  /** Registrable domain, and the grouping key. */
  domain: string
  /** The domain's own label, title-cased: "acme-corp.com" → "Acme Corp". */
  name: string
}

/** How long the one-line description of a company may be. */
export const ORGANIZATION_FOCUS_LIMIT = 160

/**
 * A company description as the app stores and shows it: one trimmed line.
 *
 * The description says what the company does, so it is a sentence rather than
 * prose: a signature's line breaks are flattened and a runaway answer is bounded
 * rather than refused. Anything that is not a string is simply no description.
 */
export function normaliseOrganizationFocus(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, ORGANIZATION_FOCUS_LIMIT)
}

/**
 * The organisation behind an address, or null when there is no useful one.
 *
 * A personal mailbox returns null, and so does anything without a dotted host —
 * the caller then simply shows the person ungrouped.
 */
export function contactOrganization(email: string): ContactOrganization | null {
  const address = email.trim().toLowerCase()
  const at = address.lastIndexOf('@')
  if (at < 0) return null

  const host = address
    .slice(at + 1)
    .replace(/\.+$/, '')
    .replace(/^www\./, '')
  if (!host.includes('.')) return null
  if (SHARED_DOMAINS.has(host)) return null

  const labels = host.split('.').filter((label) => label.length > 0)
  if (labels.length < 2) return null

  const suffix = labels.slice(-2).join('.')
  const needed = MULTI_PART_SUFFIXES.has(suffix) ? 3 : 2
  if (labels.length < needed) return null

  const domain = labels.slice(-needed).join('.')
  const name = readableName(labels.at(-needed) ?? '')
  if (!name) return null

  return { domain, name }
}

/** Hyphens become spaces so `acme-corp` reads as a name rather than a host. */
function readableName(label: string): string {
  const words = label.split(/[-_]+/).filter((word) => word.length > 0)
  if (words.length === 0) return ''
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}
