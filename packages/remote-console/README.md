# @earendil-works/remote-console

hummin's browser remote console: a Vite + React 18 + Tailwind 4 workspace package. The app renders a full console shell (host rail, header island, transcript, composer, approval cards) over one SSE connection per registered host, plus the appearance panel for live theming.

## Commands

- `npm run dev` - vite dev server
- `npm run build` - production build to `dist/` with a relative base
- `npm run test` - vitest with the happy-dom environment

`dist/` is consumed by the coding-agent extension in a later phase, which serves the built bundle over the console's local HTTP endpoint; the relative base keeps it loadable from any host path.

## Token and preset contract

All styleable values are `--rc-*` CSS custom properties defined in `src/tokens.css`; components read tokens and never hardcode colors, radii, spacing, blur, motion, or fonts. Three presets (`glass` the default, `paper`, `terminal`) override the same tokens via `[data-rc-preset]` on the root element, with reduced-motion, reduced-transparency, and no-backdrop-filter fallbacks built in. Two axes, `--rc-accent-hue` (every accent variant derives from it via `hsl()`) and `--rc-density` (multiplies the spacing scale), are the one-knob appearance controls. `[data-rc-motion="off"]` on the root zeroes every duration token and kills animations blanket-style; `auto` leaves motion to `prefers-reduced-motion`.

## Appearance panel and persistence

The panel (`src/components/AppearancePanel.tsx`) is a slide-over overlay (bottom sheet under 900px) opened from the header. It edits `preset`, `accentHue` (0-360, clamped), `density` (0.5-2 on the 0.05 grid, clamped), and `motion` (`auto` | `off`) live: every change applies to the document root (`applyAppearance` in `src/hosts.ts`) and persists to localStorage key `rc.appearance` in the same tick. A live preview strip renders a fake transcript row, a status pill, and a primary button with the current tokens. The overlay closes on Escape, the scrim, or the close button; focus is trapped inside and restored to the opener.

## Shell

- Host rail: one row per host with status glyph, state word (never color alone), session name, and model; the no-hosts state is an onboarding card with the add form inline. Under 900px the rail collapses to a horizontal chip strip and the add form collapses behind its toggle.
- Header: a floating island with run status, model, thinking level, context usage, the preset quick-switch, and the appearance panel opener.
- Transcript: centered reading column, role-styled rows, tool cards, streaming slot, jump-to-latest.
- Composer: pinned bottom surface with a focus-within ring; queue list, delivery mode, send and abort.
- Approval card: warn-edged attention surface with the "approval" label chip (never color alone) and a live countdown.
