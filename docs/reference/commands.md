# Slash commands

The complete command surface, grouped by area. Built-in upstream commands ship as-is; hummin's additions are marked.

## Core

| Command | Purpose |
|---|---|
| `/model` | Model picker (cloud catalog + local fleet, host badges, set default) |
| `/thinking` | Reasoning level (maps to GLM `reasoning_effort`; qwen-family enable_thinking locally) |
| `/scoped-models` | Per-role model assignment |
| `/settings` | Settings browser |
| `/trust` | Project trust management |
| `/login`, `/logout` | Provider authentication |
| `/reload` | Re-scan fleet servers and refresh the picker |
| `/quit` | Exit |

## Workflow

| Command | Purpose |
|---|---|
| `/plan` | Read-only plan mode |
| `/todos` | Plan checklist popup |
| `/init` | Generate project `AGENTS.md` (cloud model) |
| `/doctor` | Settings, fleet, credentials, extensions and vault checks |
| `/compact` | Compact the session context manually |
| `/clear` | Clear the session |

## Sessions

| Command | Purpose |
|---|---|
| `/session` | Session picker and info |
| `/resume` | Resume a past session |
| `/name` | Name this session |
| `/fork`, `/clone` | Branch the session |
| `/rewind` | Restore files and/or conversation to an earlier prompt |
| `/export` | Export as md / html / jsonl |
| `/share` | Share as a gist |
| `/copy` | Copy the last message |
| `/tree` | Session tree view |
| `/queue` | Inspect and reorder queued messages |

## Teamwork (hummin)

| Command | Purpose |
|---|---|
| `/agents` | Online sessions, inbox, rename |
| `/agent-name` | Persist this session's broker name |
| `/team` | Shared cross-session task board |
| `/background` | Background tasks panel (also `ctrl+b`) |
| `/cron` | Scheduled wake-ups: entries, next run, delete |

## Fleet and local inference (hummin)

| Command | Purpose |
|---|---|
| `/fleet` | Inference servers with Start / Stop / Restart |
| `/status` | Model, fleet health, memory, todos, TUI mode |
| `/context` | Token breakdown (est/exact), cache-hit ratio, compaction line |
| `/cost` | Per-model cost, local-served vs cloud split |
| `/llama` | llama.cpp router |

## Safety and integrations (hummin)

| Command | Purpose |
|---|---|
| `/sandbox` | Bash sandbox status + workspace toggle |
| `/bashguard` | Advisory matrix status |
| `/hooks` | Loaded hooks table + reload |
| `/mcp` | MCP server status + restart |
| `/lsp` | TypeScript LSP status + restart |

## Memory (hummin)

| Command | Purpose |
|---|---|
| `/memory` | Memory status and control |
| `/vault-fold` | Fold inbox lessons into the vault |
| `/vault-recall` | Search the vault |
| `/vault-canvas` | Open the graph canvas |

## Also available

- `# <text>` - quick-capture a note to the vault inbox, no turn spent
- `/skill:<name>` - invoke an installed skill
- `/hotkeys` - full keymap
- `/changelog` - what changed
- Prompt templates registered in your config appear as their own commands
