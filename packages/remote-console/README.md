# @earendil-works/remote-console

hummin's browser remote console: a Vite + React 18 + Tailwind 4 workspace package. The app renders a full console shell (host rail, header island, transcript, composer, approval cards) over one SSE connection per registered host, plus the appearance panel for live theming.

## Commands

- `npm run dev` - vite dev server
- `npm run build` - production build to `dist/` with a relative base
- `npm run test` - vitest with the happy-dom environment

`dist/` is built, committed, and served by the coding-agent extension's console server at `/`. The server resolves the build through four paths, first containing an `index.html` wins: the `HUMMIN_REMOTE_CONSOLE_DIST` env override, the workspace build at `packages/remote-console/dist` (source runs), the copy the coding-agent package ships at `extensions/lib/remote-console/dist` (its `copy-assets` step copies this `dist/` there, so npm installs serve the real console), and `<agentDir>/remote-console/dist`. The relative base keeps the bundle loadable from any host path.

The console server's Content-Security-Policy includes `font-src 'self'` and `manifest-src 'self'` and serves `.woff` and `.webmanifest` files; the bundled Geist fonts and the install manifest depend on them. `public/` (manifest and icons) is copied to the root of `dist/` by vite.

## HTTPS, custom domains and the phone

The server binds loopback by default. To reach it from a phone over HTTPS, put a TLS proxy in front and tell hummin its public origin with `HUMMIN_REMOTE_PUBLIC_URL`; the recommended proxy is Tailscale Serve (recipe in the coding-agent's `docs/environment-variables.md`, Remote console section). HTTPS is what lets the phone install the console to its home screen and receive approval notifications; over plain http both are unavailable.

## Reconnecting after a restart

The console reconnects on its own: the stream is retried with backoff and resumes from the last seen event id. A stalled stream is handled the same way (see Failure handling). A hummin restart (or `/remote-control stop` followed by a fresh start) rotates the token, so the stored one stops working and the stream answers 401: run `/remote-control` again and reopen its URL (this re-enrolls the local host's token), or remove and re-add the host with the fresh token. A rail row in the unauthorized state carries that hint inline.

## Failure handling

- A failed send keeps the draft and shows the reason inline: "Not sent: host unreachable", "Not sent: unauthorized (status 401)", or "Not sent: status N".
- Stop, approve and deny report failures the same way and cannot double-post.
- A stream with no bytes for 45 seconds (three server heartbeats) is aborted and reconnects with `Last-Event-ID`.
- A malformed event is ignored by the store. An error boundary replaces a crashed app with a reload prompt.
- When the stream is down, the header shows the connection state instead of the last run status.

## Token and preset contract

All styleable values are `--rc-*` CSS custom properties defined in `src/tokens.css`; components read tokens and never hardcode colors, radii, spacing, blur, motion, or fonts. Four presets (`studio` the default, `glass`, `paper`, `terminal`) override the same tokens via `[data-rc-preset]` on the root element, with reduced-motion, reduced-transparency, and no-backdrop-filter fallbacks built in. `studio` is a quiet warm-neutral surface with Geist Sans for UI and prose, Geist Mono for code only, no blur, and no ambient scene. The component accent tokens (`--rc-md-*`, `--rc-pill-thumb-*`, `--rc-bubble-*`, `--rc-select-*`, `--rc-slider-*`, `--rc-bezel-gap`, `--rc-caret-opacity`, `--rc-ease-pill`) are neutral in `studio` and carry the accent, blur and a double bezel in `glass`; components never branch on the preset. Paper and terminal neutralise the bezel core tokens and turn the ambient scene off. The appearance controls are the preset, `--rc-accent-hue` (every accent variant derives from it via `hsl()`) and motion. `--rc-density` is no longer a user setting: `src/tokens.css` keeps it fixed at 1 and the spacing scale multiplies by it. The design rules, the primitives API, and the motion spec live in `DESIGN.md`. `[data-rc-motion="off"]` on the root zeroes every duration token and kills animations blanket-style; `auto` leaves motion to `prefers-reduced-motion`.

## Appearance panel and persistence

The panel (`src/components/AppearancePanel.tsx`) is a slide-over overlay (bottom sheet under 900px) opened from the header. It edits `preset` (one of the four presets; new installs start on `studio`, and a preset already saved in localStorage is kept), `accentHue` (0-360, clamped), and `motion` (`auto` | `off`) live: every change applies to the document root (`applyAppearance` in `src/hosts.ts`) and persists to localStorage key `rc.appearance` in the same tick. The saved appearance is `{preset, accentHue, motion}`; a `density` stored by an older build is ignored and the inline `--rc-density` it left on the root is cleared. A live preview strip renders a fake transcript row, a status pill, and a primary button with the current tokens. The overlay closes on Escape, the scrim, or the close button; focus is trapped inside and restored to the opener.

## Shell

- Host rail: one row per host led by the session name (the host label when the session has none) and its status dot, then the host label with the short copyable session id, then the model. The state word appears only when the host is not connected (connecting, reconnecting, unreachable, unauthorized, offline, stale); "connected" is screen-reader text only. A sliding active-row indicator follows the selection. Removing a host asks for confirmation inline. The no-hosts state is an onboarding card with the add form inline; the add-host form sits behind the plus button. Under 900px the rail collapses to a compact horizontal chip strip (dot and session name).
- Host registration: host origins must be absolute http or https URLs and are stored as `url.origin`. A URL fragment is adopted as the token only when it looks like one (32 or more URL-safe characters).
- Header: session name with its short copyable session id, run status (connection state while the stream is down), model, thinking level, context meter, the preset quick-switch, and the appearance button. Header items drop out by container width rather than viewport breakpoints (see Narrow widths); the run status switches to a short label at narrow widths and never truncates. Header metrics carry screen-reader text.
- Attention: the tab title is `<session name> - hummin`, prefixed with `(N) Approval - ` while approvals wait; the favicon carries a dot while an approval waits or a run is working. The appearance panel offers an opt-in system notification for new approvals while the tab is hidden (HTTPS or localhost only; stored in localStorage key `rc.notify`).
- Install: a web app manifest and icons let a phone add the console to its home screen; `theme-color` follows the active preset.
- Transcript: centered reading column. User messages are bubbles, assistant text is plain prose, and system or custom entries are one-line notices. Each completed assistant message ends with a footer line: output tokens, duration, and tokens per second when both are known. Tool calls are one-line rows that expand; a tool result with a matching tool call is shown inside that row rather than as its own row. Streamed text is paced for a steady flow, and the view pins to the bottom on load and while following, with jump-to-latest when it is not.
- Transcript window: on connect the snapshot carries the last 200 message and custom-message entries. The transcript fades out under the composer with a mask instead of an opaque gradient.
- Composer: pinned bottom surface with a focus-within ring; the textarea autosizes. Enter sends, Shift+Enter inserts a newline, and Cmd/Ctrl+Enter also sends. The Stop button (danger, labelled "Stop" when the composer is at least 520 px wide, icon-only below) is shown only while connected and not known to be idle. On phones the composer stays above the on-screen keyboard (`--rc-keyboard-inset` from `visualViewport`) and clears the safe area. The composer is disabled unless the active host is connected, and the reason is shown as its placeholder. Drafts and the delivery mode are kept per host. Queue list, delivery mode, and send remain in the composer.
- Approvals: a new approval is announced through an assertive live region. The card reads "`<tool>` wants to run" under the approval chip, the countdown uses the host clock offset, and long arguments expand with "Show all". The card floats above the composer (it never resizes the composer area) and the transcript keeps room for it at its end; a resolved or expired card plays a short exit. On phones and touch screens Deny and Approve span the card width at touch size.
- Styles: the shell stylesheet is split per surface under `src/styles/` (layout, rail, header, pill, approval, composer, appearance, responsive). `src/shell.css` imports them in that order, and `responsive.css` must stay last.
- Shared primitives live in `src/ui/` (Icon, Button, IconButton, Disclosure, StatusDot, Shimmer, `usePresence`, `useSmoothText`, and the motion helpers). See `DESIGN.md` for the API.

## Accessibility

- The transcript is a `role="log"` region and the streaming row is `aria-busy`. Tabbing into it from above lands on the newest focusable row.
- On touch screens every control has a hit area of at least 44 px (`--rc-control-touch`); hover styles apply only to pointers that can hover.
- Posting controls (send, stop, approve, deny) show a busy state and keep focus while their request is in flight.
- Links are underlined at rest.
- Form controls and checkboxes use `--rc-control-edge`, at least 3:1 against their surroundings.
- Faint text is at least 4.5:1 in every preset.
- The paper preset declares a light color scheme.

## Session stats, fleet and notices

- Header stats: while a message streams, the header shows output tokens per second. The context meter carries an "auto" label when auto-compaction is on. The header also shows session cost and a todo chip (done/total). Totals, cost and diff counts cover every entry of the session file (all branches), like the terminal footer; the todo chip reads the current branch. Totals, cost and diff counts refresh at the end of each turn; tokens per second updates about once a second while streaming. After a reply ends the header keeps the last measured rate visible, dimmed, until the session changes; the session popover's Speed row shows the live value, or "last N tok/s" when idle.
- Session popover: the Session button opens a popover with workspace (cwd with the home directory shown as `~`, repo, branch), model, tokens, cache hit, cost, speed, context, changes (lines added and removed), todos and version. Rows with no data are omitted. The branch refreshes only when the agent settles.
- Narrow widths: the header drops items by container width, in this order: thinking level, preset switch, model, cost, todo chip, context track, tok/s. The preset and thinking level remain in the appearance panel and the session popover.
- Fleet: the rail lists the configured local model servers with engine, host, port, models, whether the session is using one, and a discovery state (fresh, stale or none). The state is when discovery last saw the server in the fleet health file, not a live health probe. The fleet section is read-only: the console never starts, stops or probes a server. The fleet list is omitted entirely when nothing is explicitly configured (no `HUMMIN_INSTANCES`, no `fleet.servers`, no explicit legacy local instances); the built-in default local addresses are never listed on their own.
- Notices: extension messages (hummin-memory-recall, hummin-monitor, hummin-exec, hummin-task) render as typed notices. Custom messages send text only when their `display` flag is truthy, matching the terminal; hidden memory recall notices carry `lessonCount` only. Identical adjacent notices collapse into one row with a repeat count.
- Tool rows: vault shows its search query, todo shows a checklist, monitor shows start, status or stop, and task, task_status and task_cancel have their own rows. Tool partial-result updates are throttled to one per 250 ms per tool call; the last partial always arrives before the tool's end event.
- Activity: compaction and memory fold start, end and failed states show in the header status area. They are not transcript entries. A console that connects mid-compaction receives the activity in progress, or the last failed one, in the snapshot.
  - Compaction publishes start, then end (also for an abort that had a start) or failed. A failure with no start publishes nothing.
  - A memory fold publishes start when its worker is spawned, end when it exits 0 (or is terminated by a signal), and failed for a non-zero exit. A fold held for dispatch review publishes nothing.
  - Every activity detail is capped at 200 characters.

## Known limits

- The workspace branch refreshes only when the agent settles.
- In browsers without CSS trigonometric functions, the paper accent keeps a fixed 33% lightness, which falls below 4.5:1 for yellow-to-cyan hues; current Chrome, Safari and Firefox apply the hue-dependent clamp.

## Demo mode

Dev-only fixture playback for viewing every console state without a live host. Run `npm run dev` and open `/?demo=<fixture>`, for example `/?demo=hummin-mid` or `/?demo=empty`. The fixture is a snapshot from `harness/fixtures`, loaded into a fake host. The page then plays a scripted live turn: thinking, streamed markdown, a tool call that holds for approval, partial and final tool output, and a queued follow-up. Approve and deny resolve the hold. Sending a prompt in the composer replays the turn. Two extra rail hosts show the reconnecting and unauthorized states. The fake host also plays fake session stats, a fake two-server fleet and a compaction activity. `?demo=empty` skips the fixture. The module is gated on `import.meta.env.DEV` and is excluded from production builds.
- Approval card: warn-edged attention surface with the "approval" label chip (never color alone) and a live countdown.
