# Remote control console spec, 2026-11-10

Internal working document, not in mkdocs nav. Companion to the approved
rewritten prompt (improvement-evidence report sections 9-12 pattern). Every
claim about what hummin can do carries file:line verified against main on
2026-11-10. The spec is the contract; implementation PRs are judged against
it, and it is amended (with a dated addendum) when implementation findings
require it.

Locked decisions (user, 2026-11-10):

- Customization: token-driven design + built-in appearance panel, presets
  (glass, paper, terminal), accent, density, motion. Persisted per install.
- Serving: loopback default + optional LAN/Tailnet bind (`HUMMIN_REMOTE_HOST`),
  same token gate. No cloud, no relay.
- Scope: fleet-wide. The browser aggregates multiple hummin endpoints; each
  hummin instance serves the same console and control API. No central relay.

## 1. Current state (grounded)

- `packages/coding-agent/extensions/lib/remote.ts` (185 lines): loopback-only
  HTTP server, random 32-byte token in the URL fragment, timing-safe compare
  (remote.ts:82-88), hardened headers incl. a CSP with `unsafe-inline` for
  script and style (remote.ts:59-62), endpoints GET `/state` plus POST
  `/prompt`, `/abort`, `/approve` with an idempotency map keyed by request id
  and a 256-entry cap (remote.ts:122-157), `maxConnections: 8` and 10s
  timeouts (remote.ts:163-166). Host header and origin checks
  (remote.ts:67-75). This security perimeter is KEPT and extended.
- `packages/coding-agent/extensions/lib/remote-page.ts` (35 lines): the whole
  console is one inline HTML string. Monospace dark page, 1.5s full-refetch
  poll, `replaceChildren` re-render of the entire list on any change
  (remote-page.ts:25), messages rendered as bare `role` + text `<pre>`, no
  markdown, no tool calls, no streaming, no theming, approval banner that is
  visibility-only because `answerable: false` (remote-page.ts:26).
  DISCARDED and rebuilt.
- `packages/coding-agent/extensions/hummin-remote.ts` (113 lines): the
  extension wrapper. State snapshot = branch tail flattened to
  `{role, text}` (last 60, 6k chars each) via `getBranch()` (hummin-remote.ts:74-81),
  streaming awareness only as `partial` from `message_update`
  (hummin-remote.ts:22-25), `waiting` from `ui_prompt_start`
  (hummin-remote.ts:33-38), prompt via `pi.sendUserMessage(..., followUp)`
  (hummin-remote.ts:91-94), abort via `ctx.abort()`. The wrapper is replaced;
  its ideas (setStatus, usage text, stop command) are carried over.
- Upstream deleted its experimental server/client/protocol packages
  (7472cda0d). The fork's `packages/server` and `packages/client` contain
  only untracked `dist/` + `node_modules/` leftovers (git ls-files is empty
  for both). They are NOT a foundation and are ignored.

## 2. Grounded capability inventory

What the extension surface already provides (all in
`packages/coding-agent/src/core/extensions/types.ts` unless noted):

- Streaming: `message_update` carries the partial `AgentMessage` plus the raw
  `AssistantMessageEvent` (types.ts:1104-1108), whose variants include
  `text_delta`, `thinking_delta`, `toolcall_start/delta/end` with
  `contentIndex` (packages/ai/src/types.ts, AssistantMessageEvent union).
  Token-level console rendering is possible with no core changes.
- Tool lifecycle: `tool_execution_start/update/end` with `toolCallId`,
  `toolName`, `args`, `partialResult`, `isError`, `durationMs`
  (types.ts:1117-1148). Tool call blocks on messages are
  `{type:"toolCall", id, name, arguments, argumentsError?}`
  (packages/ai/src/types.ts ToolCall). Stable keys for incremental rendering
  exist end to end.
