# hummin

A GLM-native terminal coding agent: the [pi](https://github.com/earendil-works/pi) agent harness (MIT, by Mario Zechner / earendil-works) retuned for Z.ai's GLM models and local inference with [colibri](https://github.com/JustVugg/colibri) and llama.cpp.

Why a fork: GLM is a first-class citizen here, not a compatibility mode. The provider picker surfaces Z.ai and your local inference servers first, the default model is GLM, and the whole tool assumes you may be talking to a slow, disk-streaming local model instead of a datacenter.

---

## Quick start

```bash
npm install -g hummin-cli

export ZAI_API_KEY=your-key      # or run `hummin auth login zai`
hummin                            # interactive TUI; GLM-5.3 is the default suggestion
```

Running models on your own hardware? Head straight to [Local Models](local-models/index.md).

---

## What hummin gives you

| Area | Highlights |
|---|---|
| **GLM first** | GLM-5.3, GLM-5.3-Flash and GLM-5.3-highspeed in the built-in `zai` catalog (1M-token context, reasoning variants mapped to `reasoning_effort`) |
| **Local fleet** | One provider across all your OpenAI-compatible servers (colibri, llama.cpp, Ollama, ...). Health-probed, startable from the model picker, per-origin serialization, real context windows |
| **Agent teamwork** | Sessions message each other across terminals and projects, share a task board, spawn bounded subagents, run scheduled wake-ups |
| **Safety** | Bash sandboxing (macOS seatbelt / Linux bubblewrap), destructive-command advisories, loop and budget guardrails, file checkpoints with `/rewind` |
| **Memory** | Session distillation into lessons plus a self-curating Obsidian-compatible vault with BM25-ranked recall |
| **Integrations** | MCP client, TypeScript LSP tools, declarative `hooks.json`, `ask_user` questions, web search and SSRF-guarded fetch |
| **Visibility** | `/context` token breakdown with cache-hit ratio, `/cost` with local-vs-cloud split, `/status` and `/doctor` dashboards, two-row statusline |

## Documentation map

<div class="grid cards" markdown>

- **[Getting Started](getting-started/installation.md)**
  ---
  Install hummin, authenticate, start your first session.

- **[Local Models](local-models/index.md)**
  ---
  The complete path: pick an engine, download a model, serve it, use it in the terminal.

- **[Features](features/teamwork.md)**
  ---
  Agent teamwork, memory, safety, integrations and session management in depth.

- **[Reference](reference/commands.md)**
  ---
  Slash commands, configuration, server templates and measured performance numbers.

</div>

## Status

Early and moving fast. See [CONTRIBUTING](https://github.com/rennf93/hummin/blob/main/CONTRIBUTING.md) to get involved.
