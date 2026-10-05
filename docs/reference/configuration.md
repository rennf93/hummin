# Configuration

Three layers, in precedence order: **environment variables beat settings**, and settings beat defaults. Project trust gates everything project-local.

## Local inference (the bundled fleet extension)

| Variable | Default | Purpose |
|---|---|---|
| `HUMMIN_COLIBRI_INSTANCES` | none | Comma-separated server base URLs. Order is preference; first server serving a model wins, later duplicates become fallbacks |
| `COLI_API_KEY` | none | Bearer token sent to every local server. A placeholder is sent when unset, so keyless servers work |
| `HUMMIN_COLIBRI_CTX` | 16384 | Fallback context window, used only when a server does not report one via `/props` |

## Cloud (Z.ai)

| Variable | Purpose |
|---|---|
| `ZAI_API_KEY` | Z.ai API key (or `hummin auth login zai`) |

## Memory

| Setting / env | Purpose |
|---|---|
| `memoryEnabled` / `HUMMIN_MEMORY` | Master switch; `HUMMIN_MEMORY=0` forces off (set automatically in spawned subagents) |
| `memoryMode` | `lessons` or `vault` |
| `memoryVaultDir` | Vault directory (git-backed, Obsidian-compatible) |
| `memoryProvider`, `memoryModelId` | Model used for distillation |

## Fleet

| Setting | Purpose |
|---|---|
| `fleet.servers[]` | Ordered server registry: enables `/fleet` Start/Stop/Restart, health probes, start-from-picker |
| `fleet.autoStart` | Skip the confirm when starting a server from the model picker |

## Replay trimming

Completed turns are rewritten per request before the provider sees them, so GLM-family endpoints stop resending reasoning and stale tool output (z.ai recommends not resending reasoning). Session history is never modified; the active tool loop, redacted thinking, and thinking blocks with structured replay signatures always pass through.

| Setting | Default | Purpose |
|---|---|---|
| `replayTrim.thinking` | `true` | Drop replayed reasoning from completed turns |
| `replayTrim.toolResults` | `true` | Prune old tool results to head + marker + tail (`false` = lossless replay) |
| `replayTrim.toolResultCap` / `toolResultTail` | 2000 / 200 | Head/tail characters kept when pruning |

Applies to `anthropic-messages` and `openai-completions` models; other APIs are left untouched.

## System-1 decision layer

One decision engine backs four automatic hooks (bash gate, destructive-intent steer, test-failure triage, memory intake). A single engine, no failover; every read fails open, so an unreachable engine never blocks a session.

| Setting / env | Purpose |
|---|---|
| `decision.url` | Engine endpoint (default `http://127.0.0.1:9987/v1/systemone`) |
| `decision.apiKey` | Engine auth (`COLI_API_KEY` works as fallback) |
| `decision.gateThreshold` / `steerThreshold` / `triageThreshold` / `intakeThreshold` | Calibrate the four hooks |
| `sys1Gate.extraSafe` / `extraDestructive` | Regex lists layered onto the bash gate |
| `HUMMIN_SYS1_RIGHTSIZE` / `HUMMIN_SYS1_RIGHTSIZE_SWING` | Model right-sizing for child dispatches |

## Telegram bridge (cc-tg-hub)

Requires a running [cc-tg-hub](https://github.com/rennf93/cc-tg-hub) broker (one per machine; install with `bunx cc-tg-hub setup`). See docs/features/integrations.md.

| Setting / env | Purpose |
|---|---|
| `tgHub.enabled` / `TG_HUB=1` | Opt in. The env switch is per-session - prefer it (the setting is global and would register child/cron sessions too) |
| `tgHub.socketPath` / `TG_HUB_SOCKET` | Broker socket (default `~/.claude/cc-tg-hub/broker.sock`) |
| `tgHub.askTools` / `TG_HUB_ASK_TOOLS` | Tools that raise Allow/Deny buttons in Telegram (Deny blocks; Allow never bypasses a terminal dialog) |

## Behavior

| Setting | Purpose |
|---|---|
| `editorMode` | Vim editing mode |
| `compactPrompt` | Condense tool descriptions and system-prompt guidance (useful for slow-prefill local models) |
| `cacheWarming` | `off` / `streaming` / `idle` / `always` provider-side prompt-cache warming |
| `statusline.left`, `statusline.right` | Statusline segment tokens (`dir`, `repo`, `branch`, `model`, `ctx`, `tokens`, `cost`, `queue`, `background`, `sandbox`, `mcp`, `git`, `diff`, ...) |
| `providers.showAll` | Show the full upstream provider catalog in `/model`, not just GLM-first curation |
| `httpIdleTimeoutMs` | Set to `0` for local models: slow prefills otherwise look like dead connections |
| `defaultProjectTrust` | Trust fallback for un-trusted projects |

## Sandboxing, guardrails and other env switches

`HUMMIN_*` variables cover the fork surface: memory (8 variants), instances/ctx, fleet, sandbox, bashguard, guardrails and budgets, agents, cron (`HUMMIN_CRON=0` disables), mcp, lsp, and offline mode. Run `/doctor` to see what hummin actually picked up - settings, fleet, credentials, extensions and vault are all checked there.

## Files

| Path | Purpose |
|---|---|
| `~/.hummin/agent/settings.json` | Main settings |
| `~/.hummin/agent/extensions/` | TypeScript extensions (autoloaded, hot reload) |
| project `AGENTS.md` / `SYSTEM.md` | Context files fed to the model |
| project `hooks.json` | Shell hooks on four lifecycle events |
