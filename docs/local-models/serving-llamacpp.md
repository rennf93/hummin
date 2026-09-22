# Serving with llama.cpp

llama.cpp serves GGUF models over an OpenAI-compatible API. It is the right engine for dense models and RAM-sized MoE quants: fast, stable, easy to run as a service.

## Install

```bash
# Mac (Apple Silicon, Metal enabled):
brew install llama.cpp

# Linux (any PC or NAS, docker image - see the compose example below)
```

## Run it (manual, first time)

Always run a new model by hand once, before turning it into a service:

```bash
llama-server --host 0.0.0.0 --port 9998 \
  --model /path/to/Qwen3.8-27B-UD-Q4_K_XL.gguf \
  --alias qwen3.8-27b \
  --ctx-size 65536 \
  --jinja \
  --api-key YOURKEY
```

Flag by flag:

| Flag | Why |
|---|---|
| `--host 0.0.0.0` | Reachable from other machines on the LAN. Use `127.0.0.1` if only this machine will use it |
| `--alias` | The model id clients see in `/v1/models`. Pick something stable |
| `--ctx-size` | Context window. KV cache costs ~64KB/token: 64K is ~4GB, 262K is ~17GB. Size to your RAM headroom |
| `--jinja` | Enables the model's chat template, required for reasoning controls |
| `--api-key` | Optional but recommended on a LAN-exposed server |
| `--threads` | Set to your **real** core count. llama.cpp defaults to physical cores and undercounts efficiency-core CPUs |
| `--n-gpu-layers 0` | **Mandatory for giant MoE GGUFs on the Mac.** Metal buffers for a 500GB-class model are a guaranteed OOM that takes down everything else running |

## Verify

```bash
curl -s -H "Authorization: Bearer YOURKEY" http://127.0.0.1:9998/v1/models
curl -s -H "Authorization: Bearer YOURKEY" http://127.0.0.1:9998/health
```

The models list should show your alias. Then send one small chat completion before wiring up any clients.

## As a service (Mac)

Manual runs die with the terminal. For daily use, run it as a [launchd service](operations.md#mac-launchd-template) - a ready-to-edit plist template is in [Server Templates](../reference/templates.md). This is the standard setup on a single-machine Mac: one plist per model, started on demand.

## As a docker service (Linux side note)

On a Linux PC, NAS or any always-on box, the official image in compose is the cleanest service form:

```yaml
services:
  qwen-27b:
    image: ghcr.io/ggml-org/llama.cpp:server
    restart: unless-stopped
    ports: ["9996:9996"]
    volumes: ["/path/to/models:/models:ro"]
    command: ["--host", "0.0.0.0", "--port", "9996",
              "--model", "/models/Qwen3.8-27B-UD-Q4_K_XL.gguf",
              "--alias", "qwen3.8-27b", "--ctx-size", "262144",
              "--threads", "4", "--jinja", "--api-key", "YOURKEY"]
```

Context is cheap on big-RAM boxes: 262K (the model's native max) is ~17GB of KV. On a weak CPU (our test box is an Intel N150 with 4 efficiency cores) generation measured ~1.5 tok/s: an always-on fallback and batch host, not an interactive endpoint. Put the interactive model on the fastest CPU in your network.

## Known architecture gaps

llama.cpp cannot load every GGUF. Notably, GLM-5.3's `glm5next` architecture is **not merged into mainline llama.cpp**, so stock llama.cpp, Ollama and LM Studio all fail with `unknown model architecture: 'glm5next'`. If a fresh model fails to load with an architecture error, check llama.cpp PRs for support before debugging anything else - and use the [colibri container](serving-colibri.md) instead, which is exactly what it exists for.

Next: [serving the big ones with colibri](serving-colibri.md).
