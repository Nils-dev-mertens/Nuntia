/**
 * The origin this install answers on, as the outside world sees it.
 *
 * Needed wherever an absolute URL is handed to someone else — an invitation
 * link in an email, the OAuth `redirect_uri` a provider will send the browser
 * back to. It cannot be derived from the incoming request: behind a reverse
 * proxy or a tunnel the request's own origin is the internal address, and a
 * callback registered at `localhost` is a browser pointed at the visitor's own
 * machine. `LUMEN_APP_URL` is configuration for exactly that reason, and the
 * default exists so a local `bun run dev` needs no configuration at all.
 */

const DEFAULT_APP_URL = 'http://localhost:3000'

/** `LUMEN_APP_URL` without a trailing slash, or the development default. */
export function appUrl(): string {
  const configured = process.env.LUMEN_APP_URL?.trim()
  return (configured || DEFAULT_APP_URL).replace(/\/+$/, '')
}

/** An absolute URL on this install, e.g. `callbackUrl('/auth/google/callback')`. */
export function appUrlFor(path: string): string {
  return `${appUrl()}${path.startsWith('/') ? path : `/${path}`}`
}
