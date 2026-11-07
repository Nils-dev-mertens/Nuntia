/**
 * The team directory's shared shapes.
 *
 * Kept free of the database and `node:crypto` so the composer and the settings
 * form can import a `TeamMember` and the field limits without pulling server
 * code into the browser bundle.
 */

/** One colleague the user can @mention or route mail to. */
export type TeamMember = {
  id: string
  name: string
  email: string
  /** What they handle; shown beside the name and available to routing later. */
  role: string | null
}

export type TeamMemberInput = {
  /** Null for a new member; the id when editing an existing one. */
  id: string | null
  name: string
  email: string
  role: string | null
}

export const TEAM_MEMBER_LIMITS = {
  name: 80,
  email: 254,
  role: 200,
} as const

/**
 * Validate and normalise what the settings form submitted.
 *
 * The email is lowercase because it is the identity of the row and addresses are
 * case-insensitive in practice; the name and role keep the user's casing. Null
 * means the input is unusable, and the caller turns that into one sentence.
 */
export function normaliseTeamMemberInput(
  input: unknown,
): TeamMemberInput | null {
  if (!input || typeof input !== 'object') return null

  const candidate = input as Record<string, unknown>
  const name = typeof candidate.name === 'string' ? candidate.name.trim() : ''
  const email =
    typeof candidate.email === 'string'
      ? candidate.email.trim().toLowerCase()
      : ''
  const role = typeof candidate.role === 'string' ? candidate.role.trim() : ''
  const id =
    typeof candidate.id === 'string' && candidate.id.trim()
      ? candidate.id.trim()
      : null

  if (
    !name ||
    name.length > TEAM_MEMBER_LIMITS.name ||
    !email ||
    email.length > TEAM_MEMBER_LIMITS.email ||
    role.length > TEAM_MEMBER_LIMITS.role ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return null
  }

  return { id, name, email, role: role || null }
}
