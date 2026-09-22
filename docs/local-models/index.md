# Local models

Run GLM and other open models on **your own computer** and talk to them from hummin in the terminal. One Mac or PC is a complete setup - no NAS, no server, no second machine required. Where our instructions came from a bigger homelab (a UGREEN DXP6800 Pro NAS with an Intel N150 CPU and 128GB RAM, plus an Apple Silicon Mac Mini M2 Pro with 32GB RAM), we say so explicitly in side notes; the main path assumes the machine in front of you.

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
    Model that fits your RAM goes GGUF via llama.cpp. Frontier MoE bigger than your RAM goes colibri streamed from fast storage. If a GGUF exists for a colibri-only model, check llama.cpp architecture support first - new architectures often lag.

## Every model we tested, with verdicts

This is the honest list: what we ran, on which machine, whether it worked, and what it was actually good for. Sizes are measured on disk.

| Model | Quant / format | Size | Tested on | Verdict |
|---|---|---|---|---|
| [North Mini Code 1.0](https://huggingface.co/unsloth/North-Mini-Code-1.0-GGUF) | UD-Q4_K_XL | 18GB | Mac Mini (M2 Pro), also NAS docker | **Fast and good.** Best bulk worker we have: classification, digests, triage. 262K native context |
| [Ornith 1.5 35B-A3B](https://huggingface.co/ornith-ai/Ornith-1.5-35B-A3B-GGUF) | Q4_K_M | 20GB | Mac Mini | **Fast and good.** ~3B active params, 20+ tok/s expected, agentic-coding tuned. Must run solo on 32GB |
| [Nemotron 3.5 Lightning 30B-A3B](https://huggingface.co/unsloth/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF) | UD-Q4_K_XL | 24GB | Mac Mini | **Overthinks.** Emits very long reasoning chains; exclude unless a task rewards deep reasoning |
| [Qwen3.8-27B](https://huggingface.co/unsloth/Qwen3.8-27B-GGUF) | UD-Q4_K_XL | 16GB | Mac Mini (Metal), NAS (CPU) | **Good interactive coder** (~7-10 tok/s on the M2 Pro), but too slow for bulk automation on either machine (~1.5 tok/s on the NAS's N150) |
| GLM-5.3-Flash (colibri container) | int4 g64 safetensors | 195GB | NAS (N150, 128GB) | **Works, slow sip.** ~0.5-3 tok/s warm; needs 64GB+ RAM; needs a fast disk |
| [GLM-5.3-Flash GGUF](https://huggingface.co/unsloth/GLM-5.3-Flash-GGUF) | UD-IQ2_XXS | 95GB | Mac Mini | **Ran, not worth it.** 2-bit quality, CPU-only (`--n-gpu-layers 0` or Metal OOMs). The colibri container is the better path for GLM |
| GLM-5.3 (colibri container) | int4 g64 safetensors | 114GB | NAS | Same ballpark as Flash; flagship quality |
| [GLM-5.3 GGUF](https://huggingface.co/unsloth/GLM-5.3-GGUF) | UD-IQ2_M | 222GB | Mac Mini | **Ran, not worth it.** Same caveats as the Flash GGUF |
| [Kimi K3 GGUF](https://huggingface.co/unsloth/Kimi-K3-GGUF) | UD-TQ2_0 | 514GB | downloaded, Mac attempt | **Blocked upstream.** Unsloth's custom quant types 64/65 are not decoded by any public llama.cpp tree. Do not download until engine support ships |
| Kimi K3 official checkpoint | MXFP4 safetensors | 1.56TB | Mac Mini (kimi-k3-in-c engine) | **Runs, batch-grade only.** ~3-5 min/token over a network mount; for output quality experiments, not interaction |

!!! warning "32GB machines cannot hold GLM-5.3-Flash in colibri"
    The dense weight slice alone exceeds the RAM. On a 32GB Mac, GLM comes as the 2-bit GGUFs (ran, quality cost) or not at all; the colibri containers want a 64GB+ machine.

## The path, in five steps

1. **[Download the model](downloading.md)** - with `hf download`, resumable and stall-proof.
2. **[Serve it](serving-llamacpp.md)** - `llama-server` on your own machine; NAS/docker as a side note.
3. **[Or serve the big ones](serving-colibri.md)** - colibri for GLM-5.3-Flash and GLM-5.3 on a 64GB+ machine.
4. **[Connect hummin](fleet.md)** - one env var pointing at `127.0.0.1`, one model picker.
5. **[Keep it running](operations.md)** - launchd services, co-run rules, warm caches.

Stuck? [Troubleshooting](troubleshooting.md) covers every failure we have hit, with fixes.

## The 60-second version

```bash
# 1. download (resumable; add HF_HUB_DISABLE_XET=1 if it stalls)
hf download unsloth/Qwen3.8-27B-GGUF --include "Qwen3.8-27B-UD-Q4_K_XL.gguf" \
  --local-dir ~/models/Qwen3.8-27B-GGUF

# 2. serve, on this machine
llama-server --host 127.0.0.1 --port 9998 \
  --model ~/models/Qwen3.8-27B-GGUF/Qwen3.8-27B-UD-Q4_K_XL.gguf \
  --alias qwen3.8-27b --ctx-size 65536 --jinja

# 3. connect hummin and go
export HUMMIN_COLIBRI_INSTANCES="http://127.0.0.1:9998"
hummin            # /model -> your model appears in the picker
```
