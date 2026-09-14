# Local inference setup

hummin works against any OpenAI-compatible server on your LAN. The bundled
`hummin-colibri` extension registers ONE provider (`colibri`) whose model list
is the union of what every configured server reports - so GLM, Qwen, or any
other model becomes a picker entry, regardless of which engine serves it.

Two engines cover the currently interesting models:

| Engine | Reads | Best at | Used here for |
|---|---|---|---|
| [colibri](https://github.com/JustVugg/colibri) (C, Apache-2.0) | its own int4 group-64 safetensors containers | huge MoE models streamed off disk on modest RAM | GLM-5.3-Flash, GLM-5.3 |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) (MIT) | GGUF | dense models that fit in RAM, fast interactive use | Qwen3.8-27B |

Rule of thumb: dense model that fits your RAM -> GGUF via llama.cpp. Frontier
MoE bigger than your RAM -> colibri container streamed from fast storage.

## 1. Configure hummin

```bash
# ~/.zshrc - order is preference: first server serving a model wins,
# later duplicates become automatic fallbacks
export HUMMIN_COLIBRI_INSTANCES="http://nas:9996,http://nas:9998,http://mac:9998"
export COLI_API_KEY=your-key                   # omit if servers run keyless
```

| Variable | Purpose |
|---|---|
| `HUMMIN_COLIBRI_INSTANCES` | comma-separated server base URLs; order = preference, duplicates dedupe |
| `COLI_API_KEY` | bearer token; a placeholder is sent for keyless servers |
| `HUMMIN_COLIBRI_CTX` | fallback context window (default 16384) - used only when the server does not report one |

The extension autoloads from `~/.hummin/agent/extensions/` (no `-e` needed).
Sessions discover models at start: restart the session after changing servers.
Context windows are read from each server's `/props` (llama.cpp serves it;
colibri does not, so its models use the fallback).

Reasoning: qwen-family models map hummin's `/thinking` level onto
`chat_template_kwargs.enable_thinking` per request (llama.cpp applies it).
Default is ON (hummin's default thinking level is medium); `/thinking off`
disables. Other families register without thinking controls.

## 2. Worked example (single NAS + Mac)

### Qwen3.8-27B (dense, ~17.5GB GGUF) - the fast daily driver

Mac (Apple Silicon, brew):

```bash
brew install llama.cpp
hf download unsloth/Qwen3.8-27B-GGUF --include "Qwen3.8-27B-UD-Q4_K_XL.gguf" \
  --local-dir /Volumes/YourVolume/Qwen3.8-27B-GGUF    # export HF_HUB_DISABLE_XET=1 if stalls

# serve: port 9998, 64K context (KV costs ~64KB/token - size to your RAM headroom)
llama-server --host 0.0.0.0 --port 9998 \
  --model /Volumes/YourVolume/Qwen3.8-27B-GGUF/Qwen3.8-27B-UD-Q4_K_XL.gguf \
  --alias qwen3.8-27b --ctx-size 65536 --jinja --api-key YOURKEY
```

Run it under launchd (`KeepAlive` on failed exit) or tmux; expect ~17.6GB RSS
plus ~64KB/token of KV. Apple Silicon M2 Pro measured: ~7-10 tok/s generation,
~54 tok/s prompt processing.

NAS (Linux, docker compose - the image is official and small):

```yaml
name: local-llm
services:
  qwen-27b:
    image: ghcr.io/ggml-org/llama.cpp:server
    container_name: qwen-27b
    restart: unless-stopped
    ports: ["9996:9996"]
    volumes: ["/volume1/ai-models/llama.cpp:/models:ro"]
    command: ["--host", "0.0.0.0", "--port", "9996",
              "--model", "/models/Qwen3.8-27B-UD-Q4_K_XL.gguf",
              "--alias", "qwen3.8-27b", "--ctx-size", "262144",
              "--threads", "4", "--jinja", "--api-key", "YOURKEY"]
```

Set `--threads` to your real core count - llama.cpp defaults to physical
cores and undercounts efficiency-core CPUs. Context is cheap here: 262K
(the model's native max) is ~17GB of KV. CPU-only generation on a 4-core
efficiency CPU measured ~1.5 tok/s: an always-on fallback and batch host,
not an interactive endpoint.

### GLM-5.3-Flash (frontier MoE, ~195GB int4) - on-demand depth

GLM ships as colibri containers, NOT GGUF (mainline llama.cpp has no
`glm5next` support yet; watch their PRs). Colibri keeps dense weights in RAM
and streams experts from disk, so a 195GB model runs in 128GB of RAM at
~0.3-3 tok/s depending on cold/warm state.

- Models: `Justvugg/GLM-5.3-Flash-colibri-int4-g64` (~195GB, daily driver)
  and `Justvugg/GLM-5.3-colibri-int4-g64` (~114GB flagship). Verify a
  downloaded container with a tensor census against its `config.json` before
  trusting it - a broken republish once shipped with whole shard ranges empty.
- RAM: 64GB+ comfortable (engine cache `--ram` sizes the hot-expert pool).
  32GB-class machines cannot hold GLM-5.3-Flash at all.
- Disk: fast NVMe matters - experts are read per token.
- Serve: `coli serve --ram 48 --host 0.0.0.0 --port 9998` with
  `COLI_MODEL`, `COLI_API_KEY`, `CTX=16384`. Keep it running and warm:
  the first generation after a start can take up to an hour (cold page
  cache), warm runs settle ~3s/token on a 4-core NAS.
- Because it is slow, treat GLM as on-demand depth, not the default model.

## 3. Operating notes

- hummin's own prompt is ~5.4K tokens (system + tools). llama.cpp's prefix
  cache absorbs that across turns in one session; the first request of a
  session pays it.
- One generation at a time per colibri instance; llama.cpp queues by KV
  budget. The extension serializes per server and retries 429s.
- Client timeouts: hummin's `httpIdleTimeoutMs` should be `0` (disabled) for
  local models - slow prefills otherwise look like dead connections.
- Downstream client test scripts must export the same `COLI_API_KEY` as the
  server, or they get 401s that surface as "Connection error".
- Restarting a colibri server resets its warm cache (the expensive part);
  restart llama.cpp containers freely.

## 4. Troubleshooting

| Symptom | Fix |
|---|---|
| Download stalls at 0% | `export HF_HUB_DISABLE_XET=1`, re-run (resumes) |
| HTTP 401 | key mismatch between server and client |
| HTTP 429 | server mid-generation; the extension retries automatically |
| Model missing from the picker | its server was unreachable at session start; restart the session |
| Picker shows the wrong context size | server was loading during discovery; `/props` is only read at start |
| First token takes forever on the NAS | cold colibri cache (up to 1h) or slow CPU prefill - use the fast machine for interactive work |
| llama.cpp slow on an efficiency-core CPU | set `--threads` to the real core count |
