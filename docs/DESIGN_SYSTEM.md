# Faultline — Design System

## Direction

An observability control room: calm under pressure, precise, technical, premium. Obsidian surfaces, thin borders, a restrained teal accent. No neon, no generic gradients, no confetti.

## Tokens

All colors, radii, and semantic tones live in `src/design/tokens.css` and are mapped into Tailwind via `@theme inline` in `src/design/index.css`. Components use semantic tokens only.

- Dark is the default. Light is a complete theme, not an inversion.
- Incident states use color, icon, label, and text together.
- Chart colors: teal, sky, amber, violet, rose, lime. Always labeled.
- Radii: 8, 12, 16, 24. Cards use 16px.
- Buttons are at least 44px tall; sliders have 44px touch targets.
- Spacing follows a 4px scale. Page padding is 16px mobile and 24–32px desktop.

## Type

- Inter Variable for prose; JetBrains Mono Variable for metrics, IDs, code, and timestamps.
- Body 15–16px mobile, 16px desktop, line-height 1.6.
- H1 `clamp(1.8rem, 4vw, 2.6rem)`. H2 1.25–1.5rem.
- Prose width capped at 68ch. Numbers use tabular figures.

## Layout

- Mobile: 64px bottom tab bar plus safe-area inset; content reserves bottom padding.
- Desktop: 248px sidebar, top bar with search, interview mode, and theme.
- Module pages: prose left, sticky simulator right at `xl`; single column below.
- Focus mode: full-screen simulation with metrics, controls, and event feed; body scroll locked; clear exit.

## Motion

150–250ms with `cubic-bezier(0.2, 0, 0, 1)`. Simulation animation is continuous and independent. Respect reduced motion by disabling pulses and reducing particles; state changes remain understandable.

## Components

Primitives and simulation kit are implemented under `src/components` and `src/simulation/kit`. Every primitive appears in `/_lab` with all states. Components must work at 360px, support keyboard focus, show a visible ring, use semantic tokens, and expose loading/empty/error states where relevant.

## Incident language

- `ok`: teal/green dot, “Healthy.”
- `warn`: amber ring, “Saturated.”
- `crit`: rose ring, “Failing.”
- `down`: red, hatched, “Unavailable.”

An incident shows a banner with severity, title, cause, and “check this first”; changes the affected node state; marks the threshold on the metric; appends a timestamped event; explains the causal chain; and announces via `aria-live`.
