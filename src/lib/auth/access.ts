/**
 * How people get into this install.
 *
 * `invite` is the beta: an invite code is the credential, `/request-access`
 * asks for one, and the password forms are unreachable. `login` restores the
 * open email + password flow this app shipped before the beta.
 *
 * Defaulting to `invite` rather than `login` is deliberate: the whole point is
 * that a fresh deployment cannot be registered against, and forgetting an env
 * var is exactly how that would happen. An existing install that wants the old
 * behaviour sets `LUMEN_ACCESS_MODE=login`.
 *
 * `/admin` is the exception in both modes — the operator keeps a password form
 * at `/admin/sign-in`. Closing the front door to testers must not close it on
 * the only person who can issue another invite.
 */

export const ACCESS_MODES = ['invite', 'login'] as const

export type AccessMode = (typeof ACCESS_MODES)[number]

export function accessMode(): AccessMode {
  const raw = process.env.LUMEN_ACCESS_MODE?.trim().toLowerCase()
  return raw === 'login' ? 'login' : 'invite'
}

/** True when the beta's gate is on. */
export function invitesOnly(): boolean {
  return accessMode() === 'invite'
}
