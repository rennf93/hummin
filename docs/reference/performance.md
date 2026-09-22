# Measured performance

Real numbers from a working homelab, so you can calibrate expectations against actual hardware instead of marketing. Measure your own with `coli tune` (colibri) or a timed completion (llama.cpp) - treat these as order-of-magnitude guides.

## Hardware reference

| Machine | Specs | Role in the fleet |
|---|---|---|
| UGREEN NAS | Intel N150 (4 efficiency cores), 128GB RAM, 2x1TB NVMe (RAID 1) | Always-on API server for the whole LAN |
| Mac Mini | Apple M2 Pro, 32GB RAM, external NVMe SSD | Interactive host, second copy of models |

## Generation speed

| Setup | Measured | Reading |
|---|---|---|
| Qwen3.8-27B Q4_K_XL, M2 Pro (Metal) | ~7-10 tok/s generation, ~54 tok/s prompt processing | The interactive daily driver |
| Qwen3.8-27B, 4-core efficiency CPU only | ~1.5 tok/s | Batch/fallback host, not interactive |
| GLM-5.3-Flash colibri, N150 NAS, warm | ~0.5-3 tok/s | On-demand depth; cold first generation after start up to ~1h |
| Ornith-1.5-35B-A3B (~3B active), M2 Pro | 20+ tok/s expected | Fast MoE, solo on the 32GB machine |

## Networking

| Path | Measured | Implication |
|---|---|---|
| NAS-to-Mac over 2.5GbE (ssh pipe) | ~282 MB/s sustained | Move models over the LAN freely, ~1TB in an hour |
| HF WAN download, 8 workers (NAS) | ~14.4 MB/s aggregate | 195GB in ~4h |
| HF WAN download, Mac single-stream | ~1.3 MB/s | **Never download big models on the Mac directly** |
| NAS volume read | ~438 MB/s | Fine for colibri expert streaming |

## Rules of thumb

- **KV cache**: ~64KB/token (llama.cpp, q8 KV). 64K ctx is ~4GB, 262K is ~17GB. Size `--ctx-size` to RAM headroom, not ambition.
- **Prefix caching**: hummin's own prompt is ~5.4K tokens; llama.cpp's prefix cache absorbs that across turns. The first request of a session pays it.
- **Colibri concurrency**: one generation per instance. A second instance gives 2-3x total throughput, not 2x - instances share the disk pipe.
- **Cold vs warm**: colibri cold starts are brutal (page cache empty); warm runs settle. Do not restart colibri casually.
- **Local is for patience**: coding-agent loops, batch jobs, privacy-sensitive work. Interactive back-and-forth wants the fast model on the fast machine, or the cloud.
