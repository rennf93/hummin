# hummin Plan: Parity, Laya Expansion, and Borrowed Patterns

Status: proposal, 2026-09-28. This document is an implementation handoff in the
same genre as `tui-plan.md`: it records the decisions made during design
discussion and should be treated as the intended scope unless implementation
findings require revisiting a decision.

Branch basis: `audit-fixes-2026-09-28`. Everything labeled "current state" was
verified in the worktree on that branch on 2026-09-28.

## 1. Purpose

Three inputs feed this plan:

1. A feature inventory of Anthropic Claude Code (from the leaked, unobfuscated
   v2.1.x TypeScript source at `rennf93/claude-code`; `ultraworkers/claw-code`
   is a third-party reimplementation, used only as corroboration).
2. A feature inventory of OpenAI Codex CLI, `rust-v0.158.0`, cloned 2026-09-28.
3. A design survey of RoboCo (`~/ZZZ/roboco/roboco`, v0.31), the user's own
   26-agent workforce platform, for which hummin is a first-class provider
   (`roboco/llm/providers/hummin.py`).

Conclusion of that comparison, in one sentence: hummin is already at or above
parity on the agent core; the remaining parity gaps are platform layers (hook
breadth, IDE, plugin distribution, CI), and the opportunity that neither
competitor can follow quickly is Laya, the calibrated System-1 judgment layer.

This plan turns that into ordered, sized, testable tracks.

## 2. Current state inventory (verified)

| Area | State | Anchor |
|---|---|---|
| Tools | read, write, edit, bash, powershell, grep, find, ls; no background bash | `packages/coding-agent/src/core/tools/` |
| Web | web_search (DuckDuckGo Lite) + web_fetch (SSRF-guarded), read-only, budgeted | `extensions/hummin-web.ts` |
| Hooks | 4 events: `tool_call`, `tool_result`, `agent_start`, `agent_end`; hooks.json global + trust-gated project; JSON-on-stdin payload; block decisions from tool_call only; 10s default / 60s cap | `extensions/hummin-hooks.ts:10` |
| Notifications | channels off/bell/osc9/desktop/all; when always/unfocused; focus gate; desktop backends (osascript, notify-send); `onNotificationSent` listener bus; settings `terminal.notifications`, `terminal.notificationsWhen`; env `HUMMIN_NOTIFY`, `HUMMIN_NOTIFY_WHEN`; one fire point wired (turn complete) | `src/core/terminal-notifications.ts:19`, `src/modes/interactive/interactive-mode.ts:3778` |
| Laya | laya_decide tool; per-turn destructive steer; bash gate (deterministic ends + laya gray zone, confirm marker, audit); test-failure triage; child dispatch right-size review; /friction calibration with one-press threshold apply | `extensions/hummin-laya.ts`, `extensions/hummin-friction.ts` |
| Shell gate | `gateBackgroundShell` composes bashguard + laya gate for exec/monitor shells; sandbox wrap bridge on globalThis | `extensions/lib/shell-gate.ts:34` |
| Sandbox | seatbelt/bwrap workspace mode, network policy, secrets guard; default off; /sandbox panel | `extensions/hummin-sandbox.ts` |
| Cron | cron_create/list/delete; single-flight detached scheduler; dispatch review holds; detached children with `HUMMIN_MEMORY=0`, `HUMMIN_MEMORY_TOOLS=1` | `extensions/hummin-cron.ts:89` |
| Sessions | fork (`forkFrom`), resume, picker, export html/markdown, share; file checkpoints + /rewind | `src/core/session-manager.ts:1818`, `extensions/hummin-session.ts:61` |
| Queueing | message queue while agent runs | `src/modes/interactive/components/queue-manager.ts` |
| Compaction | compaction + branch summarization | `src/core/compaction/` |
| Skills / commands | skills loader; prompt templates with frontmatter + argument hints | `src/core/skills.ts`, `src/core/prompt-templates.ts` |
| Ask user | ask_user structured selector tool | `extensions/hummin-ask.ts` |
| Memory | vault, distill, fold, inherited lessons for children | `extensions/hummin-memory.ts` |
| Modes | interactive, print, json-event, rpc; SDK | `src/modes/`, `src/core/sdk.ts` |
| Remote | hummin-remote; server + client packages | `extensions/hummin-remote.ts`, `packages/server`, `packages/client` |
| Fleet | multi-server local fleet, per-model context windows, offline catalogs | `extensions/hummin-local.ts`, `extensions/hummin-fleet.ts` |
| MCP / LSP | MCP client extension; LSP diagnostics extension | `extensions/hummin-mcp.ts`, `extensions/hummin-lsp.ts` |

