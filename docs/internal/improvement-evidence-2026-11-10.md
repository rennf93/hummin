# Improvement evidence baseline, 2026-11-10

Internal working document. Not in mkdocs nav, does not ship to the docs site.
Every claim carries provenance: a detector definition, a file:line verified
against main on 2026-11-10, a log count reproducible from the named store, or
an explicit UNSOURCED label. Anything a stranger session cannot re-derive is
marked as such.

Method in one line: no improvement idea is accepted without trace evidence or
verified code facts; ranking is an explicit ordinal table, not a formula.

Confounds stated up front:

- Sessions include spawned children (`-p`, task, cron). 828 of 1736 sessions
  have exactly one user message; child runs dominate Oct and Nov. "Sessions"
  is not "user tasks".
- Telemetry covers 109 files (3686 turns) and began 2026-10-26-era rollout;
  earlier months have no telemetry. Cross-month token/duration comparisons are
  not valid. The baseline is failure-frequency only.
- The LLM-labeling sample (n=25) is drawn from flagged sessions only
  (error-heavy or interactive-heavy). Its proportions describe the flagged
  pool, not the whole population.

## 1. Store inventory (Phase A, verified 2026-11-10)

| Store | Path | Volume | Coverage |
|---|---|---|---|
| Session transcripts | `~/.hummin/agent/sessions/` | 1736 JSONLs, 186MB, 368 project dirs (597 for this repo) | 2026-09-13 to 2026-11-10, versioned v3 |
| Gate audit | `~/.hummin/agent/sys1-gate.log` (2102) + `laya-gate.log` (885) | 2987 entries, JSONL `{ts,type,kind,p,engine}` | continuous 2026-09-24 to 11-10 |
| Friction events | `~/.hummin/agent/friction.log` | 982 events `{ts,kind,source,detail}` | 2026-09-25 to 11-10 |
| Telemetry | `~/.hummin/agent/telemetry/` | 109 files, 3686 turns, per-turn tokens/duration | 2026-10-26 to 11-10 only |
| Post-mortems | `~/.hummin/agent/post-mortems/` | 542 JSONs `{cwd,halted,perTool,totalToolCalls}` | 2026-09-14 to 11-10 |
| Dispatch reviews | `~/.hummin/agent/child-dispatch-reviews.json` | 34 receipts | - |
| Vault | `~/.hummin/agent/vault/` | 3 entities | near-empty; excluded from mining |
| Crashes | `~/.hummin/agent/crashes.json` | 5 entries | - |
| Exec/monitor logs | `~/.hummin/agent/exec/`, `monitors/` | UUID per run | - |

Mining script: throwaway, `/tmp/hummin-mine.mjs`, removed after the report.
Read-only on all stores.

## 2. Detector rules (committed before any count)

Side-log detectors, deterministic, full population:

- S1 provider retry: telemetry `auto_retry_scheduled`, classified by error string.
- S2 gate block: gate-log `type:"block"` (command sanitized).
- S3 gate misfire: `type:"confirmed"` with same sanitized command inside an
  absolute 24h window of a block.
- S4 steer fired: kind `steer` with p >= 0.8.
- S5 friction event: `friction.log` rows by kind/source.
- S6 hung turn: `assistant_turn_completed` with durationMs > 120000.
- S7 compaction: `compaction_completed`.

Session detectors, deterministic, full population:

- D1 tool error loop: >= 3 consecutive `toolResult` records with
  `isError:true` and the same `toolName`, file order.
- D2 mid-task user message: any user message after the first in a session.
  Candidate pool only; interventions are determined by labeling, never counted
  directly.
- D3 aborted: assistant `stopReason:"aborted"`.
- D4 single-prompt session: exactly one user message (population confound marker).

Sampling and labeling:

- Frame: sessions flagged by D1, or >= 5 tool errors, or (>= 3 mid-task
  messages and >= 4 user messages). 313 sessions flagged (33 err_loop,
  39 many_tool_errors, 27 interactive).
