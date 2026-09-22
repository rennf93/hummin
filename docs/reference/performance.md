# Measured performance

Real numbers from our test bench, so you can calibrate expectations against actual hardware instead of marketing. The two machines the numbers come from:

- **Mac Mini (Apple M2 Pro, 32GB unified memory)** - the interactive machine. Apple Silicon: CPU, GPU and RAM on one package.
- **UGREEN DXP6800 Pro NAS (Intel N150, 4 efficiency cores, 128GB RAM, 2x1TB NVMe in RAID 1)** - the always-on box. The N150 is a weak CPU; its value is 128GB of RAM and uptime, not speed.

Measure your own with `coli tune` (colibri) or a timed completion (llama.cpp); treat these as order-of-magnitude guides.

## Generation speed by model and machine

| Model | Format | Machine | Measured / expected | Reading |
|---|---|---|---|---|
| North Mini Code 1.0 (UD-Q4_K_XL) | GGUF | Mac Mini (M2 Pro) | Fast, high quality for bulk | Best bulk worker tested: classification, digests, triage |
| North Mini Code 1.0 | GGUF | NAS (N150, docker) | Usable, CPU-bound | Always-on fallback for batch work |
| Ornith 1.5 35B-A3B (Q4_K_M) | GGUF | Mac Mini | 20+ tok/s expected (~3B active) | Fast MoE; must run solo on 32GB |
| Nemotron 3.5 Lightning 30B-A3B (UD-Q4_K_XL) | GGUF | Mac Mini | Fast, but long reasoning chains | Overthinks; exclude unless deep reasoning is the point |
| Qwen3.8-27B (UD-Q4_K_XL) | GGUF | Mac Mini (M2 Pro, Metal) | ~7-10 tok/s generation, ~54 tok/s prompt processing | Good interactive coder |
| Qwen3.8-27B (UD-Q4_K_XL) | GGUF | NAS (N150, 4 threads) | ~1.5 tok/s | Always-on fallback, not interactive; too slow for bulk automation |
| GLM-5.3-Flash (colibri int4 g64) | container | NAS (N150, 128GB) | ~0.5-3 tok/s warm; first generation after a cold start up to ~1h | On-demand depth, not a daily driver |
| GLM-5.3-Flash (UD-IQ2_XXS) | GGUF | Mac Mini (CPU-only) | Ran; slow, 2-bit quality | The colibri container is the better GLM path |
| Kimi K3 (UD-TQ2_0) | GGUF | - | Unloadable | Unsloth quant types 64/65 unsupported by every public llama.cpp tree |
| Kimi K3 (official MXFP4, kimi-k3-in-c) | safetensors | Mac Mini, model over network mount | ~3-5 min/token | Batch-grade only; quality experiments |

## Networking (homelab side note)

| Path | Measured | Implication |
|---|---|---|
| NAS-to-Mac over 2.5GbE (ssh pipe) | ~282 MB/s sustained | Move models over the LAN freely, ~1TB in an hour |
| HF WAN download, 8 workers (NAS) | ~14.4 MB/s aggregate | 195GB in ~4h |
| HF WAN download, Mac single-stream | ~1.3 MB/s | Download big models on whichever host has the better WAN pipe |
| NAS volume read | ~438 MB/s | Fine for colibri expert streaming |

## Rules of thumb

- **KV cache**: ~64KB/token (llama.cpp, q8 KV). 64K ctx is ~4GB, 262K is ~17GB. Size `--ctx-size` to RAM headroom, not ambition.
- **Prefix caching**: hummin's own prompt is ~5.4K tokens; llama.cpp's prefix cache absorbs that across turns. The first request of a session pays it.
- **Colibri concurrency**: one generation per instance. A second instance gives 2-3x total throughput, not 2x - instances share the disk pipe.
- **Cold vs warm**: colibri cold starts are brutal (page cache empty); warm runs settle. Do not restart colibri casually.
- **CPU is the real baseline**: RAM decides *whether* a model runs; the CPU decides *how fast*. An N150 and an M2 Pro hold the same model at wildly different speeds - which is why every table here names the chip.
- **Local is for patience**: coding-agent loops, batch jobs, privacy-sensitive work. Interactive back-and-forth wants the fast model on the fast machine, or the cloud.