Already at or above parity, no work planned: ask_user, checkpoints and rewind,
session fork, queueing, auto-compact, skills, custom commands, MCP, LSP (CC the
CLI does not have one), plan mode, subagents, team, todos, cron, web tools,
statusline, usage tracking, memory/vault (ahead of both).

Audit items already closed on this branch: exec/monitor shells now pass through
`gateBackgroundShell` (bashguard + laya); cron dispatches pass through
`prepareChildDispatch` with review holds. Remaining audit findings tracked in
T0.

## 3. Cross-cutting invariants (apply to every track)

1. Deterministic-first: classifiers and allowlists own the unambiguous ends of
   any decision space; Laya scores only the gray zone.
2. Fail-open: an unavailable layer degrades to no-op, never to a false block.
   The security boundary is the deterministic layer plus the sandbox; Laya is
   advisory infrastructure, never the wall.
3. Advisory-first promotion: every new automated decision ships as a logged
   advisory that changes nothing, then is promoted to blocking only when its
   /friction calibration shows blocks-versus-confirms separation. Check score
   bimodality before tuning any threshold.
4. Kill switches: every automatic behavior has an env kill switch following the
   `HUMMIN_LAYA_*`, `HUMMIN_CRON`, `HUMMIN_SANDBOX` pattern.
5. Audit as calibration data: every automatic read or block appends one JSONL
   line to `laya-gate.log` (or a sibling log) in a shape `lib/friction.ts` can
   parse.
6. Children: every spawned child gets `HUMMIN_MEMORY=0` in its env. No
   exceptions.
7. Erasable TypeScript only in `packages/*/src` and `packages/*/test`; explicit
   fields with constructor assignments; no inline imports; resolve package
   assets through `src/config.ts` helpers.
8. No backward compatibility shims unless asked. No em dashes anywhere.
9. After code changes: `npm run check`, fix everything. New test files run and
   pass before hand-off. Interactive changes live-verified in tmux.
10. Branch + PR always; never commit to main; stage explicit paths only.
11. Max two parallel child sessions; children run the fast tier.

## 4. Tracks

Estimates: S = a day, M = 2-4 days, L = a week or more. Sizes assume one
session, tests included, docs and changelog per repo rules.

### T0 - Audit closure (S, this branch)

Motivation: the 2026-09-28 fork audit is the reason this branch exists; finish
it before new platform work.

Remaining findings and disposition:

- Fleet auth split-brain: `hummin-local.ts` / `hummin-fleet.ts` resolve the
  shared fleet key from two paths. Decide one resolution order (settings under
  env, same as `resolveThreshold` in hummin-laya.ts:88) and delete the other.
- Auto-fold diverges: fold produces lessons the vault contract does not match.
  Fix belongs with T3.1 (fold gate) but the divergence itself is a correctness
  bug: fix on this branch or its immediate successor.
- README stale: `packages/coding-agent/README.md` was rewritten recently;
  re-verify every command and env var it names against the code (the audit
  found wrong ones).
- Confirm-marker self-service (found 2026-09-28 in the calibration snapshot,
  see T2): 36 of 45 marker confirmations in `laya-gate.log` have no preceding
  block of that command, so the model appends the marker to never-blocked
  commands. Fix: when the marker is present but no block entry exists for the
  exact bare command (within a bounded window, say 24h), run the full gate
  check anyway and audit the line as an anomaly. The 9 legitimate
  command-linked confirmations keep working unchanged.

### T1 - Lifecycle hooks and notification surfacing (M, first)

Status 2026-09-28, implemented across two efforts: commit `af290a739` landed
the channel work (bell/OSC9/desktop, focus condition, ask_user fire point) and
the first hook events (`stop`, `session_end`, `notification`); branch
`m1-hooks-notifications` adds `user_prompt_submit`, `session_start`,
`pre_compact`, the gate-block notification, headless suppression with a
notification event line in `--mode json` (RPC suppresses, protocol-typed
events deferred), and the T0.4 marker fix. tmux passthrough for OSC 9 remains
an open environment item (Section 8).

Motivation: Claude Code has ~25 hook event types; Codex has 12 and allows
command, MCP-tool, and prompt handlers. hummin exposes 4
(`extensions/hummin-hooks.ts:10`). This is the backbone track: notifications,
escalation, and most later tracks dispatch through it.

