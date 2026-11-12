# Remote console design contract

This is the contract every change to `packages/remote-console` is judged against. It covers direction, the rules, the token reference, the motion spec, the interaction-state matrix, mobile, identity and attention, the primitives API and the performance budget. When the code and this file disagree, one of them is a bug. Fix the code, or amend this file in the same change and say why.

## 1. Direction

A remote control is used away from the desk, often on a phone, often in a hurry. That leads to three rules in order of precedence:

1. **UX first.** Every surface answers "which session is this, what is it doing, and does it need me?" in one glance. No control is decorative, no state is ambiguous, and no destructive action is one accidental tap away.
2. **Quiet by default.** `studio` is warm-neutral with hairlines instead of boxes and motion only on state change. Accent is used sparingly: send, focus, links, the live dot.
3. **Motion explains, never decorates.** Every animation answers where something came from, where it went, or what changed. If it answers none of these, it is removed.

## 2. Rules

- Components read `--rc-*` tokens (`src/tokens.css`) and never hardcode colors, radii, spacing, blur, durations, easings or fonts. `src/tokens-gate.test.ts` enforces this.
- Components never branch on the preset. Presets differ only through token values.
- Status is never color alone. A dot always comes with a word, an icon, or screen-reader text. The normal state (connected, idle) may be silent on screen but is always present for screen readers (`.rc-sr-only`).
- The session is the primary identity everywhere: header, rail row, phone chip and browser tab title. The host label is secondary context.
- Destructive actions (remove host, stop a run, deny) need either a confirmation step or a clear, labelled, comfortably sized control. They are never a bare one-tap icon on touch devices.
- Hover styling sits behind `@media (hover: hover)`, so touch devices never get stuck hover states.
- Faint text is at least 4.5:1 and control edges at least 3:1 in every preset. axe-core reports zero serious or critical violations across 4 presets x 3 viewports.

## 3. Token reference

All tokens live in `src/tokens.css`. The groups:

- **Surfaces:** `--rc-base` (transcript ground), `--rc-surface` (rail, wells), `--rc-raised` (composer, bubbles, cards), `--rc-overlay` (sheets, popovers), plus `-solid` twins for reduced transparency.
- **Foreground:** `--rc-fg`, `--rc-fg-dim`, `--rc-fg-faint`, `--rc-fg-accent-soft`, `--rc-on-primary`.
- **Accent:** derived from `--rc-accent-hue`: `--rc-primary`, `-hover`, `-pressed`, `-muted`, `-faint`.
- **Status:** `--rc-good`, `--rc-warn`, `--rc-bad` and their `-faint` fills.
- **Shape:** `--rc-radius-{sm,md,lg,xl,round}` and concentric `-inner` radii; `--rc-bezel-gap`.
- **Space:** `--rc-space-1..8` (4 to 64 px), `--rc-density` fixed at 1.
- **Layout:** `--rc-rail-width`, `--rc-column`, `--rc-header-height`, `--rc-control-{sm,md}`, `--rc-control-touch` (44 px minimum touch target), `--rc-icon`, `--rc-dot-size`.
- **Type:** `--rc-text-{xs..xl}`, `--rc-leading-*`, `--rc-weight-*`, `--rc-label-transform`, `--rc-label-tracking`, `--rc-font-ui`, `--rc-font-mono`.
- **Depth:** `--rc-shadow-{island,card,pop,raise,thumb}`, `--rc-scrim`, `--rc-blur`, `--rc-blur-overlay`.
- **Component accents:** `--rc-md-*`, `--rc-pill-thumb-*`, `--rc-bubble-*`, `--rc-select-*`, `--rc-slider-*`, `--rc-caret-opacity`, `--rc-ease-pill`. They are neutral in studio and carry the accent and bezel in glass.
- **Motion:** section 4.

## 4. Motion spec

### 4.1 Tokens

| Token | Value | Use |
|---|---|---|
| `--rc-duration-press` | 90 ms | Tactile press feedback (scale on `:active`) |
| `--rc-duration-fast` | 140 ms | Hover, color and border changes, focus rings |
| `--rc-duration-base` | 240 ms | Enter, expand, move (popover, disclosure, indicator, thumb) |
| `--rc-duration-slow` | 380 ms | Large surfaces (sheet, panel), host switch, meters |
| `--rc-duration-exit` | 160 ms | Every exit. Exits are always shorter than enters. |
| `--rc-duration-arrive` | 280 ms | A live transcript entry or card arriving |
| `--rc-duration-blink` / `-shimmer` / `-pulse` / `-spin` | 1.1 s / 1.8 s / 2 s / 0.9 s | Loops: caret, working shimmer, live dot, spinner |
| `--rc-duration-drift` | 72 s | Glass ambient orbs (glass only) |
| `--rc-stagger` | 28 ms | Per-item delay in grouped entrances (rolling digits) |

