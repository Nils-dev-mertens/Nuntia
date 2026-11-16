---
name: Radical Frontier
colors:
  surface: '#131315'
  surface-dim: '#131315'
  surface-bright: '#39393b'
  surface-container-lowest: '#0e0e10'
  surface-container-low: '#1c1b1d'
  surface-container: '#201f21'
  surface-container-high: '#2a2a2c'
  surface-container-highest: '#353437'
  on-surface: '#e5e1e4'
  on-surface-variant: '#e4beb4'
  inverse-surface: '#e5e1e4'
  inverse-on-surface: '#313032'
  outline: '#ab8980'
  outline-variant: '#5b4039'
  surface-tint: '#ffb5a0'
  primary: '#ffb5a0'
  on-primary: '#5f1500'
  primary-container: '#ff5722'
  on-primary-container: '#541200'
  inverse-primary: '#b02f00'
  secondary: '#ffc789'
  on-secondary: '#482a00'
  secondary-container: '#ffa10a'
  on-secondary-container: '#673e00'
  tertiary: '#3ce36a'
  on-tertiary: '#003912'
  tertiary-container: '#00a744'
  on-tertiary-container: '#00320f'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#ffdbd1'
  primary-fixed-dim: '#ffb5a0'
  on-primary-fixed: '#3b0900'
  on-primary-fixed-variant: '#862200'
  secondary-fixed: '#ffddba'
  secondary-fixed-dim: '#ffb865'
  on-secondary-fixed: '#2b1700'
  on-secondary-fixed-variant: '#663d00'
  tertiary-fixed: '#69ff87'
  tertiary-fixed-dim: '#3ce36a'
  on-tertiary-fixed: '#002108'
  on-tertiary-fixed-variant: '#00531e'
  background: '#131315'
  on-background: '#e5e1e4'
  surface-variant: '#353437'
typography:
  display-xl:
    fontFamily: Space Grotesk
    fontSize: 72px
    fontWeight: '600'
    lineHeight: 76px
    letterSpacing: -0.04em
  display-xl-mobile:
    fontFamily: Space Grotesk
    fontSize: 40px
    fontWeight: '600'
    lineHeight: 44px
    letterSpacing: -0.03em
  display-lg:
    fontFamily: Space Grotesk
    fontSize: 56px
    fontWeight: '500'
    lineHeight: 60px
    letterSpacing: -0.03em
  display-lg-mobile:
    fontFamily: Space Grotesk
    fontSize: 32px
    fontWeight: '500'
    lineHeight: 36px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Space Grotesk
    fontSize: 36px
    fontWeight: '500'
    lineHeight: 42px
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Space Grotesk
    fontSize: 28px
    fontWeight: '500'
    lineHeight: 34px
    letterSpacing: -0.015em
  headline-sm:
    fontFamily: Space Grotesk
    fontSize: 20px
    fontWeight: '500'
    lineHeight: 26px
    letterSpacing: -0.01em
  body-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 28px
    letterSpacing: -0.01em
  body-md:
    fontFamily: Inter
    fontSize: 15px
    fontWeight: '400'
    lineHeight: 24px
    letterSpacing: 0em
  body-sm:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 20px
    letterSpacing: 0em
  label-code:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
    letterSpacing: 0.04em
  label-caps:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: '500'
    lineHeight: 14px
    letterSpacing: 0.12em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  gutter: 1.5rem
  gutter-desktop: 2rem
  margin: 1.25rem
  margin-desktop: 3rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 1rem
  space-lg: 1.5rem
  space-xl: 2.5rem
  space-2xl: 4rem
  space-3xl: 6rem
---

## Brand & Style

The design system embraces an intellectual, razor-sharp European engineering philosophy paired with playful retro-digital nostalgia. It strips away SaaS embellishments—gradients, floating frosted drop shadows, and pill-bloat—in favor of radical spatial restraint, pure architectural void, and high-impact typographic authority. 

Built for cutting-edge researchers, developers, sovereign infrastructure architects, and technical pioneers, the aesthetic conveys serious intellectual rigor with an irreverent hacker spirit. The visual architecture combines stark obsidian canvases (`#0A0A0C`), flat geometric blocks in fiery amber-to-cadmium gradients, crisp hairline architectural grids, and pixel-art sprite moments that disrupt corporate clinicalism. The movement marries Neo-Brutalist structural discipline with pure Minimalist reduction.

## Colors

The palette operates on stark, absolute values. Surface layers rely on ultra-deep blacks rather than muddy greys to maximize contrast against pure white typography. Warm energetic accents punctuate the canvas strictly to indicate interactive energy, system state, or architectural focal points.

- **Canvas & Surface:**
  - `surface-canvas`: `#0A0A0C` (Absolute void, page background)
  - `surface-elevated`: `#111113` (Structural card backing, segmented modules)
  - `surface-subtle`: `#18181B` (Interactive hover planes, input fields)
  - `border-hairline`: `rgba(255, 255, 255, 0.12)` (Razor-thin grid rules, dividers)
  - `border-subtle`: `rgba(255, 255, 255, 0.06)` (Background cell lines, quiet framing)

- **Brand & Semantic Accents:**
  - `primary` (`#FF5722`): Vibrant cadmium red-orange; used for dominant action accents, geometric blocks, and brand highlights.
  - `secondary` (`#FFA000`): Pure warm amber; used for sequential block stepping, badges, and warning states.
  - `tertiary` (`#00C853`): Vibrant terminal green; used for sandbox arenas, status indicators, and research callouts.