- Labeling: 25 mid-task messages drawn deterministically (awk srand(42)) from
  the flagged pool's 214 messages, labeled into six classes by the analyst.
  Classes: I correction/intervention, F failure report, H provider-failure
  handoff, Q question/chat, R normal refinement, X paste artifact.

Redaction rule (applied everywhere below): no tokens, no LAN hostnames,
`/Users/...` truncated to `~`, long identifiers to `[tok]`, excerpts capped at
160 chars.

## 3. Baseline (failure-frequency only)

Per month (sessions = JSONL files; userMsgs excludes the first prompt of each):

| Month | Sessions | User msgs | Tool errors | D1 loop sessions | Aborted | Compacted |
|---|---|---|---|---|---|---|
| 2026-09 | 1101 | 1381 | 789 | 19 | 53 | 8 |
| 2026-10 | 354 | 352 | 279 | 9 | 7 | 0 |
| 2026-11 (to 10th) | 246 | 221 | 437 | 5 | 22 | 3 |

Population totals: 1505 tool errors, 934 mid-task messages, 828
single-prompt sessions, 82 sessions with an abort, 11 sessions with a
compaction record, 28 sessions with at least one hung turn.

Gate log (S2, S3, S4; laya + sys1 combined):

| Month | Reads | Blocks | Confirmed | Anomaly |
|---|---|---|---|---|
| 2026-09 | 724 | 73 | 62 | 20 |
| 2026-10 | 1518 | 57 | 5 | 30 |
| 2026-11 | 466 | 29 | 2 | 11 |

Reads by kind: gate 2340, steer 275, intake 38, triage 26, ask 19, decide 10.
Steer fired (S4): 9. Misfires (S3): 33 total, 26 in Sep, 5 in Oct, 2 in Nov.
The confirm-marker fix (T0.4, landed with PR #12) collapsed block-then-confirm
from 62/month to 2 to 5/month; the anomaly audit line catches self-service
markers (61 entries). Re-block within 60s of a first block: 20 of 159.
Block rule distribution: `rm -rf` rule 46, `git checkout --` 18,
`git restore` 16, `git branch -D` 11, `git reset --hard` 4, `git push --force`
4, others 58, unattributed 58.

Telemetry (S1, S6, S7; Oct 26 onward): 3686 turns, 207 retries of which 173
are Z.AI `429 insufficient balance`, 25 connection errors, 5 terminated,
3 local-server loading, 1 timeout; hung turns 408 (2 in Oct, 406 in Nov = 13.2
percent of Nov turns); 31 compactions; 60 memory lesson injections; 7 vault
searches.

Friction (S5): tool_error 458, loop_detected 240 (Oct 2, Nov 238: the
guardrails loop detector shipped in Nov), advisory/bashguard 204,
circuit_breaker 29, advisory/friction-steer 28, advisory/verify-nudge 24.

Dispatch reviews: 33 accepted, 1 overridden of 34. Post-mortems: 542, 1
halted; per-tool volumes bash 11906, edit 1809, read 1750, write 624, exec
499, todo 414, monitor 184, task 142.

## 4. Labeled sample (n=25, flagged pool only)

I 4 (16%), Q 5 (20%), R 10 (40%), F 3 (12%), H 2 (8%), X 1 (4%). Sanitized
exemplars:

- I: "Why are you using Bash and an sh to watch? Just setup a Monitor with the
  Monitor tool" (wrong-tool correction; background-bash gap, track T5).
- I: "I said test Clef, not laya." (instruction misread).
- I: "6800 , not 4800 nor 6900" (wrong numeric output).
- I: "Exactly what I asked the other session..." (cross-session repeat; a
  context/lesson miss).
- F: "Failures everywhere".
- F: "I'm on the ../guard-core dir. It just doesn't show any local
  provider/LLM" (provider discovery confusion; unauthenticated fleet server
  silently invisible).
