/**
 * How people get into this install.
 *
 * `invite` is the beta: an invite code is what creates an account, and
 * `/request-access` is how one is asked for. Signing in with an address and
 * password works in both modes — only registration is gated, so a tester who
 * clears their cookie is not dependent on finding the approval email again.
 * `login` reopens open registration on top of that.
 *
 * Defaulting to `invite` rather than `login` is deliberate: the whole point is
 * that a fresh deployment cannot be registered against, and forgetting an env
 * var is exactly how that would happen. An existing install that wants the old
 * behaviour sets `LUMEN_ACCESS_MODE=login`.
 *
 * `/admin` has its own password form at `/admin/sign-in` in both modes, and the
 * first admin is an operator either way. Closing the front door to testers must
 * not close it on the only person who can issue another invite.
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