- Transcript: `sessionManager.getBranch(fromId?)` returns `SessionEntry[]`,
  each with a stable `id` (session-manager.ts:1482, SessionEntry union at
  :183-194 incl. message, compaction, custom_message, usage entries).
  `message_start/end` and `turn_end` carry entry ids (types.ts:1088-1114).
- Run control: `ctx.isIdle()`, `ctx.abort()`, `ctx.signal`, `ctx.model`,
  `ctx.getContextUsage()`, `ctx.hasPendingMessages()` (types.ts:346-388).
  `pi.sendUserMessage(content, {deliverAs: "steer" | "followUp"})`
  (types.ts:1794-1797) and `pi.sendMessage` (types.ts:1784-1787).
- Model + thinking control: `pi.setModel(model)` (auth-checked,
  types.ts:1844), `pi.setThinkingLevel` (types.ts:1853), `ctx.scopedModels`,
  `ctx.thinkingLevel` (types.ts:367-369). A console model/thinking picker is
  possible without core changes.
- Session metadata: `pi.setSessionName/getSessionName` (types.ts:1807-1810).
- Blocking dialogs: EVERY blocking dialog in interactive mode routes through
  the extension UI context, which the runner wraps with ui_prompt tracking
  (runner.ts:577-616): `select`, `confirm`, `input`, `editor`, `custom`. So
  any pending dialog is OBSERVABLE as `{kind, title}` (types.ts:1062-1078).
- Settings: `pi.getSettings()` merged read (types.ts:1825); per-install state
  files under the agent dir are the established pattern
  (`child-dispatch-reviews.json`), and atomic settings writes exist
  (hummin-friction.ts applySuggestedThreshold).
- Kill-switch and audit conventions: `HUMMIN_SYS1_*` env pattern
  (decision-engine.ts sys1Disabled), JSONL audit logs.

Gaps in the surface, with the chosen answers:

