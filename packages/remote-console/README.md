# @earendil-works/remote-console

hummin's browser remote console: a Vite + React 18 + Tailwind 4 workspace package. This phase is scaffolding only: the app shell (header, transcript, composer regions addressed by `data-rc-region`) and the token system. Transcript rendering and SSE wiring land in later phases.

## Commands

- `npm run dev` - vite dev server
- `npm run build` - production build to `dist/` with a relative base
- `npm run test` - vitest with the happy-dom environment

`dist/` is consumed by the coding-agent extension in a later phase, which serves the built bundle over the console's local HTTP endpoint; the relative base keeps it loadable from any host path.

## Token and preset contract

All styleable values are `--rc-*` CSS custom properties defined in `src/tokens.css`; components read tokens and never hardcode colors, radii, spacing, blur, motion, or fonts. Three presets (`glass` the default, `paper`, `terminal`) override the same tokens via `[data-rc-preset]` on the root element, with reduced-motion, reduced-transparency, and no-backdrop-filter fallbacks built in. Two axes, `--rc-accent-hue` (every accent variant derives from it via `hsl()`) and `--rc-density` (multiplies the spacing scale), are the one-knob appearance controls for the later appearance panel.
