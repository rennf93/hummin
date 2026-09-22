<p align="center">
  <img alt="hummin logo" src="https://raw.githubusercontent.com/rennf93/hummin/main/.github/assets/logo-mark.png" width="320">
</p>

# hummin

A GLM-native terminal coding agent: the [pi agent harness](https://github.com/earendil-works/pi) (MIT, by Mario Zechner / earendil-works) retuned for Z.ai's GLM models and [colibri](https://github.com/JustVugg/colibri) local inference.

Why a fork: GLM is a first-class citizen here, not a compatibility mode. The provider picker surfaces Z.ai and your local colibri instances first, the default model is GLM, and the whole tool assumes you may be talking to a slow, disk-streaming local model instead of a datacenter.

> Based on [pi](https://github.com/earendil-works/pi). All credit for the agent core goes upstream; this fork only curates, extends, and rebrands. License: MIT (see [LICENSE](LICENSE)).

## Demo

Ornith 1.5 35B (local GGUF via llama.cpp) working through four upstream bugs in hummin's own source. Watch the footer: live **tok/s** next to the context bar - 31 tok/s from a model running on a Mac Mini.

![hummin running Ornith 1.5 35B locally at 31 tok/s](docs/assets/demo-ornith.gif)

## Install

```bash
npm install -g hummin-cli
```
Or from a clone:

```bash
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
- **Memory**: session distillation into lessons plus a self-curating Obsidian-compatible vault with BM25-ranked recall injected into every session.
- **Visibility**: `/context` token breakdown with cache-hit ratio, `/cost` with local-served vs cloud split, `/status` + `/doctor` dashboards, two-row statusline (user-definable segments).
- **UX**: vim editing mode, grouped command palette, custom statusline segments, fullscreen transcript search, themeable, remote browser control over loopback.

## Local inference (colibri, llama.cpp, ...)

The bundled `hummin-colibri` extension registers ONE provider (`colibri`) that exposes every model found on your local OpenAI-compatible servers. The engine behind each server does not matter - colibri (MoE streaming), llama.cpp, Ollama all work; the server's own `/v1/models` is the source of truth for model ids, and the first server in the list that serves a model wins (duplicates dedupe into one entry with fallback ordering).

**Full documentation: [rennf93.github.io/hummin](https://rennf93.github.io/hummin/) - engines, model choices, downloading, server setup on Linux/Mac, fleet configuration and troubleshooting.**

```bash
export HUMMIN_COLIBRI_INSTANCES="http://nas:9996,http://nas:9998,http://mac:9998"   # order = preference
export COLI_API_KEY=...                    # only if the servers enforce a key
hummin                                     # extensions autoload from ~/.hummin/agent/extensions/
```

Behavior:

- One model namespace across all servers; unreachable servers contribute no models until a session restart (no guessed placeholder ids).
- One generation at a time per server is handled, not thrown at you: requests are serialized per server and the documented busy response (429 + `x-colibri-queue-wait-ms`) is retried with capped backoff.
- Context windows are read from each server's `/props` when available (llama.cpp), falling back to `HUMMIN_COLIBRI_CTX` (default 16384).
- Reasoning: qwen-family models map hummin's thinking level to `chat_template_kwargs.enable_thinking` - on by default, `/thinking off` disables. Other model families register without thinking controls.

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

- **lesson mode**: after each session, one distillation call summarizes it into a Problem/Approach/Gotcha note (or nothing, if there is no lesson) under `~/.hummin/agent/memory/`.
- **vault mode**: lessons queue in a git-backed, Obsidian-compatible vault; `/vault-fold` runs an agent pass that folds them into an entity graph (`entities/<type>/<slug>.md`, wikilinks, dated facts) following the vault's own AGENTS.md conventions contract; `/vault-recall <query>` searches it.
- Distillation provider defaults to cloud (`zai`); override with `HUMMIN_MEMORY_PROVIDER` / `HUMMIN_MEMORY_MODEL_ID`.

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

Env vars (`HUMMIN_COLIBRI_INSTANCES`, `HUMMIN_MEMORY`, `HUMMIN_MEMORY_MODE`, `HUMMIN_MEMORY_VAULT_DIR`) still override stored settings when set.

Then copy [SYSTEM.example.md](SYSTEM.example.md) to `~/.hummin/agent/SYSTEM.md` for the tuned operating rules, and `/model` to pick a default.

## Differences from upstream pi

- Rebranded binary/config (`hummin`, `~/.hummin/agent`) via pi's official `piConfig` fork support.
- GLM-first provider curation and defaults (this README).
- `hummin-colibri` extension + mock server.
- One upstream build fix (`FinishReason.TOO_MANY_TOOL_CALLS` handling) pending upstream discussion.

Everything else is upstream pi: sessions, extensions API, themes, tools, RPC/JSON modes. Read upstream's docs under [packages/coding-agent/docs](packages/coding-agent/docs).

## Contributing

This fork follows upstream's bar: understand your code, keep the core minimal, prefer extensions. See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) for the rules that apply to agent-written changes.