- **Typography & Monochrome:**
  - `text-primary`: `#FFFFFF` (100% white, uncompromising contrast)
  - `text-secondary`: `rgba(255, 255, 255, 0.72)` (Readable explanatory copy)
  - `text-muted`: `rgba(255, 255, 255, 0.40)` (Technical metadata, captions, timestamps)

## Typography

The typographic hierarchy utilizes three distinct functional roles:

1. **Display & Headings (Space Grotesk):** Engineered with geometric directness, flat apexes, and deliberate mechanical quirks. Tight kerning (`-0.03em` to `-0.04em`) creates authoritative editorial impact without relying on ultra-heavy weights.
2. **Body & Prose (Inter):** Neutral, hyper-legible, screen-optimized sans-serif calibrated for extended technical reading and sustained contrast against obsidian surfaces.
3. **Metadata, Tags & Overlines (JetBrains Mono):** Monospaced precision for technical breadcrumbs, latency/FPS telemetry counters, model capacities, and navigation overlines (`text-transform: uppercase`).

All display sizes gracefully scale between desktop viewports and compact mobile viewports via distinct baseline scales.

## Layout & Spacing

The layout is anchored to a structural 12-column architectural grid on desktop and a 4-column grid on mobile. Boundaries between layout zones are explicitly articulated via 1px hairline rules (`rgba(255, 255, 255, 0.12)`) rather than floating whitespace or soft shadows.

- **Breakpoints:**
  - Mobile: `< 768px` (4 columns, `margin: 1.25rem`, single-column vertical stacks)
  - Tablet: `768px - 1024px` (8 columns, `margin: 2rem`)
  - Desktop: `> 1024px` (12 columns, max-width `1440px`, centered, `margin-desktop: 3rem`)

- **Spatial Rhythm:**
  Massive vertical voids (`space-3xl` / 96px) separate hero sections and narrative tiers, emphasizing an open academic and research atmosphere. Component padding within cards and inputs remains tightly calibrated to an 8px modular cadence (`space-sm` to `space-xl`).

## Elevation & Depth

This design system deliberately eschews realistic lighting, skeuomorphic bevels, and atmospheric drop shadows. Depth is communicated strictly through planar overlay and tonal delineation:

- **Level 0 (Canvas):** Pure `#0A0A0C`. The infinite foundation.
- **Level 1 (Structural Framing):** Outlined by flat 1px borders (`rgba(255, 255, 255, 0.12)`) on `#111113`. No shadow offset.
- **Level 2 (Popovers, Modals & Floating Pills):** Background `#18181B` enclosed in an exact 1px crisp outline, accompanied by an ultra-crisp, zero-blur perimeter line (`box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.16)`).
- **Retro Isometric Depth:** When three-dimensional mass is required (e.g., hero illustrations or feature blocks), it is constructed via hard-edged geometric shapes (diamonds, 45-degree tilted cubes, pixel sprites) rather than blur-based elevation.

## Shapes

The geometric posture is strictly architectural, restrained, and angular:

- **Corner Radii:** Set to Soft (`roundedness: 1`). Interactive elements (primary buttons, inputs, pill badges) utilize a controlled `0.25rem` (4px) to `0.375rem` (6px) radius, preventing bubble-like softness and preserving technical precision.
- **Cards & Data Modules:** Sharp or subtle 4px borders maximum.
- **Geometric Blocks:** Decorative brand blocks and partner strip segments use zero corner radius (`0px`) to align cleanly with horizontal rules and grid columns.
- **Sprites & Mascots:** Pixelated 8-bit assets rendered with `image-rendering: pixelated` to maintain crisp aliasing.

## Components

### Buttons
- **Primary Action:** Solid white fill (`#FFFFFF`), pure black text (`#0A0A0C`), 4px border radius, font `Space Grotesk` medium 14px. Interactive hover transitions to an amber/cadmium tint (`#FFA000`) or slides an inner chevron.
- **Ghost / Technical:** Jet black surface (`#111113`), 1px outline (`rgba(255, 255, 255, 0.15)`), white text. Contains trailing monospace bracket or pixel arrow glyph (`>`).
- **Telemetry / Link:** Text-only, monospaced uppercase, followed by a hairline underline that expands on hover.

### Inputs & Form Fields
- Surface `#111113`, 1px border `rgba(255, 255, 255, 0.12)`.
- Text color `#FFFFFF`, placeholder `rgba(255, 255, 255, 0.3)`.
- Focus state switches the border to cadmium orange (`#FF5722`) with zero glow or blur.

### Cards & Grid Containers
- Flat container with hairline borders dividing adjacent cards (shared 1px border collapse effect).
- Inner padding: `space-xl` (40px) on desktop, `space-lg` (24px) on mobile.
- Background: `#0A0A0C` default, transitioning to `#111113` on hover with hairline brightening (`rgba(255, 255, 255, 0.25)`).

### Chips & Badges
- Compact capsules with `JetBrains Mono` 11px uppercase.
- Built with a `#18181B` fill, subtle border, accompanied by a small 6x6px colored geometric square or pixel icon.

### Partner & Data Strips
- Edge-to-edge horizontally segmented strip. Each partner logo is locked inside an equal-width cell separated by continuous vertical hairline rules. Logos rendered in solid monochrome white (`#FFFFFF`) at 70% opacity, shifting to 100% on hover.

### Retro Mascots & Pixel Accents
- Deployed sparingly along structural boundaries, sitting atop geometric steps or dangling from header dividers. Always rendered with crisp pixel boundaries to inject warmth into the austere engineering environment.