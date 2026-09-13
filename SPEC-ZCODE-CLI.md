# SPEC: zcode-cli (GLM-native terminal coding agent, on pi)

**Date:** 2026-09-13
**Status:** Draft for review, pre-M0
**Base:** rennf93/pi (fork of badlogic/pi-mono, earendil-works), MIT, npm workspaces, Node >= 22.19, TypeScript (tsgo), biome, vitest
**Companion docs:** NAS repo `LLM/COLIBRI-GLM-5.3-FLASH-SETUP.md` (local inference backend)

---

## 0. Summary

zcode-cli is a terminal-native coding agent for the GLM ecosystem: a rebranded, GLM-tuned distribution of pi. It gives the Z.ai community what Z.ai itself does not ship: a CLI you can run in one terminal pane next to your shell. It talks to (a) Z.ai cloud (coding plan + API endpoints), and (b) local colibri instances on the LAN, with queue-aware behavior for colibri's one-generation-at-a-time model.

The exploration finding that defines this spec: **pi already ships a `zai` provider** (`packages/ai/src/providers/zai.ts`, baseUrl `https://api.z.ai/api/coding/paas/v4`, OpenAI-completions API with `thinkingFormat: "zai"` reasoning wired into `packages/ai/src/api/openai-completions.ts`), supports **Anthropic-compatible custom baseUrls** (`api: "anthropic-messages"` + `baseUrl` in `~/.pi/agent/models.json`), and has **official rebranding support** via `piConfig` in `packages/coding-agent/package.json`. The build is therefore mostly catalog work, a colibri extension, and branding - not a new agent.

## 1. Naming and branding

- Binary name: `zcode` (working title). Config dir: `~/.zcode/agent/` (derived from `piConfig`). Rename is officially supported: `packages/coding-agent/package.json` -> `"piConfig": { "name": "zcode", "configDir": ".zcode" }`, `"bin": { "zcode": "dist/bundle/cli.js" }`. Env vars (`PI_CODING_AGENT_DIR` -> `ZCODE_CODING_AGENT_DIR` etc.) follow automatically per `src/config.ts`.
- Open question (flag for Z.ai outreach): "ZCode" is Z.ai's desktop app. Options: (a) keep zcode-cli and open a discussion with Z.ai, (b) use `zai-cli`, (c) `glm-cli`. Decision needed before M3 (public release), not before coding.
- v1 keeps the internal npm scope `@earendil-works/*` untouched (~30 files); a full scope rename to `@rennf93/*` is a mechanical but broad sweep, deferred to M4.

## 2. Goals / non-goals

**Goals (v1)**
- First-class GLM model catalog: GLM-5.3 and GLM-5.3-Flash with reasoning variants and correct limits (1M context, 128k output), on both Z.ai endpoints.
- Local colibri provider: multiple instances, health-checked, queue-aware, zero-config discovery from `models.json` or settings.
- `zcode` binary rebrand with clean `~/.zcode/agent` config root, sessions, themes, extensions.
- GLM-tuned defaults: SYSTEM.md preset, dark theme, sane settings.json.
- Two-pane-friendly terminal workflow (see section 8 for the honest v1 scope).
- OSS-ready: MIT (inherited), README, docs, GitHub releases with standalone binaries.

