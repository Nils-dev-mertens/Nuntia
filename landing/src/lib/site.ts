/**
 * The public origin of the landing site.
 *
 * Like `PUBLIC_APP_URL`, this is read at build time: canonical links, the share
 * image URL and the sitemap all need an absolute origin, and there is no server
 * at runtime to discover one. Deployments override it with `PUBLIC_SITE_URL`.
 */
const FALLBACK_SITE_URL = 'https://nuntia.app'

export const siteUrl = (
  import.meta.env.PUBLIC_SITE_URL ?? FALLBACK_SITE_URL
).replace(/\/+$/, '')

/** Join a root-relative path onto the site origin. */
export function absoluteUrl(path = '/'): string {
  return `${siteUrl}${path.startsWith('/') ? path : `/${path}`}`
}
