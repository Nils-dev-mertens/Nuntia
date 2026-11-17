import type { APIRoute } from 'astro'
import { absoluteUrl } from '../lib/site'

export const prerender = true

const pages = [
  { path: '/', changefreq: 'monthly', priority: '1.0' },
  { path: '/contact', changefreq: 'yearly', priority: '0.5' },
  { path: '/privacy', changefreq: 'yearly', priority: '0.3' },
  { path: '/terms', changefreq: 'yearly', priority: '0.3' },
]

export const GET: APIRoute = () =>
  new Response(
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages
  .map(
    (page) => `  <url>
    <loc>${absoluteUrl(page.path)}</loc>
    <changefreq>${page.changefreq}</changefreq>
    <priority>${page.priority}</priority>
  </url>`,
  )
  .join('\n')}
</urlset>
`,
    { headers: { 'Content-Type': 'application/xml; charset=utf-8' } },
  )