Current state: hooks.json supports the four events above; the extension API
already has richer internal events (`before_agent_start`, `session_start`,
`session_shutdown`); the notification bus exists (`onNotificationSent`,
terminal-notifications.ts:153) and its doc comment already promises "extension
hooks surface these as `notification` events".

Design:

- Extend `HOOK_EVENTS` to: `tool_call`, `tool_result`, `agent_start`,
  `agent_end`, `user_prompt_submit`, `notification`, `session_start`,
  `session_end`, `pre_compact`. Snake case throughout; existing hooks.json
  files stay valid (additive).
- Payload additions, all additive fields on the existing EventPayload:
  - `user_prompt_submit`: `{ prompt }`. Fired from the same internal event the
    laya steer reads.
  - `notification`: `{ message, channel }`. Fired from the
    `onNotificationSent` bus, so every emission path (core fire points, ask_user,
    extensions) surfaces once.
  - `session_start` / `session_end`: `{}` now; `session_end` fires from
    `session_shutdown`. Session id and file are already in the hook env.
  - `pre_compact`: `{ trigger }` (manual, threshold, or overflow recovery).
    Bridged from the existing `session_before_compact` extension event
    (`src/core/extensions/types.ts:605`), which was verified to exist after
    the plan's first draft. Fire-and-forget: no cancel/customize semantics
    through hooks.json in this track.
- No new handler types yet (command handlers only). MCP-tool and prompt
  handlers are a deliberate non-goal for this track; revisit with T9.
- Matcher semantics unchanged (glob on tool name; events without a tool name
  match only entries with no matcher).
- `/hooks` table gains the new events automatically (it renders entries, not
  the enum).

Notification fire points (the parity surface itself, mostly built already):

- Turn complete: wired (`interactive-mode.ts:3778`).
- ask_user opens: hummin-ask.ts already imports `sendTerminalNotification`;
  wire the call with the question text as the OSC message.
- Gate block: when the laya gate or bashguard blocks a tool call, emit one
  notification (throttled: at most one per 60s per rule) so an unfocused user
  learns the agent is stopped.
- Headless surfaces: `json-event` and `rpc` modes emit a `notification` JSON
  event on the same bus; cron and background-task owners consume it in T4.

Calibration and guardrails: none needed; this track only adds surfaces.

Testing: extend `test/hooks-config.test.ts` for new event parsing and
payloads; a unit test per new fire point (focus gate on/off, channel matrix);
live tmux verification of bell/OSC9/desktop per `.pi/skills/interactive-testing.md`.

Files: `extensions/hummin-hooks.ts`, `src/modes/interactive/interactive-mode.ts`,
`extensions/hummin-ask.ts`, `extensions/hummin-laya.ts` (gate block emission),
`src/modes/json-event.ts`, `docs/features/` (new hooks doc section), changelog.

Size: M. Dependencies: none. Blocks: T4 escalation, T9 consumers.

### T2 - Calibration generalization (M)

Motivation: only the bash gate has a calibration loop today. The audit log
already distinguishes kinds (`steer`, `gate`, `decide`, `triage` at
hummin-laya.ts:204); `/friction` renders a single gate table
(hummin-friction.ts:104). Claude Code and Codex have nothing in this class, so
this is differentiator work, not parity.

Design:

- `lib/friction.ts`: per-kind summaries (count, min/median/max, near-miss band,
  confirmed-with-score) from the existing JSONL. No new logging; kinds already
  flow.
- `/friction` renders one calibration section per kind that has data, plus the
  existing gate section unchanged.
- Threshold suggestions stay single-knob (`layaGateThreshold`) in this track.
  Per-kind settings keys are added only when a second blocking consumer exists
  (T3.2 notification gate is the candidate; its promotion decision is where the
  knob ships).
- Suggested-threshold computation keeps the existing rule (lowest confirmed P
  still blocking); add the bimodality check from the calibration plan: suggest
  only when the score distribution separates, otherwise print "not enough
  separation to suggest".

Guardrails: `/friction` remains read-only except the explicit apply action.

Data snapshot (2026-09-28, four days of `laya-gate.log`, 631 entries; scan
script was throwaway, numbers recorded here):

- Gate: 452 gray-zone reads, median P 0.564, zero reads below 0.236 (the
  deterministic classifiers really are owning the unambiguous ends). 31 reads
  at/above 0.75, all 31 blocked. 9 of those 31 were later confirmed safe, at
  P 0.757-0.876.