| Easing | Use |
|---|---|
| `--rc-ease-out` | Enters, hover, color |
| `--rc-ease-in` | Exits |
| `--rc-ease-in-out-soft` | Loops |
| `--rc-ease-spring` (critically damped, no visible overshoot) | Moves and expands |
| `--rc-ease-pop` (soft overshoot) | Small things that appear: send button, jump pill, abort button |
| `--rc-ease-pill` | Segmented thumb travel (spring in studio, overshoot in glass) |

Every duration is a token. A literal ms value outside `tokens.css` fails the gate. A token with no consumer is deleted.

### 4.2 What may animate

- **Composited, always allowed:** `transform`, `opacity`.
- **Paint only, allowed:** `color`, `background-color`, `border-color`, `box-shadow`, `text-decoration-color`, `clip-path`, `filter`.
- **Layout properties: forbidden, with three documented exceptions.** Each exception is cheap because the animated box does not move its siblings.
  1. **Segmented thumb `width`** (`.rc-pill-thumb`). It is absolutely positioned, so its width change relayouts only the thumb. The transform alternatives (`scaleX`, `clip-path`) distort the radius, or clip the glass border, on unequal option widths.
  2. **Rail indicator `height`** (`.rc-rail-indicator`). Absolutely positioned, same reasoning. It must transition with the same duration and easing as its `transform`. Before this pass it snapped.
  3. **Disclosure `grid-template-rows` 0fr to 1fr** (`.rc-disclosure`). An auto-height expand is a deliberate layout change, bounded to one row.

### 4.3 Patterns per surface

| Surface | Enter | Exit | Notes |
|---|---|---|---|
| Button press | `scale(0.97)` press / out | release fast / out | `:active` only |
| Popover (stats) | `rc-pop`: opacity + scale 0.96 to 1 from the trigger, base / pop | opacity + scale, exit / in | `usePresence` holds the node for the exit |
| Sheet or panel (appearance) | translateX (desktop) or translateY (under 900 px), slow / out | exit / in | Scrim fades with the panel |
| Approval card | translateY 8 px + opacity, base / spring | translateY 4 px + opacity, exit / in | Countdown bar: `scaleX` 1 to 0, linear, over the hold lifetime |
| Live transcript entry | `rc-enter`: translateY 6 px + opacity, arrive / out, **once** | none | Snapshot rows never animate. Only entries that arrive while connected do. |
| Streaming text | paced by `useSmoothText` (at least 60 chars/s, backlog cleared within 0.35 s) | n/a | The caret only shows where `--rc-caret-opacity` is 1 |
| Tool row expand | Disclosure (exception 3) + chevron rotate, base / spring | exit / in | |
| Rail active indicator | transform + height, base / spring | n/a | |
| Jump to latest | `rc-pop`, base / pop | exit / in | |
| Rolling numbers | per-digit translateY, slow / out, staggered | n/a | |
| Context meter | `scaleX`, slow / out | n/a | |

### 4.4 Reduced motion

`prefers-reduced-motion: reduce` and `[data-rc-motion="off"]` zero every duration token and apply a blanket kill. With motion off, nothing moves: state changes are instant and `useSmoothText` returns the full text. Loops stop on their first frame, and the information they carried must still be legible as text.

## 5. Interaction-state matrix

Every interactive control defines all of the states below. A missing state is a defect.

| State | Rule |
|---|---|
| Rest | Token colors. Links are underlined at rest. |
| Hover | Inside `@media (hover: hover)` only |
| Active | Press feedback (scale or `--rc-pressed`) |
| Focus-visible | `--rc-focus-ring`, or the global fallback in `index.css` |
| Disabled | `opacity` + `cursor: not-allowed`. The reason is visible (placeholder, title or adjacent text). |
| Busy | For any control that posts (send, stop, approve, deny, add host): `aria-busy="true"`, a spinner replaces the icon without changing the control's size, and it cannot be activated again until the request settles |

## 6. Mobile