1. Dialog payload and resolution. `ui_prompt_start` carries kind and title
   only; there is no programmatic resolve. The current bridge's
   `answerable: false` is grounded in this (hummin-remote.ts:65-71).
   Answer: approvals for TOOL execution move to an extension-owned approval
   surface built on the `tool_call` event, which can block with a reason
   (types.ts:1477-1486) and whose handlers are async - a handler may hold
   (await) while the console resolves, then allow; bounded hold with a
   timeout that hands control back to the terminal dialog (fail-open, same
   shape as the existing gate's HTTP read in hummin-sys1). Non-tool dialogs
   (extension selects) remain terminal-first: the console shows a
   "answering in the terminal" banner, unchanged behavior.
2. Queue contents. Observability is `hasPendingMessages()` only
   (types.ts:379); queued text is not readable. Answer: the console tracks
   its own sent-and-queued items (the extension knows what it sent and the
   delivery mode); terminal-typed queue entries stay invisible (shown as
   "N queued in terminal" via hasPendingMessages, honest about the limit).
   No core changes in this spec.
3. No push channel. Events exist but the extension must serve them. Answer:
   SSE (see section 3).

## 3. Architecture

### 3.1 Transport: SSE with `Last-Event-ID`, POST actions

Server -> client is the high-rate direction (deltas). Client -> server is
low-rate (prompt, abort, approval, settings). Decision: one SSE stream per
host connection carrying a versioned, monotonic-sequence event log; actions
stay POST endpoints. Reasons: SSE runs over plain HTTP with the existing
token header, browsers auto-reconnect with `Last-Event-ID` natively, no
upgrade handshake to harden, and the current CSP/connect-src model extends
unchanged. WebSocket buys nothing here (no client->server stream) and costs
a handshake surface. Rejected alternative recorded: WS + cursor.

Event envelope: `{v: 1, seq: number, ts, type, payload}`; `seq` is per-host,
monotonic, assigned by the extension server. The server keeps a bounded
replay buffer (last N events, N=2000) and resumes from `Last-Event-ID`;
older cursors replay a fresh `snapshot` event instead (the client rebuilds
from the snapshot, never errors). Snapshot events carry the branch tail with
stable entry ids, host identity, model, thinking, status, context usage,
pending-approval state, and console-tracked queue.

Event types (payload sketches):
- `snapshot` (full state, also the reconnect anchor)
- `message_delta` (entry id or streaming slot, AssistantMessageEvent)
- `message_end` (entry id, final message)
- `tool_update` (toolCallId, lifecycle: start|update|end, name, args,
  partial/result, isError, durationMs)
- `status` (idle|working|waiting-in-terminal, model, thinking, ctx usage)
- `approval` (id, toolName, args summary, hold deadline) / `approval_done`
- `queue` (console-tracked items, hasPendingMessages boolean)
- `session` (name, session id)
- `ping` (keepalive, 15s)

### 3.2 Extension-side server

`extensions/lib/remote-console/` replaces `lib/remote.ts` +
`lib/remote-page.ts`. Kept from remote.ts: token generation and fragment
delivery, timing-safe compare, host/origin checks, hardened headers, POST
idempotency, connection caps (raised for SSE long-poll lifetime; per-host
cap 8 stays for actions, streams capped separately, e.g. 4). Changed:

- GET `/` serves the built console (hashed assets from
  `extensions/lib/remote-console/dist/`), CSP WITHOUT `unsafe-inline`:
  script/style hashes or nonces generated per page load; `connect-src 'self'`
  plus the origins the user added to the host registry (needed for
  fleet-wide cross-origin aggregation).
- GET `/events` SSE stream (auth: same bearer token; `Last-Event-ID`
  replay).
- POST `/prompt`, `/abort`, `/approval`, `/settings` (appearance + host
  registry are per-install files under `<agentDir>/remote-console/`:
  `hosts.json`, `appearance.json`; never logged).
- Event source wiring: the extension subscribes to `message_update`,
  `message_end`, `tool_execution_*`, `agent_settled`, `ui_prompt_start/end`,
  `model_select`, `thinking_level_select`, and publishes with sequence
  numbers; backpressure by dropping intermediate deltas of the same slot
  (coalesce, never block the agent loop - events are fire-and-forget writes
  to a bounded per-connection queue; slow consumers are disconnected).
- Config: `HUMMIN_REMOTE_HOST` bind address (default loopback), port option,
  kill switches `HUMMIN_REMOTE=off` (disables the endpoint entirely) and
  `HUMMIN_REMOTE_LAN=off` (forces loopback even when a host is set). Bind
  beyond loopback requires `--remote-lan` style explicitness in settings
  (`remoteControl.allowLan: true`) plus the env var; the notify text states
  the exposure plainly. No tokens or host registry contents in logs
  (friction/audit discipline).
- Fleet mode: each host runs this same server. `hosts.json` on the machine
  you browse from lists peer hosts (label, origin URL, token stored in
  browser localStorage keyed by host label, never in files the server
  serves). The page aggregates one SSE stream per reachable host.

### 3.3 Approvals

- Tool approvals (bash, edit, write, exec, monitor, task, anything routed
  through `tool_call`): extension-owned hold. Design: a registry
  `Map<holdId, {toolName, args summary, resolver}>`; the `tool_call`
  handler enqueues a hold with a deadline (default 120s, setting
  `remoteControl.approvalTimeoutMs`), publishes `approval`, and awaits
  resolution from the console or the deadline. On resolve: continue (empty
  result). On deadline or `HUMMIN_REMOTE=off` or no console ever connected:
  empty result immediately (terminal-first behavior preserved). Interplay
  with existing gates: the remote hold runs AFTER bashguard/sys1 decisions
  (tool_call handlers run in registration order); a gate block short-circuits
  the hold (blocked calls never surface).
- Non-tool dialogs: observe only (kind+title), banner says the terminal
  owns the answer. Honest scope statement in the console.

### 3.4 Console application

- Stack: new workspace package `packages/remote-console` (own package.json,
  deps pinned exact per repo rules, lockfile reviewed), Vite + React 18 +
  Tailwind 4 (the dashboard stack: proven by DESIGN-glass-pass.md; Radix
  only if a primitive earns it, guard-core pattern). Build output committed
  as hashed assets consumed by the extension (build command wired into
  check or a prebuild; decision recorded in the PR). Zero-build vanilla was
  rejected: markdown + virtualization + theme panel need real structure,
  and the dashboard proves the stack stays small.
- Views: host rail (fleet: per-host status dots, latency, session name),
  transcript (markdown, thinking collapsed by default, tool cards with
  args/results/diffs, virtualized via `content-visibility`, follow-bottom
  with 96px threshold + jump-to-latest, per the dashboard scroll rules),
  composer (steer vs follow-up selector, queue list, abort), approval
  cards, header island (model picker, thinking level, context usage, status),
  appearance panel (preset, accent, density, motion; live preview),
  host manager (add/remove, token paste, connection test).
- Renderer: sanitized markdown pipeline (no raw HTML pass-through; sanitizer
  decision at Phase B within the bundle budget; candidates: vendored
  markdown-it + DOMPurify vs hand-rolled safe renderer like the dashboard's
  markdown.jsx - decided by measured bundle size, recorded in the PR).
  Streaming: `text_delta` appends into the block, `toolcall_delta` accumulates
  arguments JSON with a partial-args state, tool cards bind `toolCallId`.
- Theming: one token sheet as CSS custom properties (color, radius, spacing,
  motion, blur layers); presets = token overrides (glass with layered blur
  and `@supports`/`prefers-reduced-transparency` fallbacks per the dashboard
  model; paper; terminal); accent picker constrained to the validated
  palette slots; density and motion as token axes. A `lint:tokens`-style
  gate (guard-core pattern: scripts/check-css-tokens.mjs) keeps components
  from hardcoding values.

## 4. Security model

Threats and mitigations, all verified in Phase E with curl and tests:

1. Markdown XSS: model output is untrusted. Sanitizer with no raw-HTML
   escape hatch; corruption corpus includes markdown bombs; CSP blocks
   inline script anyway.
2. Token handling: token stays in URL fragment, stripped from history
   (current behavior, remote-page.ts:20), held in page memory, sent only as
   Authorization bearer; never in localStorage, never in server logs;
   `history.replaceState` keeps it out of referrers; Referrer-Policy
   no-referrer stays.
3. CSP: no `unsafe-inline`; hashed/nonce'd assets; `frame-ancestors 'none'`,
   `base-uri 'none'`, `form-action 'none'` kept (remote.ts:61).
4. CORS: fleet aggregation needs cross-origin reads. Each host's server
   answers `OPTIONS` with `Access-Control-Allow-Origin` limited to origins
   in that host's registry (console origins), `Vary: Origin`,
   `Access-Control-Allow-Credentials` never used (token is a header), and
   the existing host-header check extended accordingly.
5. LAN bind: loopback default; non-loopback bind requires settings opt-in
   AND env; notify text names the exposure; approval hold deadlines tighten
   (default unchanged); rate limits on actions (existing idempotency map +
   maxConnections stay).
6. Host registry: peer tokens live in the BROWSER (localStorage per origin),
   never served by any host; add/remove requires the bearer token like all
   actions.

## 5. Performance budgets (measured in Phase E, recorded in the PR)

- Time-to-interactive on a 2k-message replayed session: < 1.5s on localhost.
- Steady-state memory with a 10k-message transcript open: < 250MB in the
  browser tab.
- Per-delta render: coalesced to one rAF per slot; no layout thrash
  (measured with the Playwright profiler on the replay harness).
- Reconnect: SSE auto-reconnect + replay of at most the missed events;
  p95 reconnect-to-consistent < 500ms on localhost.
- Bundle: hashed JS gzip < 220KB including markdown pipeline; budget is a
  check script, not a vibe.

## 6. Verification plan (what proves it right, none of it self-asserted)

- Replay harness: server fixture serving recorded events from real session
  JSONLs (mined per the improvement report's stores) plus a corruption
  corpus (markdown bombs, oversized outputs, broken unicode, argumentsError
  tool calls). Playwright over the harness: transcript fidelity, tool card
  states, approval flow, reconnect (kill stream mid-delta, assert replay
  with no loss or a snapshot rebuild).
- Protocol units: seq monotonicity, replay window edges, coalescing,
  backpressure disconnect.
- Visual gate: screenshots per preset, desktop + phone viewports, judged by
  a fresh visual-judge pass against user-acceptance bar.
- Security: curl runs showing headers/CSP/CORS behavior; corpus green;
  grep proving tokens never logged.
- Live: real fleet; phone on Tailnet controlling a session on another host;
  scripted interaction (prompt, tool approval via hold, abort) recorded;
  `/remote-control stop` and kill switches exercised; reconnect by
  suspending the phone client.
- Floor: `npm run check`, `./test.sh` for touched packages, changelog,
  env-var docs, fork overlay policy respected (no upstream deletions; the
  stale untracked `packages/server`|`client` leftovers are left untouched).

## 7. Phases (the approved rewritten prompt, mapped)

- A contract: this spec + protocol constants in code. Gate: user reviews
  this spec.
- B replay harness + renderer (signed off before chrome).
- C shell (transport, host registry, composer, approvals).
- D design pass (design-taste-frontend + high-end-visual-design; token
  sheet; presets; appearance panel; wireframes first).
- E hardening (security, budgets, tokens gate).
- F proof (visual gate, live fleet, PR).

## 8. Open decisions (numbered, decided before the phase that needs them)

1. Markdown pipeline (Phase B): vendored markdown-it + DOMPurify vs
   hand-rolled safe renderer. Decided by bundle budget measurement; recorded.
2. Approval hold default deadline (Phase C): proposal 120s, setting
   override; user may prefer shorter for safety.
3. Host registry UX (Phase C): peers added from the console (paste URL +
   token) vs settings-file only. Proposal: console-first, file fallback.
4. Whether `packages/server`|`client` stale untracked dirs should be deleted
   (user call; fork policy says leave upstream things alone, but these are
   untracked leftovers of a DELETED upstream stack - deleting is safe and
   tidy; asking, not assuming).

## 9. Out of scope

Multiple sessions per host (one live session per host; session switching
stays in the terminal), voice, notifications center beyond existing
terminal notifications, TUI restyling, hummin core changes beyond none
(this spec needs zero core edits), mobile-native app (responsive web only).

## Addendum 2026-11-10 (Phase C refinements, orchestrator-locked)

1. Approval holds are opt-in per tool: settings `remoteControl.approvalTools`
   (comma-separated, DEFAULT EMPTY = zero behavior change) plus
   `remoteControl.approvalTimeoutMs` (120s default). Rationale: hummin has no
   blanket permission prompt to mirror (its gates are deterministic-allow or
   gray-zone-block-with-confirm), so holding every listed tool by default
   would tax terminal-first users for no parity gain. Surfacing gate blocks
   as remote approvals (the deeper integration) stays future work. Section
   3.3's "the hold applies" reads as: applies to the configured tool list.
2. Appearance preferences live browser-side (localStorage per console
   origin). The server-side store under `<agentDir>/remote-console/` holds
   only `console-origins.json` (the CORS allowlist of console origins) plus
   the local host label. Section 3.2's hosts.json/appearance.json split is
   superseded by this: the browser is the host registry (per-host tokens
   included), the server holds only what CORS enforcement needs.
3. Dependency stack note (Phase B): the console pins vite 8.3.4 and
   @vitejs/plugin-react 6.2.1. A vite 6.4.5 pin silently downgraded the
   hoisted vite the whole repo's vitest runs on; the fix restores the
   upstream resolution. The repo .npmrc `min-release-age=2` guard rejects
   versions published in the last 2 days (this blocked plugin-react 6.3.0).
