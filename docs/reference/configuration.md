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

## Behavior

| Setting | Purpose |
|---|---|
| `editorMode` | Vim editing mode |
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