- The calibration implication is blunt: confirmed-safe scores (up to 0.876)
  overlap the blocked band (0.755-0.899) completely. No threshold value
  separates false from true positives on the current rubric; the gate's
  control is the confirm step itself, not the score. The lowest-confirmed-P
  suggestion rule will keep answering "stay at 0.75", and the bimodality
  check fails (gate scores are unimodal, humped at 0.50-0.65). Per invariant
  3: no gate threshold tuning; a rubric revision experiment is the only lever
  that could improve separation, and it is optional because the confirm UX
  bounds the cost of the 29 percent scored-block false-positive rate.
- Steer: 79 reads, bimodal (39 below 0.10, 7 at 0.75-0.90), 8 fired at the
  0.7 threshold. Healthy shape, but the log has no ground truth for whether
  the fired notes were warranted; not actionable without logging the
  injection event too.
- Triage: 8 reads (rate-limited by design), 7 below 0.45 advised
  verify-on-HEAD. Working as intended, low volume.
- laya_decide: 1 read in four days. The model-facing tool has near-zero
  organic adoption; the automatic touchpoints carry all the value. T3 items
  should be automatic (as designed), and improving the tool's promptSnippet
  is a T3 afterthought, not a dependency.
- Child dispatch reviews: 20 receipts, 19 accepted, 1 overridden. The
  right-size flow is actively used and low-friction.
- Confirmation volume is the calibration bottleneck: 452 reads produced only
  9 score-linked confirmations in four days. Every future touchpoint's
  log-only phase (T3.2 notifications included) should be planned in weeks,
  not days, unless its dismissal signal is cheaper than the gate's.

Testing: pure-function tests in `test/friction-*` for per-kind summaries and
the bimodality gate.

Files: `extensions/lib/friction.ts`, `extensions/hummin-friction.ts`. Size: M.
Dependencies: none (T3 consumes it).

### T3 - Laya touchpoint expansion (M each, individually shippable)

Motivation: broaden the calibrated judgment layer on the existing chassis.
Every item follows invariant 3: advisory-first, promote on calibration
evidence. Each has its own kill switch and logs kind-tagged reads.

Constraint carried from measurement notes: the english checkpoint has a
512-token context (gate rubric tails truncate; hummin-laya.ts:530 comment), and
the multilingual checkpoint saturates (P 0.87-0.96), so every new rubric must
be short and probed empirically before shipping.

- T3.1 Fold gate (S). Before the memory fold step commits lessons, one noul
  read: P(this lesson contradicts existing vault knowledge or restates an
  existing one). Advisory: a `fold` note in the fold report; the distill
  intake read already exists as the pattern. Directly serves the audit's
  auto-fold finding. Files: `extensions/hummin-memory.ts`, fold worker in
  `extensions/lib/memory-workers.ts`.
- T3.2 Calibrated notifications (S after T1). One noul read per candidate
  notification: P(deserves interrupt). v1: log-only (kind `notify`) with kill
  switch `HUMMIN_LAYA_NOTIFY`; v2 behind the same flag: suppress below
  threshold, only when `notificationsWhen` would fire anyway. Dismissal signal
  for calibration: v1 uses "user returned within N seconds" as a proxy;
  acknowledge this is weak and treat the gate as the last thing to promote.
