# Local models

Run GLM and other open models on your own hardware and talk to them from hummin in the terminal. This section is the complete path, battle-tested on a real homelab (a UGREEN NAS with 128GB RAM and an Apple Silicon Mac Mini with 32GB) over weeks of daily use.

## The one decision: which engine?

Pick by model shape, not by preference:

| | llama.cpp (GGUF) | colibri |
|---|---|---|
| **Model type** | Dense models, or MoE models whose whole quant fits in your RAM | Frontier MoE models far bigger than your RAM |
| **Format** | `.gguf` files | colibri int4 group-64 safetensors containers (**not** GGUF) |
| **Trick** | Everything in RAM, optional GPU | Dense weights in RAM, streams experts from NVMe/SSD per token |
| **Speed** | Fast (tens of tok/s on Apple Silicon) | Slow but huge (0.5-3 tok/s for a 321B model) |
| **Use it for** | Daily interactive coding | On-demand depth, batch and privacy-sensitive runs |

!!! tip "Rule of thumb"
    Dense model that fits your RAM goes GGUF via llama.cpp. Frontier MoE bigger than your RAM goes colibri streamed from fast storage. If a GGUF exists for a colibri-only model, check llama.cpp architecture support first - new architectures often lag.

## Models we actually run

These are proven configurations, with real measured numbers on real hardware:

| Model | Size on disk | Engine | Hardware floor | Expected speed |
|---|---|---|---|---|
| [Qwen3.8-27B](https://huggingface.co/unsloth/Qwen3.8-27B-GGUF) (dense, UD-Q4_K_XL) | ~17.5GB | llama.cpp | 24GB RAM | ~7-10 tok/s on M2 Pro, ~1.5 tok/s CPU-only NAS |
| [Ornith-1.5-35B-A3B](https://huggingface.co/ornith-ai/Ornith-1.5-35B-A3B-GGUF) (MoE, ~3B active, Q4_K_M) | ~21.7GB | llama.cpp | 32GB RAM, solo | 20+ tok/s (agentic-coding tuned) |
| [GLM-5.3-Flash](https://huggingface.co/Justvugg/GLM-5.3-Flash-colibri-int4-g64) (321B MoE) | ~195GB | colibri | 64GB+ RAM, fast disk | ~0.5-3 tok/s warm |
| [GLM-5.3](https://huggingface.co/Justvugg/GLM-5.3-colibri-int4-g64) flagship | ~114GB | colibri | 64GB+ RAM, fast disk | Same ballpark as Flash |
| Small fast models (llama3.2:3b, qwen, embeddings) | <10GB | Ollama | Anything | Instant |

!!! warning "32GB machines cannot hold GLM-5.3-Flash"
    That is not a tuning problem: the dense weight slice alone exceeds the RAM. Run it on the 64GB+ box and reach it over the network.

## The path, in five steps

1. **[Download the model](downloading.md)** - with `hf download`, on the machine with the WAN pipe, stall-proof.
2. **[Serve it](serving-llamacpp.md)** - llama.cpp on Mac (launchd) or Linux (docker compose).
3. **[Or serve the big ones](serving-colibri.md)** - colibri for GLM-5.3-Flash and GLM-5.3.
4. **[Connect hummin](fleet.md)** - one env var, one model picker, everything on your LAN.
5. **[Keep it running](operations.md)** - launchd services, co-run rules, warm caches.

Stuck? [Troubleshooting](troubleshooting.md) covers every failure we have hit, with fixes.

## The 60-second version

Already know what you are doing? This is the whole loop:

```bash
# 1. download (resumable; add HF_HUB_DISABLE_XET=1 if it stalls)
hf download unsloth/Qwen3.8-27B-GGUF --include "Qwen3.8-27B-UD-Q4_K_XL.gguf" \
  --local-dir ~/models/Qwen3.8-27B-GGUF

# 2. serve
llama-server --host 0.0.0.0 --port 9998 \
  --model ~/models/Qwen3.8-27B-GGUF/Qwen3.8-27B-UD-Q4_K_XL.gguf \
  --alias qwen3.8-27b --ctx-size 65536 --jinja

# 3. connect hummin and go
export HUMMIN_COLIBRI_INSTANCES="http://127.0.0.1:9998"
hummin            # /model -> your model appears in the picker
```
