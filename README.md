<p align="center">
  <img alt="hummin logo" src="https://raw.githubusercontent.com/rennf93/hummin/main/.github/assets/logo-mark.png" width="320">
</p>

# hummin

A GLM-native terminal coding agent: the [pi agent harness](https://github.com/earendil-works/pi) (MIT, by Mario Zechner / earendil-works) retuned for Z.ai's GLM models and [colibri](https://github.com/JustVugg/colibri) local inference.

Why a fork: GLM is a first-class citizen here, not a compatibility mode. The provider picker surfaces Z.ai and your local colibri instances first, the default model is GLM, and the whole tool assumes you may be talking to a slow, disk-streaming local model instead of a datacenter.

> Based on [pi](https://github.com/earendil-works/pi). All credit for the agent core goes upstream; this fork only curates, extends, and rebrands. License: MIT (see [LICENSE](LICENSE)).

## Demo

Ornith 1.5 35B (local GGUF via llama.cpp) working through four upstream bugs in hummin's own source. Watch the footer: live **tok/s** next to the context bar - 31 tok/s from a model running on a Mac Mini.

![hummin running Ornith 1.5 35B locally at 31 tok/s](https://github.com/rennf93/hummin/blob/main/docs/assets/demo-ornith.gif)

## Install

Install the npm package (recommended - the clone below is only for developing hummin itself):

```bash
npm install -g hummin-cli
```
Or from a clone (development only):

```bash
git clone https://github.com/rennf93/hummin.git
cd hummin
npm install
npm run build
cd packages/coding-agent && npm link     # puts `hummin` on your PATH
```

Requires Node >= 22.19.

## Quickstart (Z.ai cloud)

```bash
export ZAI_API_KEY=your-key      # or run `hummin auth login zai`
hummin                            # interactive TUI; GLM-5.3 is the default suggestion
hummin -p "summarize this repo"   # oneshot mode
```

GLM-5.3, GLM-5.3-Flash and GLM-5.3-highspeed ship in the `zai` provider catalog (1M-token context, reasoning variants mapped to `reasoning_effort`). Pick models with `/model`; set a persistent default with the picker's "set as default" action.

## Features

- **Agent teamwork**: sessions message each other across terminals and projects (`agent_send`, `/agents`), share a task board (`/team`), spawn bounded subagents (`task`, `/background` on `ctrl+b`), and run scheduled wake-ups (`/cron`).
- **Local fleet**: one provider across all your OpenAI-compatible servers (colibri, llama.cpp, Ollama, ...), health-probed and startable from the model picker, with per-origin serialization and real context windows.
- **Integrations**: MCP client (`mcpServers`), TypeScript LSP tools (diagnostics/definition/references/hover), declarative `hooks.json`, `ask_user` questions, DuckDuckGo search and SSRF-guarded fetch.
- **Safety**: bash sandboxing (macOS seatbelt / Linux bubblewrap) with `[Sandbox]` in-band blocks, destructive-command advisories (`/bashguard`), loop + budget guardrails, project trust, file checkpoints with `/rewind`.
- **Memory**: session distillation into lessons plus a self-curating Obsidian-compatible vault, with hybrid BM25 + embeddings recall injected into every session and searchable on demand.
- **Visibility**: `/context` token breakdown with cache-hit ratio, `/cost` with local-served vs cloud split, `/status` + `/doctor` dashboards, two-row statusline (user-definable segments).
- **UX**: vim editing mode, grouped command palette, custom statusline segments, fullscreen transcript search, themeable, remote browser control over loopback.

## Local inference (colibri, llama.cpp, ...)

The bundled `hummin-local` extension turns every configured OpenAI-compatible server into a fleet citizen: one provider per engine+host (so the picker badge says WHICH engine and WHICH host serves a model), the server's own `/v1/models` as the source of truth for model ids, and no guessed placeholder ids for servers that are down. The engine behind each server does not matter - colibri (MoE streaming), llama.cpp, Ollama all work. Configure the fleet in settings (`fleet.servers`, what `hummin init` writes) or via env; fleet order is preference order.

**Full documentation: [rennf93.github.io/hummin](https://rennf93.github.io/hummin/) - engines, model choices, downloading, server setup on Linux/Mac, fleet configuration and troubleshooting.**

```bash
export HUMMIN_INSTANCES="http://nas:9996,http://nas:9998,http://mac:9998"   # order = preference
export HUMMIN_API_KEY=...                  # only if the servers enforce a key (COLI_API_KEY still honored)
hummin                                     # extensions autoload from ~/.hummin/agent/extensions/
```

Behavior:

- Fleet failover: a request that cannot start (server down, connection died before any content) or exhausts its busy-retry budget moves to the next fleet endpoint serving the same model, in fleet order. Each hop announces itself in the UI.
- One generation at a time per server endpoint: requests are serialized per endpoint and busy responses (429/overloaded) are retried with capped backoff before failover.
- Context windows come from each server's `/props` when available (llama.cpp), from persisted fleet health (7 days) otherwise, and from `HUMMIN_CTX` (default 16384) as the last fallback. Downed servers keep their real picker entries from the persisted catalog instead of falling back to guesses.
- Reasoning: qwen-family and nemotron models map hummin's thinking level to `chat_template_kwargs.enable_thinking` - on by default, `/thinking off` disables. Other model families register without thinking controls.
- `/fleet` probes, starts, stops, and restarts servers; the `/model` picker can start an offline server directly.

### Developing without a server

A mock server speaks the same surface (streaming, `/health`, `/v1/models`, 429 queueing):

```bash
node scripts/mock-colibri.mjs --port 9998 --model glm-5.3-flash
HUMMIN_COLIBRI_INSTANCES="http://127.0.0.1:9998" hummin -p "hello"
```

## GLM-first curation

- `/model` picker: current model, saved default, then zai/colibri providers, then the rest alphabetically.
- `/login`: curated providers first. Other built-ins are hidden unless already configured; set `"providers": { "showAll": true }` in settings to always see everything.
- Default theme: `hummin-dark` (override with `"theme"` in settings or the first-run dialog).


## Persistent memory (experimental)

Session distillation and a self-curating knowledge vault, off by default:

```bash
export HUMMIN_MEMORY=1                    # enable
export HUMMIN_MEMORY_MODE=vault           # lesson (default) or vault
export HUMMIN_MEMORY_VAULT_DIR=~/hummin-vault
```

- **lesson mode**: after each session, a distillation pass extracts up to three distinct Problem/Approach/Gotcha lessons (or nothing, when there is no durable lesson; a System-1 intake score gates out session-specific noise) under `~/.hummin/agent/memory/`. Recall is hybrid: BM25 blended with embedding similarity when an embeddings endpoint resolves, relevance-floored, and injected into sessions as a delta briefing (a lesson is never briefed twice). The `vault` tool searches lessons and entities on demand.
- **vault mode**: lessons queue in a git-backed, Obsidian-compatible vault; folds run as background agent passes that merge them into an entity graph (`entities/<type>/<slug>.md`, wikilinks, dated facts) following the vault's own AGENTS.md conventions contract, with automatic folding at a threshold and a post-fold validation pass (clean worktree, inbox drained, every moved lesson cited). `/vault-canvas` renders the graph for Obsidian; `/vault-recall <query>` searches it.
- Distillation follows the session's selected model; the cloud fallback defaults to `zai` and is overridden with `HUMMIN_MEMORY_PROVIDER` / `HUMMIN_MEMORY_MODEL_ID`.
- Child sessions (`task`, cron) inherit a bounded set of relevant lessons in their brief and get read-only vault search (`HUMMIN_MEMORY_TOOLS=1`), never the write path.

## Bench

Golden-task harness for measuring agent/provider changes:

```bash
node bench/run.mjs --provider zai --model glm-5.3-flash          # cloud baseline (fast)
node bench/run.mjs --provider colibri --model qwen3.8-27b --thinking off   # local llama.cpp
```

Three fixtures (implement, fix, QA-catch) with deterministic checks; results land in `bench/results/` stamped with a config hash for A/B attribution.

## Recommended personal setup

Run the interactive setup once - it writes real settings (globally, or per-project with `--project`), so no shell exports are needed:

```bash
hummin init                # local servers, project memory, vault directory
hummin init --yes --memory vault --vault-dir ~/hummin-vault \
  --instances "http://nas:9996,http://nas:9998,http://mac:9998"   # scriptable
```

Env vars (`HUMMIN_INSTANCES` (pre-rename `HUMMIN_COLIBRI_INSTANCES` still works), `HUMMIN_MEMORY`, `HUMMIN_MEMORY_MODE`, `HUMMIN_MEMORY_VAULT_DIR`) still override stored settings when set.

Then copy [SYSTEM.example.md](https://github.com/rennf93/hummin/blob/main/SYSTEM.example.md) to `~/.hummin/agent/SYSTEM.md` for the tuned operating rules, and `/model` to pick a default.

## Differences from upstream pi

The fork is a thin overlay on upstream: zero deletions, `@earendil-works/*` package names kept for cheap upstream merges. On top of the rebrand, it ships 27 bundled extensions (upstream ships none; its `examples/extensions/` are reference code) and a set of core changes. What that adds, by area:

- **Memory and vault** (`hummin-memory`, `lib/memory-workers`): session distillation into lessons with a System-1-scored intake gate, hybrid BM25 + embeddings recall injected per prompt, usage-aware decay, a git-backed Obsidian vault with validated auto-folding, and lesson inheritance for child sessions. Upstream has no memory feature.
- **System-1 decision layer** (`hummin-sys1`, `lib/decision-engine`, `lib/child-dispatch-review`, `lib/model-rightsize`): one selectable decision engine (laya cheap local, clef strong local, jev hosted; one at a time, no auto-failover) wired into four automatic hooks (per-turn destructive-intent steer, a bash gate with deterministic classifiers plus a scored gray zone and a confirm-marker escape, test-failure triage, memory intake scoring), the `sys1_decide` tool, and model right-sizing for child dispatches with reviewable holds. No upstream equivalent.
- **Local fleet** (`hummin-local`, `hummin-fleet`, `lib/fleet-actions`): per-engine+host providers with fleet failover chains, per-endpoint serialization, busy backoff, `/props`-measured context windows, 7-day fleet-health persistence, and server controls from `/fleet` and the model picker. Plus an EnvHttpProxy-aware HTTP dispatcher tuned for slow local prefills.
- **Agent teamwork** (`hummin-agents`, `hummin-team`, `hummin-cron`, `hummin-subagents`, `hummin-monitor`): cross-terminal messaging over a Unix-socket broker with offline inboxes, a shared task board, scheduled detached runs, bounded subagents with background mode and session-switch adoption, and event-driven background monitors plus one-shot execs with completion delivery.
- **Safety depth** (`hummin-sandbox`, `hummin-bashguard`, `hummin-guardrails`, `hummin-plan`, `hummin-session`, `hummin-sys1`: workspace sandboxing (seatbelt/bubblewrap) applied to every shell path, advisory and gate layers over background shells too, loop/circuit/budget guardrails with friction steers and a verify-nudge, plan mode, and file checkpoints with `/rewind`.
- **Observability** (`hummin-telemetry`, `hummin-friction`, `hummin-usage`, `hummin-stats`, `lib/friction`): a telemetry sink feeding `/stats`, a friction log feeding `/friction` with per-engine sys1-gate calibration, `/context` with cache-hit ratio first-class, `/cost` with a local-vs-cloud split.
- **Integrations**: MCP client with offline dimming (`hummin-mcp`), TypeScript LSP tools with edit-time diagnostics push (`hummin-lsp`), `hooks.json` (`hummin-hooks`), path-scoped rules (`hummin-rules`), `ask_user` (`hummin-ask`), todos (`hummin-todos`), `/init` + `/doctor` (`hummin-project`), remote browser control (`hummin-remote`).

Core changes beyond extensions: GLM-first provider curation and defaults, `hummin-dark` theme, read continuation paging, indentation-insensitive edit matching, write diff feedback, `--no-json-deltas` for JSON-mode consumers, and a per-section system-prompt budget report in `/status`. All are documented in the per-package CHANGELOGs.

Everything else is upstream pi: sessions, extensions API, themes, tools, RPC/JSON modes. Read upstream's docs under [packages/coding-agent/docs](packages/coding-agent/docs).

## Contributing

This fork follows upstream's bar: understand your code, keep the core minimal, prefer extensions. See [CONTRIBUTING.md](https://github.com/rennf93/hummin/blob/main/CONTRIBUTING.md) and [AGENTS.md](https://github.com/rennf93/hummin/blob/main/AGENTS.md) for the rules that apply to agent-written changes.