- `index.html` viewport: `width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content`.
- Safe areas: the existing composer dock rule (`layout.css`, `max(var(--rc-space-4), env(safe-area-inset-bottom))`) is extended, not duplicated. The topmost chrome takes `env(safe-area-inset-top)`: the host strip under 900 px (the rail stacks above main there), the header at 900 px and wider. The inset is added to that element's height, not just its padding, so the fixed header height stays right. The side gutters respect `env(safe-area-inset-left/right)`.
- Keyboard: `--rc-keyboard-inset = max(0, innerHeight - visualViewport.height - visualViewport.offsetTop)` in px on the root, updated at most once per frame on `visualViewport` resize and scroll. On Android with `interactive-widget=resizes-content`, `innerHeight` shrinks with the keyboard, so the inset computes to 0 and nothing is double-counted. On iOS it lifts the composer above the keyboard. The dock bottom padding becomes `max(var(--rc-space-4), env(safe-area-inset-bottom), var(--rc-keyboard-inset, 0px))`.
- Touch targets: under `@media (pointer: coarse)` every control is at least `--rc-control-touch` (44 px) in both directions. This can be done by growing an invisible hit area (`::before` with negative inset) so the visual size stays the same.
- `touch-action: manipulation` on controls (no double-tap zoom delay). `-webkit-tap-highlight-color: transparent` (the pressed state replaces it). `overscroll-behavior: contain` on the transcript scroller (no pull-to-refresh, no scroll chaining).
- Chrome budget: at 390x844 the top chrome (host strip + header) is at most 112 px tall.

## 7. Identity and attention

- **Session identity.** The session name is the primary label in the header, the rail row and the phone chip. The short session id (first 8 characters, mono, faint) comes next. It copies the full id on click or tap and confirms with "Copied" through a polite live region. The host label is secondary.
- **Fallbacks.** `sessionName` and `sessionId` are `string | null` (`store.ts`). A null name falls back to the host label. A null or empty id renders no `SessionId`.
- **Connection state.** The store's `ConnectionState` (`connection.ts`) is `connecting`, `connected`, `reconnecting`, `unreachable`, `unauthorized` or `closed`. The rail also derives `offline` (closed, or an unknown host) and `stale` (`railStatus` in `HostRail.tsx`). On screen, every state except `connected` shows its word in its status tone, and `unauthorized` keeps its re-enrol hint. `connected` is the colored dot plus `.rc-sr-only` text "connected".
- **Tab title.** `<session name> - hummin` (session name, else host label, else "hummin console"). While approvals are waiting: `(N) Approval - <session name> - hummin`.
- **Favicon.** The hummin mark. A dot overlay in `--rc-warn` while an approval waits, and in `--rc-primary` while the active host's run is working (`status.kind === "working"`).
- **System notification.** Opt-in through a toggle in the appearance panel. The toggle is shown only when `window.isSecureContext` and the Notification API exist. Turning it on requests permission. A new approval while `document.hidden` posts one notification per hold, and clicking it focuses the tab. Holds that are already pending when the first snapshot of a host and session arrives never notify.
- **Approval card placement.** The card floats in an overlay layer anchored to the bottom of the transcript, directly above the composer, aligned to the reading column. It never resizes the composer dock: a growing dock was the dominant layout shift. The transcript reserves the card's height at its end (`--rc-approval-space`), so the newest message stays visible above the card.
- **Following.** Only user input (wheel up, touch drag or fling, PageUp/ArrowUp/Home/Shift+Space, scrollbar drag) turns following off, and the intent lasts for the whole continuous scroll gesture. Content growing or shrinking, for example `content-visibility` rows settling, never does.
- **Installable.** `manifest.webmanifest` (standalone display, studio colors, maskable icon), `apple-touch-icon`, and `theme-color` kept in sync with the active preset's `--rc-base`.

## 8. Primitives (`src/ui/`)

- `Button({variant: primary|secondary|ghost|danger, size: sm|md, icon?, busy?, ...button attrs})`
- `IconButton({icon, label, variant, size, busy?, ...})`. It sets `aria-label` and `title`. `busy` swaps the icon for the spinner, sets `aria-busy`, and swallows clicks.
- `Disclosure({open, children, className?})`. Auto-height expand (exception 3); unmounts after the exit.
- `Icon({name, className?})`. Inline SVG, `aria-hidden`.
- `Shimmer({children, active?, className?})`. The working-label sweep.
- `StatusDot({tone: idle|live|good|warn|bad, activity?: none|pulse|spin, className?})`.
- `SessionId({id})`. Short mono id with copy-to-clipboard and "Copied" feedback.
- `usePresence(open, exitMs?)` returns `{mounted, state}`. Holds a node mounted for `--rc-duration-exit`.
- `useSmoothText(target, streaming)`. Paced reveal of streamed text.
- `motionEnabled()`, `withViewTransition(update)`.

## 9. Performance budget

Measured with the demo harness (`?demo=hummin-mid`, dev build, desktop 1440x900) and the capture and profile scripts recorded in the 2026-11-12 spec addendum.

- **No forced synchronous layout per stream update.** Reads of `scrollHeight` or `getBoundingClientRect` happen at most once per animation frame, inside `requestAnimationFrame` or a `ResizeObserver` callback.
- **CLS below 0.1** at every viewport and preset during the demo turn.
- **No long task above 100 ms after the initial load** in the dev harness. Production React is several times faster than this harness.
- **Snapshot rows use `content-visibility: auto`** with stable keys.