- T3.3 Child result acceptance (S). At child exit, one read:
  P(result is on-task and complete) from the child's final message. v1: attach
  to the result the parent sees ("laya acceptance: 0.41, inspect before
  merging"). This is the groundwork for the subagent hand-off roadmap item,
  not the hand-off itself.
- T3.4 Effort advisory (S). Extend the child dispatch right-size pattern to
  the main loop: at `before_agent_start`, one read of P(this prompt needs
  full-depth reasoning); when low, append an invisible note suggesting the
  fast tier. Never switches anything automatically in this track.
- T3.5 Web injection advisory (S). In hummin-web, after fetch, one read on the
  stripped text: P(text contains injected instructions aimed at the agent).
  Below-confidence output gets a one-line wrapper note ("treat as untrusted
  data"). Cap: one read per fetch, 4s timeout, fail open.
- T3.6 Fan-out wastefulness gate (S, requested 2026-09-28). LLMs spawn
  swarms/workflows that are often wasteful: several `task` children for work
  one focused pass would do. In `prepareChildDispatch` (the single
  call-site authority), count dispatches per agent turn and, from the second
  dispatch on, make one laya read over the accumulated child prompts
  (bounded excerpt): P(this fan-out duplicates work; fewer or zero children
  would do). v1 is advisory and stays advisory: attach a note to the dispatch
  result ("laya: P(wasteful fan-out)=0.78; consider doing this inline
  instead of spawning more children"). There is no clean ground-truth signal
  for promotion (the parent rarely re-does the work visibly), so this
  touchpoint is expected to remain a permanent advisory, which the chassis
  supports. Kill switch `HUMMIN_LAYA_SWARM=off`; audit kind `swarm`.
  Reuse the turn-scoped counter for a future /friction per-kind row.

Non-goal in this track: an edit/write tool gate. Deterministic path checks
cover the dangerous cases; a per-edit model read taxes every file write for
little marginal safety. Revisit only if the gate log shows a class of misses
the deterministic layer cannot name.

### T4 - Unattended governance (M)

Motivation: RoboCo's governance rule, "every autonomy engine originates ONE
held artifact; the human is the only path to materialization", ported to the
CLI. Also closes the residual trust gap for cron: the scheduler already holds
dispatches behind review receipts, but a due run still writes to the real tree
unattended.

Design:

- Per-entry `hold: boolean` on CronEntry (default from settings
  `cronHoldDefault`, default false; env `HUMMIN_CRON_HOLD=1` forces hold for
  everything).
- A held run executes in a detached git worktree created under
  `getAgentDir()/cron/worktrees/<entry-name>` from the entry cwd's HEAD.
  On exit, the run's diff (`git diff HEAD` plus untracked files list) and a
  result manifest land in `cron/results/<name>/<timestamp>/`:
  `{ exit, durationMs, model, thinking, evidence, diffFile, summary }`.
- Evidence gate (RoboCo's evidence-gated completion): the manifest's
  `evidence` field records the last verification command and its exit code,
  detected by the same `looksLikeTestRun` classifier hummin-laya.ts:485 uses.
  A held result without a passing verification is marked `unevaluated` and
  /cron surfaces it in red. No model judgment decides "done"; the artifact
  does.
- `/cron` panel gains: hold toggle per entry, results list, and
  `apply <name> <timestamp>` which applies the stored diff to the entry cwd
  after a confirm, then prunes the worktree. `discard` removes both.
- Escalation (RoboCo's ack-and-re-escalate, scoped to unattended only): a held
  result older than the first backoff (default 1h, doubling, cap 24h, max 5)
  re-surfaces via a notification emission and a line in the next session's
  start banner. Interactive TUI sessions are exempt: the user is present.
- Background shells (exec, monitor) are already gated through shell-gate.ts;
  this track adds no gate changes.

Guardrails: apply is always a confirm-prompted action; the worktree is created
from HEAD so uncommitted parent state never enters a held run.

Testing: scheduler tests with a temp `HUMMIN_MEMORY_DIR`-style temp agent dir
(never the real vault); worktree lifecycle test on a fixture repo; manifest
shape test; /cron apply happy path in tmux.

Files: `extensions/hummin-cron.ts`, `extensions/lib/cron-store.ts`, new
`extensions/lib/cron-hold.ts`, `docs/features/`. Size: M. Dependencies: none
hard; notifications fire points from T1 make escalation visible.

### T5 - Background bash and the task manager (M)

Motivation: Claude Code has `run_in_background` plus a /tasks manager; Codex
has a persistent unified-exec shell. hummin's bash is one-shot
(`src/core/tools/bash.ts`), and exec/monitor are the current stopgap.

Design:

- `bash` tool gains `background?: boolean`. When true: ProcessManager start
  (same runner hooks use), return `{ job_id }` immediately with a first-chunk
  preview; the shell passes `gateBackgroundShell` and the sandbox wrap exactly
  like exec/monitor do today.
- New tools `task_output(job_id)` (tail + status) and `task_stop(job_id)`.
  Naming note: `task` is the child-dispatch tool's name, so the verb-first
  `task_*` pair is intentionally scoped to shell jobs; if that reads ambiguously
  in practice, rename to `job_output`/`job_stop` before release (open question).
- `/tasks` panel: running and finished jobs of this session, output tail,
  stop, clear. ProcessManager already persists runs under
  `getAgentDir()/hook-runs`-style dirs; reuse.
- Completion emits the T1 notification event with the job's last line.
- Monitor extension: keep, but its spawn path is already shell-gated; fold its
  UX into /tasks in a follow-up rather than deleting anything (no deletions
  without explicit ask).

Testing: tool-level with the faux-provider harness (suite rules: no real
providers); gate ordering test (bashguard then laya, matching shell-gate.ts).

Files: `src/core/tools/bash.ts`, new `src/core/tools/background.ts` or
extension-local equivalent, `extensions/hummin-monitor.ts` (fold-in follow-up).
Size: M. Dependencies: T1 for the completion event.

### T6 - Review suite and findings ledger (M)

Motivation: Claude Code ships /review, /security-review, /pr-comments; Codex
has non-interactive `codex review` with a rubric file. hummin has none, and
review-heavy usage (this branch is literally an audit branch) argues for it.

Design:

- `/review [uncommitted|base|<ref>]` (default uncommitted): drives an agent
  run scoped to the diff, with a rubric prompt file at
  `extensions/lib/review-rubric.md` (mirroring Codex's templates/review
  approach: the rubric is the product).
- Findings ledger: each run writes `getAgentDir()/reviews/<session>/<id>.json`
  entries `{ id, severity: blocker|major|minor, file, line, title, detail,
  status: open|resolved|waived }`. RoboCo's contract applies: a follow-up run
  must cite every open finding id in its response; blocker and major findings
  cannot be waived by the agent, only by the user (`/review waive <id>`).
- `/review show` renders open findings; `/review` with no diff says so.
- `/pr-comments` wraps `gh api` for the current branch's PR and appends
  comments to the ledger as findings.
- No laya involvement in v1 (severity is a rubric judgment, not a gray zone we
  can calibrate with current volumes).

Testing: suite harness with faux provider (no real APIs); ledger lifecycle
test (open, resolve, waive, resubmit contract).

Files: new `extensions/hummin-review.ts`, `extensions/lib/review-rubric.md`.
Size: M. Dependencies: none; natural companion to T7 and the action (T10).

### T7 - Worktree isolation (S)

Motivation: Claude Code has EnterWorktree/ExitWorktree tools; Codex has
/worktree. hummin has none (only incidental string matches). Pairs with
parallel children: each child can own a worktree, which the child-dispatch
briefs already want.

Design:

- `/worktree new <name>`: `git worktree add ../<repo>-wt-<name>` (sibling of
  the repo, matching the layout this user already keeps on disk), then switch
  the session cwd. `/worktree list`, `/worktree remove <name>` (confirm;
  refuses when the session cwd is inside it).
- Children: `cron` entries and child dispatches may pass a worktree name;
  T4's held runs are the first consumer.
- Checkpoints keep working: the store is keyed per cwd (hummin-session.ts:10
  creates one per project), so a worktree gets its own lineage.

Testing: fixture-repo lifecycle test; tmux verification of cwd switching.

Files: new `extensions/hummin-worktree.ts`. Size: S. Dependencies: none.

### T8 - Tool surface control (M, two halves)

Motivation: hummin loads a large fixed tool surface from extensions; Claude
Code and Codex both defer rare tools behind a search tool. RoboCo already
consumes hummin's `--tools` allowlists per role (providers/hummin.py), so the
concept is proven downstream.

- T8.1 Role profiles for children (S): child dispatch review gains an optional
  `tools` allowlist in the dispatch profile; the child is spawned with
  `--tools` per the profile. The fast-tier discipline in AGENTS.md becomes
  expressible as a profile instead of convention.
- T8.2 Deferred tool loading (M): tools above a configurable count collapse to
  a `tool_search` tool that returns full schemas for named tools on demand.
  MCP tool surfaces are the first candidates (they are the unbounded ones).
  Extension tools stay loaded by default; only MCP defers in v1.

Testing: dispatch profile test (T8.1); schema round-trip test (T8.2).

Files: `extensions/lib/child-dispatch-review.ts`, `extensions/hummin-mcp.ts`,
`extensions/lib/mcp-client.ts`. Size: S + M. Dependencies: none.

### T9 - Plugins and marketplace (L)

Motivation: Claude Code has /plugin plus marketplaces; Codex has plugin
add/list with marketplace entries in config.toml. hummin's extension system is
strong but distribution is "copy a file into ~/.hummin/agent/extensions/".

Design:

- Package = directory with `plugin.json`
  `{ name, version, description, extensions: string[], skills: string[],
  prompts: string[], hooks: "hooks.json" }` plus those assets. A plugin is
  valid when every referenced file exists and parses.
- Install target: `getAgentDir()/plugins/<name>/`. `/plugin list`,
  `/plugin add <git-url>` (clone, pin to commit, record in
  `plugins/installed.json`), `/plugin remove <name>`, `/plugin reload`.
- Loading: enabled plugins' extensions load through the existing
  resource-loader path after user extensions; skills and prompts register the
  same way user ones do; hooks.json merges with the user hooks file with
  plugin entries labeled by source (the /hooks table already has a source
  column).
- Trust: plugins load only from the user's agent dir (installed explicitly by
  the user). Project-local plugins are a non-goal; project trust already gates
  project hooks and would gate these the same way if ever added.
- Marketplace v1: a marketplace is any git repo containing an index JSON
  `{ plugins: [{ name, repo, commit, description }] }`;
  `/plugin add <marketplace>#<name>` resolves through it. No signing, no
  semver resolution, no UI browser. Whether the first marketplace is the
  user's own GitHub repo is an open question.

Testing: manifest validation, install/remove lifecycle on temp dirs, load
order test with the faux provider.

Files: new `extensions/hummin-plugins.ts` plus a thin loader in
`src/core/extensions/` if resource-loader needs a plugin hook (prefer
extension-only first). Size: L. Dependencies: none hard; informed by T8.

### T10 - IDE surface (L, spike first)

Motivation: the biggest single user-facing parity gap. Claude Code has /ide,
VS Code-family detection, diff-in-IDE, and a selection bridge; Codex has an
app-server JSON-RPC daemon that its extension talks to.

Raw material already present: `src/modes/rpc` (JSON-RPC session mode),
`packages/server`, `packages/client`, `extensions/hummin-remote.ts`.

Design (spike-first, two steps):

- Step 1, spike (S): document the existing rpc mode protocol as-is (message
  catalog, session lifecycle, tool events), and stand it up as a long-lived
  daemon (`hummin app-server` working title) over stdio plus an optional unix
  socket, with auth identical to hummin-remote's local token. Deliverable is a
  protocol doc in `docs/`, not an extension.
- Step 2 (L, separate repo per the fork policy): a minimal VS Code extension:
  connect to the daemon, open/attach sessions, push the active selection or
  file as an @-context, and render each edit as an IDE diff (vscode.diff)
  with accept/reject feeding back. Notification events from T1 become IDE
  status toasts.
- Non-goals for v0: inline ghost-text completion, notebook support, JetBrains.

Dependencies: none for the spike; the extension depends on the frozen
protocol. Risk: protocol churn; mitigate by versioning the handshake.

### T11 - GitHub Action (S, external repo)

Motivation: Claude Code ships claude-code-action with /install-github-app;
Codex has openai/codex-action. hummin has nothing. For a fork whose owner runs
audit-and-review workflows, this is the natural CI surface.

Design: a separate `hummin-action` repo (the fork policy keeps this repo
thin): a composite action that installs a pinned hummin build, runs
`hummin -p --mode json` with the event payload as env (never argv, the same
anti-injection rule RoboCo applies), and posts output as a PR comment via the
findings ledger from T6. Depends on T6 for the comment format; otherwise
independent.

### Skip list (deliberate, with reasons)

- Voice input (CC, Codex): no terminal-first value for this user.
- Mobile/QR/cloud handoff (CC /session, Codex cloud): hummin-remote plus the
  server/client packages cover the actual need.
- Output styles (CC): system-prompt personas; SYSTEM.example.md plus doctrine
  files cover it.
- Vim mode (CC, Codex): the custom editor is modal enough; revisit only on
  demand.
- /add-dir multi-root (CC): session-cwd switching plus worktrees cover it.
- Microcompact (CC): hummin truncates tool output at execution and compacts on
  pressure; the CC-style tool-result pruning adds a third mechanism for little
  gain.
- Named config profiles (Codex `--profile`): the settings hierarchy
  (global + project, env overrides) covers it; profiles would add a second
  resolution order to document.

## 5. Sequencing

| Milestone | Contents | Why this order |
|---|---|---|
| M0 (now) | T0 audit closure; finish in-flight notifications | branch hygiene before new surface |
| M1 | T1 hooks + fire points | backbone; unblocks T3.2 and T4 escalation; visible value soonest |
| M2 | T2 calibration; T3.1-T3.5 laya touchpoints | differentiator work rides on M1 surfaces |
| M3 | T4 governance; T5 background bash | unattended trust story complete |
| M4 | T6 review suite | own workflow first, then productize |
| M5 | T7 worktrees; T8.1 role profiles | small platform pieces |
| M6 | T8.2 tool search; T9 plugins | distribution |
| M7 | T10 IDE spike then extension; T11 action | largest, partly external |

Each milestone is independently shippable; nothing later rewrites anything
earlier. The two-parallel-children limit applies to implementation sessions
too: M3 and M4 are the natural pairing to run in parallel once M2 lands.

## 6. Risk register

- Hook latency: new events run inline in the agent loop. Mitigation: existing
  10s default / 60s cap, and `notification` / `session_end` events are
  fire-and-forget (decisions ignored, like agent_end today).
- Notification spam: default `unfocused` plus T3.2 log-only gate; throttle
  gate-block notifications per rule.
- Calibration starvation: new touchpoints accumulate decisions slowly; the
  advisory-first rule means slow accumulation is safe, and /friction says
  "not enough separation" instead of guessing.
- Worktree sprawl (T4): held runs create worktrees under the agent dir;
  `apply`/`discard` prune, and /cron warns about results older than the
  escalation cap. A GC sweep rides the existing scheduler pass.
- Plugin trust (T9): user-installed only; plugin code runs with the same
  authority as user extensions, which the /plugin add confirm makes explicit.
- Protocol churn (T10): versioned handshake in the spike; the extension pins
  one minor line.
- Upstream merge friction: everything here lives in `extensions/` (hummin
  overlay) or is additive to core events; any core touch beyond additive
  event emission is called out in the PR description for the merge log.

## 7. Decision log

1. Hook events stay snake_case and additive; no new handler types until
   plugins (T9) exist to consume them.
2. `subagent_start`/`subagent_end` events are not added: child dispatches are
   separate processes, and `matcher: "task"` on `tool_call`/`tool_result`
   covers the in-parent signal.
3. Calibrated notifications ship log-only first; the promotion decision is
   data-driven from /friction, not scheduled.
4. The laya gate stays a tripwire (block threshold ~0.75, lean LOW): no track
   in this plan widens the gate's authority.
5. Escalation semantics apply only to unattended surfaces; interactive TUI is
   exempt by definition.
6. Held cron runs execute in worktrees created from HEAD, never from the
   dirty tree.
7. Background bash reuses ProcessManager and the full existing gate pipeline
   rather than introducing a second spawn path.
8. Findings blockers/majors are not agent-waivable; only the user waives.
9. Plugins install only into the user agent dir in v1; no project-local
   plugins.
10. IDE work is spike-first and the extension lives in a separate repo, per
    the thin-overlay fork policy.
11. The bash gate threshold stays 0.75 and no tuning is scheduled: the
    2026-09-28 snapshot shows the confirmed-safe band overlapping the blocked
    band entirely, so the confirm step, not the score, is the control. The
    only separation lever is a rubric revision experiment, deliberately
    optional (see the T2 data snapshot).
12. `stop` stays alongside `agent_end` as the Claude Code parity name for
    "the main agent finished responding" (landed in `af290a739`); no event
    renames.
13. The T3.6 fan-out wastefulness read is a permanent advisory: "wasteful"
    has no observable ground truth in the log, so there is no promotion path
    and none is planned.

## 8. Open questions

1. `task_output`/`task_stop` vs `job_output`/`job_stop` naming for background
   shells (T5): decide when the panel UX exists.
2. OSC 9 through tmux: resolved empirically on 2026-09-28. The user's
   `~/.tmux.conf` sets no `allow-passthrough`, so tmux suppresses OSC 9 by
   default. T1 verification must cover either adding `allow-passthrough on`
   to the user's conf or emitting OSC 9 DCS-wrapped (`ESC P tmux; ESC <seq>
   ESC \`) when `$TMUX` is set. Decide by testing both in the daily setup.
3. Marketplace hosting (T9): the user's own GitHub repo is the working
   assumption.
4. Priority check before M6: if plugins (T9) land after people start asking
   for shared extensions, swap M5 and M6.

Resolved during the 2026-09-28 review pass (user-confirmed decisions):

- Sequencing confirmed: implement M1 first, M2 next.
- Cron hold default confirmed: off by default, per-entry opt-in plus
  `HUMMIN_CRON_HOLD=1` global force (T4 as written).
- Fold gate placement confirmed: worker-side, one noul read in the fold
  worker next to the distill intake read (T3.1 as written).
- Notification gate posture confirmed: log-only until /friction shows
  separation; no suppression before data (T3.2 as written).
- `pre_compact` is available after all: the core `session_before_compact`
  extension event exists, so it joined the T1 event list.
