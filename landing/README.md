# Nuntia landing page

A separate Astro site for the public page. It is not part of the app build and
does not import from the app: the app is served by the Bun process in the
repository root, this is static HTML/CSS/JS.

Stack, as decided in issue #7:

- **Astro** for the page. Every section is static HTML; the hero workbench is
  the only island.
- **React** for that island: a working demo of the inbox — sections and tags
  filter, search narrows the list, threads open, states change, tags are added
  and removed, a draft can be moved into the reply box. The mail is synthetic
  and stays in `src/components/HeroVisual.tsx`.
- **Motion** for the parts CSS cannot do: list rows animating out as a filter
  changes, the reading pane crossfading between threads, counts updating.
- **A ReactBits-style animated background** behind the hero (a canvas grid of
  hairline cells with slow orange pulses), implemented locally rather than
  copied in as a dependency. It stops drawing when it scrolls out of view.
- **CSS + one IntersectionObserver** for section reveals, so the rest of the
  page stays HTML. `data-reveal` on a block is enough; `--reveal-delay` staggers
  a list. Reduced motion shows everything immediately, and the page needs no
  JavaScript at all to be readable.

All copy comes from `../docs/landing-page-info.md`. Nothing on the page claims a
feature the app does not have: no "real-time" mail, no end-to-end encryption, no
"free forever", no team workspace. The demo says so too — nothing is sent from
it.

## Run it

```bash
cd landing
bun install
cp .env.example .env        # set both origins for your deployment
bun run dev                 # http://localhost:4321
bun run build               # static files in landing/dist
bun run preview
```

Both variables are read at build time. `PUBLIC_APP_URL` fills the **Sign in** and
**Request access** links; without it they point at `http://localhost:3000`.
`PUBLIC_SITE_URL` is the landing site's own origin and is used in the canonical
link, the Open Graph/Twitter image URL, `robots.txt` and `sitemap.xml`; it falls
back to `https://nuntia.app`.

The share card is `public/og.png` (1200×630).

## Deploying

`dist/` is a plain static folder. Serve it at the domain you want the landing
page on, and point the app at a different host (or a different path) so the two
do not collide.