**Non-goals (v1)**
- MCP support (pi does not have it; extensions cover the need).
- Embedded terminal / true split panes (out of scope even in pi's own `tui-plan.md`).
- IDE extensions, telemetry dashboards, agent swarms (RoboCo territory).
- Windows-first anything (macOS + Linux first).

## 3. What pi already gives us (do not rebuild)

- Providers: registry in `packages/ai/src/models.ts` (`createProvider`, `MutableModels`), built-ins in `packages/ai/src/providers/all.ts`; user providers via `~/.pi/agent/models.json` (schema in `packages/coding-agent/docs/models.md`), including `api: "anthropic-messages"` with custom `baseUrl` and anthropic `compat` flags.
- GLM reasoning: `compat.thinkingFormat: "zai"` already sends `thinking: {type: enabled|disabled}` + `reasoning_effort`; thinking levels `minimal|low|medium|high|xhigh|max` with `thinkingLevelMap` per model.
- Retry/429: `packages/ai/src/utils/provider-retry.ts` honors `retry-after` and retries 408/409/429/5xx with backoff - the right primitive for colibri queueing.
- Extension API: `pi.registerProvider`, `pi.registerTool`, `pi.registerCommand`, ~30 lifecycle events, `ctx.ui` widgets; auto-discovery from `~/.zcode/agent/extensions/` with `/reload` hot reload. Examples: `packages/coding-agent/examples/extensions/custom-provider-anthropic/`.
- Sessions: JSONL tree (v3) with branching, `--continue/--resume/--fork`; oneshot `zcode -p "prompt"`; JSON and RPC modes.
- Tools: read, bash, edit, write, grep, find, ls; project trust gating; AGENTS.md context files already supported.
- Catalog generator: `packages/ai/scripts/generate-models.ts` pulls from models.dev - GLM-5.3 entries may already exist there; check before hand-authoring.

## 4. Workstream A: Z.ai first-class (M1)

1. **Catalog**: ensure GLM-5.3 and GLM-5.3-Flash exist in `packages/ai/src/providers/data/zai*.json` with `thinkingLevelMap` (map pi levels to Z.ai `reasoning_effort`), `contextWindow: 1000000`, `maxTokens: 128000`, costs from Z.ai pricing. Prefer regenerating via `npm run generate-models` if models.dev already carries them; otherwise hand-author the JSON and document why.
2. **Anthropic-endpoint variant**: add a `zai-anthropic` provider entry (or models with `api: "anthropic-messages"`, baseUrl `https://api.z.ai/api/anthropic`) for users who want the Claude-Code-compatible route, incl. coding-plan baseUrls. Verify which endpoint(s) the user's plan actually supports before shipping defaults.
3. **Auth**: `ZAI_API_KEY` env var path already exists; add `zcode auth login zai` flow polish (stored credential in `~/.zcode/agent/auth.json`).
4. **Acceptance**: real streaming session against Z.ai cloud on GLM-5.3-Flash with reasoning on, tool calls working, 1M-ctx-sized prompt accepted.

## 5. Workstream B: colibri provider (M2)

Two layers:

1. **Config-only quick start** (document in README): `models.json` provider entries for each LAN instance, e.g. `colibri-flash` (`api: "openai-completions"`, baseUrl `http://colibri.lan:9998/v1`, model id from `GET /v1/models`, `contextWindow: 16384`, `input: ["text"]`) and `colibri-53` (:9997), plus optional `anthropic-messages` variants.
2. **The `zcode-colibri` extension** (the real feature, `~/.zcode/agent/extensions/` or bundled):
   - `pi.registerProvider` factory wrapping `openAICompletionsApi()` with a **request mutex** (one in-flight generation per instance) and 429 handling that surfaces `x-colibri-queue-wait-ms` as user-visible queue position instead of raw retries (reuse `provider-retry.ts` semantics for backoff).
   - **Instance pool**: config listing instances (e.g. `ZCODE_COLIBRI_INSTANCES` env or models.json provider `colibri` with `baseUrl` list); `/health` probe before selection; pick free instance, else report queue wait.
   - **Model sync**: fetch `/v1/models` at startup, upsert into the provider's model list (so container/model changes need no config edit).
   - Status widget via `ctx.ui` showing active instance + queue state.
- **Acceptance**: two terminal sessions against two colibri instances on the NAS both stream without interleaved requests; a third session sees a readable "waiting for instance" state rather than an error.

## 6. Workstream C: branding and packaging (M3)

- `piConfig` rebrand (name `zcode`, configDir `.zcode`, bin `zcode`), README rewrite, repo metadata, keep `@earendil-works/*` internal scope.
- **GLM-first curation (no deletions)**: onboarding and the `/model` picker surface zai and colibri presets first; other built-in providers are hidden behind a flag (e.g. `providers.showAll`, default off) rather than removed. Curation lives at the UX layer; the provider layer stays upstream-pristine.
- Sweeps needed beyond piConfig (from `packages/coding-agent/docs/development.md`): repo URLs, theme schema URL, share viewer URL, `PI_*` env names we expose in docs.
- Packaging: `npm i -g` from GitHub; standalone binaries via existing `build:binary` (bun compile) published on GitHub Releases; brew tap later.
- License: keep MIT + prominent attribution to Mario Zechner / earendil-works upstream.

## 7. Workstream D: GLM-tuned defaults (M3)

- `SYSTEM.md` preset tuned for GLM 5.3 (concise, tool-forward; pi lets a global `~/.zcode/agent/SYSTEM.md` fully replace the prompt - we ship a recommended one but do not force it).
- `zcode` dark theme JSON; default `settings.json` (thinking level default `high`, tuiMode `regular`).
- Docs: models.md and extensions.md already exist upstream; add a Z.ai + colibri quickstart.

## 8. UX: the two-pane question (honest v1 scope)

pi's TUI today is a single-pane vertical document (regular) or fullscreen alternate-screen mode; embedded terminal and split panes are explicitly out of scope even in upstream's own `tui-plan.md` (which plans VStack/HStack primitives for a future date). Therefore:

- v1: `zcode` in one pane + shell in the other pane of a tmux/terminal split; shell escape inside the TUI (`!` command) and `zcode -p` oneshot mode cover most "run a command" needs. Document the recommended tmux layout in the README.
- M5 (optional, post-v1): implement HStack in the TUI per upstream `tui-plan.md` and evaluate a real split layout. Do not block v1 on this.

### UX design language

Define the design language once with design-taste/brandkit skills (palette, tone, state hierarchy: streaming vs waiting vs parked vs budget-warning), then encode it manually into the theme JSONs and a `DESIGN.md` with component rules. The web-oriented taste skills inform language and hierarchy only; terminal constraints (monospace alignment, 256-color fallback, information density) are applied at translation time. TUI framework changes (split panes) stay M5 per upstream tui-plan.md.

## 9. Milestones

| M | Scope | Effort | Acceptance |
|---|---|---|---|
| M0 | Branch `zcode`, `piConfig` rebrand, build green (`npm install && npm run build`), `./pi-test.sh` runs, `zcode` binary boots | half day | `zcode --help` works, sessions land in `~/.zcode/agent/sessions/` |
| M1 | Workstream A | 1-2 days | Streaming GLM session on Z.ai cloud with tools + reasoning |
| M2 | Workstream B | 2-3 days | Multi-instance colibri demo from section 5 acceptance |
| M2.5 | Guardrails + memory (section 13; RoboCo + obsidian-vexa-bridge inspired) | 2-4 sessions | Section 13.5 acceptance |
| M3 | Workstreams C + D | 1-2 days | OSS-ready repo, binaries, docs, theme |
| M4 | Polish + release | ongoing | npm/GitHub release, community post, upstream PR(s) if wanted |
| M5 | Optional split-pane TUI | future | per upstream tui-plan.md |

Order note: M1 can start against Z.ai cloud immediately (no dependency on the colibri downloads finishing); M2 needs the NAS models live.

## 10. Testing

- `npm run check` (biome + consistency scripts + tsgo) and `npm test` (vitest) must stay green; TUI package uses `node --test`.
- New unit tests: colibri mutex + 429 queue mapping (mock fetch), model catalog shape, models.json parsing of colibri entries.
- Manual matrix: cloud GLM-5.3 / GLM-5.3-Flash x local colibri Flash / 5.3, streaming + tool calls + 1M-context prompt + queue behavior with two parallel sessions.
- Optional: upstream runs terminal-bench; rerun after changes to catch regressions.

## 11. Risks and open questions

- **Fork policy (decided 2026-09-13): thin overlay, zero deletions.** Do not remove upstream providers or features. All customization happens via model catalog data, the colibri extension, `piConfig`/branding, docs, and UX curation (section 6). Rationale: upstream moves fast and merge cost is the main long-term risk; the other providers are data-only with no real cost; and colibri itself is built on the provider machinery. If bundle size ever genuinely matters, the acceptable trim is skipping other providers' catalog *generation* at build time, never deleting provider code.
- **Upstream velocity**: pi moves fast (packages at 0.85.1 within months of creation). Rebase strategy: keep changes concentrated in catalog JSON, one extension, piConfig, docs; avoid touching `packages/ai` internals where possible so upstream merges stay cheap.
- **Trademark**: decide zcode-cli vs zai-cli vs glm-cli before public release; consider a heads-up to Z.ai (they lack a CLI; an OSS one with their provider presets is plausibly welcome).
- **Coding-plan auth**: if the user's plan needs OAuth rather than API key, M1 grows an OAuth flow (pi has PKCE infrastructure in `packages/ai/src/auth/oauth/`). Verify with a real key first.
- **models.dev dependency**: `generate-models` needs network; use `build:offline` in CI.
- **colibri single-generation UX**: the mutex makes waits explicit; if it feels bad in practice, the mitigation is more NAS instances (planned), not silent parallelism.

## 12. Immediate next steps (M0 + M1 kickoff)

Status: M0 and M1 are done (branch `zcode`, rebrand, build green, `zcode` binary linked; catalog verified complete upstream). Local clone moved to `/Users/renzof/Documents/GitHub/ZZZ/zcode-cli`. The original kickoff steps are recorded in git history.

## 13. M2.5: Guardrails and memory (post-M2)

Decided 2026-09-13 (Renn): implement RoboCo-inspired hardening and obsidian-vexa-bridge-inspired knowledge capture **together** as one milestone, after M2-proper. Design distilled from full explorations of `~/Documents/GitHub/ZZZ/roboco-master/roboco` and `~/Documents/GitHub/ZZZ/obsidian-vexa-bridge`.

### 13.1 Guardrails (RoboCo lineage)

- **Policy module** `packages/coding-agent/extensions/zcode-guardrails/policy.ts` (pure data, no I/O): `BudgetPolicy` with `toolCallWarnAt: 100`, `toolCallHaltAt: 300`, `loopThreshold: 3` identical `sha256(tool+args)[:16]` calls within a rolling `loopWindow: 10` (action: deny, not warn), per-tool rejection windows (`perToolRetryWindowMs: 60000`) plus a session-absolute retry cap (`windowCap x 3`) to catch "slow drip" loops, and read-only verbs (read/grep/find/ls) exempt. Every constant overridable via `ZCODE_BUDGET_*` env vars. RoboCo's incident-annotated defaults are the starting values.
- **SessionMetrics**: in-process singleton - total tool calls, per-tool histogram, rolling args-hash deque, stop attempts, token totals parsed from our own JSONL transcript with `message.id` dedup (RoboCo lesson: naive summing roughly doubles totals because one assistant message logs usage several lines).
- **Wiring as an extension** (thin-overlay; the extension API can intercept tool calls): deny the 3rd identical call with structured remediation text ("stop retrying, tell the human"), warn/halt at budget thresholds with **in-band one-line reminders** the model sees next turn (`[Budget] 87/300 tool calls. Plan your remaining work.`) - RoboCo found in-band warnings beat silent kills. Halt = block + graceful stop. Guard side-channels fail open, never block shutdown.
- **Rate-limit parking**: on 429, park with `2^attempt` exponential backoff, verify recovery with a free probe (`GET /v1/models` - no tokens), then resume. Distinguish "parked" from "crashed" in the status line. Doubles as colibri queue handling.
- **Post-mortem**: structured record on session end (terminal tool, duration, tool count, loop/halt flags, reason) appended to a per-project log; `zcode status` surfaces SessionMetrics.

### 13.2 Memory and knowledge vault (obsidian-vexa-bridge lineage)

- **Distillation**: on session end, one model call (default: the session's own model, configurable) producing `Problem: / Approach: / Gotcha:` in <=120 words - or exactly `NONE` when there is no real lesson, so the store never fills with junk (RoboCo `memory_distiller.py` gate).
- **Knowledge vault** (vexa-bridge patterns): git-backed Obsidian-compatible markdown folder curated by the agent under a **written conventions contract** file (entity layout, `[[wikilinks]]` by title, facts dated and attributed, dedup-before-create, do not invent); `inbox/` -> `processed/` queue; `log.md` journal. The pipeline keeps an atomic `state.json` (tmp+replace under lock), honors the **single-commit-point invariant** (mark-done is the only commit, always last), and applies the **5-strike poison limit** to items that keep failing.
- **Two modes**: `lesson` (per-session distillation only) and `vault` (additionally folds sessions into the knowledge graph via an agent pass with the conventions contract - vexa graph-mode analog).
- **Retrieval**: at session start, inject only lessons/notes clearing a relevance floor (lexical scoring first; no embeddings in v1). If retrieval grows, split indexes per source type and rescan by mtime (RoboCo optimal_brain shape).
- **Config**: `memory.enabled` (default false - experimental), `memory.mode` (lesson|vault), `memory.vaultDir`, `memory.model`.
- **Testing**: pure-function core with one impure seam per module (the vexa-bridge testability pattern); state-store unit tests; no network in tests.

### 13.3 UI design language

Run design-taste/brandkit skills once to fix palette, tone and state hierarchy (streaming / waiting / parked / budget-warning), then hand-translate into `zcode-dark`/`zcode-light` theme JSONs and a `DESIGN.md` component-rules doc. Terminal constraints applied at translation time.

### 13.4 Explicitly deferred

Injection guard (RoboCo `foundation/policy/injection_guard.py` port), `zcode bench` (RoboCo eval/runner shape), guard-core-ts protection for any exposed server mode - last, per Renn.

### 13.5 Acceptance

Third identical tool call denied with remediation text; halt at `toolCallHaltAt` with graceful exit; 429 parks the session and a free probe resumes it; post-mortem written on every session end; a vault note generated from a session is idempotent (re-run creates no duplicate); a poisoned item is skipped after 5 strikes; `npm run check` green throughout.