- H: "...getting so many Reconnecting and Bad gateway errors that I decided to
  move here" (provider-failure handoff; corroborates S1).
- H: "We were working on something but then we hit a rate limit. Are you able
  to pick up right where we left off?" (same class).

## 5. Failure taxonomy, ranked

Frequency and cost below come from the detectors, not judgment. Cost is the
wasted resource each class produced (measured where possible, estimated and
marked otherwise).

1. Provider quota and rate exhaustion (S1 + H): 173 of 207 retries are Z.AI
   429 quota errors; 2 of 25 labeled messages are session migrations caused by
   provider failure. Cost: retry backoffs plus abandoned sessions. Existing
   mitigation: decision-layer fallbackUrls (PR #22). Remaining gap: the user
   learns about quota death by watching retries, not from hummin.
2. Hung turns (S6): 408 turns over 120s, 13.2 percent of Nov turns, near-zero
   in Oct. Cost: wall clock (measured). Cause uninvestigated: model mix, long
   thinking, or local-fleet prefills. Needs a decomposition before any fix.
3. Tool error loops (D1 + S5): 1505 tool errors, 33 loop sessions; the Nov
   loop detector fired 238 times and the circuit breaker 29. The mechanism
   shipped in Nov; its effect on the loop rate is unmeasured (this baseline is
   the "before").
4. Gate false positives (S2/S3): 33 historical misfires, 20 immediate
   re-blocks, one rule (`rm -rf`) producing 29 percent of blocks. Post-fix
   confirmation collapse (62 to 2 to 5/month) shows the T0.4 fix working. A
   rubric check on the rm -rf rule is worth one hour; no threshold change is
   justified (decision log #11).
5. User interventions (D2 + labels): 16 percent of the flagged mid-task pool
   are corrections. Recurring correction shapes: wrong tool chosen for
   watching long work, misread instructions, wrong numbers, cross-session
   repeats. Population-wide rate is lower than 16 percent (flagged-pool bias).
6. Provider discovery confusion (trace): unauthenticated fleet servers are
   invisible, which reads to the user as "no local provider". Known mechanics
   (auth via auth.json or env keys only); no surfaced state today.
7. Context loss (S7 + trace): 31 compactions, 1 cross-session-repeat exemplar.
   Low volume; watch, do not build for it yet.
8. Child dispatch quality: 33/34 accepted receipts. Right-size flow healthy;
   no exit-time acceptance read exists (T3.3), so off-task child results are
   caught only by the parent reading the report.

## 6. Phase A: differential audit vs upstream

469 fork-only commits confirmed. 5 unsynced upstream commits, none touching
any fork-patched file: d9eff0a70 (contributors bot file), 555e97556 and
57060fb5e (apps/p2 only), ffd3329bb (1-line llama doc), a05e3a077 (Claude Code
version constant in anthropic-messages.ts, which the fork does not patch).
Zero region overlap with fork patches. Content-safe to sync.

Structural finding: fork HEAD deleted apps/p2 (885 files) and
`.pi/skills/p2-ui.md`, while upstream actively develops both. A merge surfaces
dozens of modify/delete conflicts. Decision needed before next sync: re-accept
upstream apps/p2, or resolve theirs/ours deliberately. This is a policy
decision, recorded here for the user.

Fork-patch health: shell-gate.ts, fleet-provider-ids.ts, http-dispatcher.ts
(dispatcher logic now in fork-only src/core/undici-runtime.ts), HUMMIN_MEMORY=0
invariants, tracked provider data: all intact.

Standing risk for future syncs: the fork's largest in-file patches on upstream
files are settings-manager.ts (+697/-10), interactive-mode.ts (+362/-148),
edit-diff.ts (+439/-167). No current unsynced commit touches them.

## 7. Phase A: hummin-plan.md verification (file:line, 2026-11-10)

| Entry | Verdict | Evidence |
|---|---|---|
| T0.1 fleet auth split-brain | FIXED | hummin-local.ts:298-308 sole resolver; hummin-fleet.ts has no key resolution |
| T0.2 auto-fold divergence | FIXED | hummin-memory.ts:734,:1784,:1896-1951; memory-workers.ts:309-320 structural validation + repair pass |
| T0.3 README stale | FIXED (superseded) | packages/coding-agent/README.md is now the upstream README; no hummin claims remain to be stale |
| T0.4 confirm-marker self-service | FIXED | hummin-sys1.ts:605-608,:628-634 (anomaly audit line), :157 |
| Section 2 inventory rows | FIXED (line drift) | anchors exist; forkFrom at session-manager.ts:1834; hooks at hummin-hooks.ts:25 |
| Laya naming | DIVERGED (planned rename, shipped) | hummin-sys1.ts + lib/decision-engine.ts; sys1_decide :706; sys1-gate.log :160,:202; sys1Gate settings :304; decision.* namespace decision-engine.ts:195-226; PR #22 added decision.fallbackUrls |
| T1 hooks + fire points | FIXED | hummin-hooks.ts:25-36 ten events; fire points hummin-terminal-notifications.ts, hummin-ask.ts:327, hummin-sys1.ts:558-565, print-mode.ts:54-61; landed as PR #12 (34d064389); local branch m1-hooks-notifications is a leftover ref |
| T2 per-kind calibration + bimodality | DIVERGED | lib/friction.ts:30-38 FRICTION_KINDS repurposed to session friction; :437-475 has suggestedThreshold + near-miss band, no bimodality check, no "not enough separation" path |
| T3.1 fold gate read | ALIVE | memory-workers.ts:48-66 no sys1 field on fold jobs |
| T3.2 calibrated notifications | ALIVE | no notify kind, no HUMMIN_*_NOTIFY kill switch |
| T3.3 child result acceptance | ALIVE | child-dispatch-review.ts holds pre-spawn dispatches only |
| T3.4 effort advisory | ALIVE | hummin-sys1.ts:836 before_agent_start is steer only |
| T3.5 web injection advisory | ALIVE | hummin-web.ts zero sys1 hits |
| T3.6 fan-out gate | ALIVE | no swarm kind, no per-turn dispatch counter |
| T4 cron hold/worktrees/manifests | ALIVE | no cron-hold.ts; hummin-cron.ts:217 results go to session history |
| T5 background bash + /tasks | ALIVE | bash.ts no background flag; no task_output/task_stop; no /tasks panel |
| T6 review suite | ALIVE | no hummin-review.ts, no rubric file |
| T7 worktree isolation | ALIVE | no hummin-worktree.ts |
| T8.1 dispatch tools allowlist | ALIVE | ChildDispatchOptions has no tools field |
| T8.2 tool_search deferred MCP | FIXED | landed via upstream: src/core/mcp-servers.ts:56, agent-session.ts:1646-1652 |
| T9 plugins | ALIVE | no hummin-plugins.ts |
| T10 app-server protocol doc | ALIVE | no app-server artifact |
| T11 hummin-action repo | ALIVE | gh: repo does not exist |
| Invariant HUMMIN_MEMORY=0 on children | FIXED | processes.ts:317 (subagents :685, monitor :116, hooks :208); hummin-memory.ts 4 sites; hummin-cron.ts:130-133; hummin-sandbox.ts 3 sites; hummin-project.ts:189; lsp-client.ts:244 |
| Invariant kind-tagged JSONL | FIXED | hummin-sys1.ts:199 auditRead, :77 format |
| Invariant getShellConfig for hooks | FIXED | hummin-hooks.ts:7,:228 |

The floor of known-unfixed audit defects is empty. The 2026-09-28 "nothing
fixed yet" belief was wrong: PR #11 (merged 2026-09-28) closed the audit.

## 8. Survey reconstruction (sourced vs unsourced)

- 2026-09-26 roadmap: "subagent hand-off" SOURCED (hummin-plan.md:279, as T3.3
  groundwork). "Inherited child context" UNSOURCED (the shipped "inherited
  lessons for children" at hummin-plan.md:47 is a different feature).
  "Retrieval quality" UNSOURCED.
- 2026-09-28 parity gaps: 8 of 9 map to committed tracks: hook events T1
  (:119), IDE T10 (:494), plugins T9 (:459), GH Action T11 (:520), background
  bash T5 (:356), worktree T7 (:416), review suite T6 (:387), tool_search T8.2
  (:447). "Sandbox bypasses" UNSOURCED and moot: exec/monitor/cron gating
  shipped in PR #11 (shell-gate.ts:34).

## 9. Backlog with explicit scales

Scales: Evidence E3 reproducible on demand > E2 real-usage trace excerpt >
E1 static code fact. Frequency = detector count (population-true). Cost S/M/L
by files and tests. Axis: quality, performance, safety, platform.

| # | Item | Axis | Evidence | Frequency | Cost |
|---|---|---|---|---|---|
| 1 | T2 per-kind calibration summaries + bimodality + "not enough separation" | quality | E1 + 2615 reads of logged data waiting | 2340 gate + 275 steer reads | S-M |
| 2 | T3.3 child result acceptance read | quality | E1 | 142 task calls; children dominate Oct-Nov | S |
| 3 | T5 background bash + task_output/task_stop + /tasks | quality+platform | E2 ("Just setup a Monitor...") + E1 | watching corrections; 28 hung sessions; exec/monitor dirs in daily use | M |

Phase D re-scope note for row 3: verification found the T5 capability
largely shipped after the plan was drafted - exec is one-shot background
shell with gated spawn and completion delivery, monitor is the watch, and the
/background panel is the tasks manager. The remaining gaps were the missing
programmatic poll and stop for exec jobs, implemented as job_output/job_stop
(the plan's own naming fallback for open question #1, resolved to job_* to
avoid the task_* collision). The core bash.ts background flag was deliberately
NOT built: it would be a second spawn path next to exec, which the plan's
decision log #7 rules out.
| 4 | Provider quota surfacing (429 quota death visible in UI, not only retries) | performance | E2 (2 handoff traces) | 173 | S-M |
| 5 | Fleet provider state surfacing (unauthenticated/unreachable server visible) | quality | E2 (1 trace, recurring per machine) | 1+ trace, known recurring | S |
| 6 | T3.1 fold gate read | quality | E1 | vault has 3 entities | S |
| 7 | T3.4 effort advisory | performance | E1 | none (advisory would gather it) | S |
| 8 | T3.5 web injection advisory | safety | E1 | none | S |
| 9 | T3.6 fan-out gate | cost | E1 | none | S |
| 10 | T3.2 calibrated notifications | quality | E1 | none | S |
| 11 | T4 cron hold governance | safety | E1 | cron runs unmined | M |
| 12 | T6 review suite + ledger | quality | E1 | none | M |
| 13 | T7 worktree isolation | platform | E1 | none | S |
| 14 | T8.1 dispatch tools allowlist | cost | E1 | children dominate | S |
| 15 | apps/p2 sync policy decision | platform | E1 | 2 upstream commits blocked | decision |
| 16 | Delete stale m1-hooks-notifications branch ref | hygiene | E1 | 1 | trivial |

Justifications for the rank order (one line each):

1. T2 is the promotion gate for the whole advisory-first chassis (invariant 3
   says promote only on calibration separation; without per-kind summaries and
   the bimodality check nothing can ever promote). Cheapest differentiator
   lever; the data is already flowing.
2. T3.3 is the groundwork for the roadmap's one sourced item (subagent
   hand-off) and addresses the workload's dominant shape (children) with an S
   cost.
3. T5 carries the strongest user-correction trace in the sample, is the top
   parity gap (background bash), and is the natural home for the 28
   hung-turn sessions and watching-class corrections. Largest cost of the
   three, hence third.
4-5. The two surfacing items are small, evidence-backed UX fixes on the perf
   and quality axes; they follow the top three.
6-14. As planned in hummin-plan.md T3/T4/T6/T7/T8; unchanged evidence base,
   S costs, ordered by axis coverage. T3.1 stays low because the vault it
   guards is near-empty.
15-16. Decisions and hygiene, not slices.

## 10. Phase D plan (this session)

Implement slices 1 to 3 as one branch + PR, in that order, each complete
(check + tests + changelog) before the next starts:

- Slice 1 = backlog #1 (T2): per-kind sys1 calibration summaries in
  lib/friction.ts, bimodality check, "not enough separation" path, /friction
  per-kind sections. Tests in test/friction-*.
- Slice 2 = backlog #2 (T3.3): exit-time sys1 read on child results, advisory
  note attached to the parent-visible report, kind-tagged audit line, kill
  switch.
- Slice 3 = backlog #3 (T5): bash background flag through gateBackgroundShell,
  task_output/task_stop tools, /tasks panel. Touches src/core/tools/bash.ts
  (upstream file, additive): called out in the PR body per the plan's merge
  policy.

Acceptance: npm run check clean; new tests pass; live tmux verification for
/friction and /tasks; forward instrument counts defined now and read after two
weeks of use (gate per-kind confirmation counts, friction event deltas).
packages/evals exists (vitest-evals, needs PI_PROVIDER/PI_MODEL); running its
smoke suite against one fixed model is the eval delta if quota allows, else the
forward instrument counts are the acceptance metric and that is stated plainly
in the PR.

## 11. Unsourced register

Entries that exist only in memory digests, carried in this report as
hypotheses, never as facts: "inherited child context" and "retrieval quality"
roadmap items; "sandbox bypasses" parity item (moot, see section 8). The
"2026-09-26 roadmap" and the fork-audit full text exist nowhere on disk; their
dispositions above are reconstructed from hummin-plan.md, the PR #11 body, and
the lessons file.

## 12. Phase D outcome (2026-11-10, branch improvement-slices-2026-11-10)

Implemented in ranked order, one PR:

- Slice 1 = backlog #1 (T2): summarizeSys1Calibration gained the separation
  gate (confirmedMax, blockMin, separation: separated | overlap | unknown);
  suggestions only render and apply when the bands separate, otherwise the
  report says "not enough separation to suggest". New summarizeSys1Kinds gives
  every logged read kind (steer, gate, decide, triage, intake, ask) its own
  score stats and near-miss band against that kind's threshold, and /friction
  renders one section per kind. Tests: hummin-friction.test.ts (42).
- Slice 2 = backlog #2 (T3.3): lib/child-acceptance.ts, one sys1 noul read at
  child exit (P on-task and complete, bounded report tail), advisory note
  attached to the result the parent sees (foreground return and background
  delivery), kind "accept" audit lines, kill switch HUMMIN_SYS1_ACCEPT=off,
  fail-open everywhere. Tests: hummin-child-acceptance.test.ts (6).
- Slice 3 = backlog #3 (T5, re-scoped as noted above): job_output and
  job_stop tools (new extensions/hummin-shell-jobs.ts) over exec/monitor
  jobs; describeJobStatus and jobTail hoisted into lib/processes.ts and reused
  by hummin-subagents. Tests: hummin-shell-jobs.test.ts (7).

Not implemented, with reasons: the core bash background flag (second spawn
path, decision log #7), T3.1-T3.6 remaining touchpoints, T4, T6-T11 (S/M/L
slices beyond the approved top 3). The eval-delta acceptance via
packages/evals needs PI_PROVIDER/PI_MODEL runs; the forward instrument counts
(friction event deltas, gate per-kind confirmation counts, sys1-gate.log kind
"accept" reads) are defined now and read after two weeks of real use.
