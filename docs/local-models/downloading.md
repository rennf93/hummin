# Downloading models

All model downloads use the [Hugging Face CLI](https://huggingface.co/docs/huggingface_hub). Every download is **resumable**: if anything interrupts it, re-run the same command and it picks up where it left off.

## 1. Install the CLI

```bash
python3 -m pip install --user -U "huggingface_hub[cli]"
export PATH="$HOME/.local/bin:$PATH"
```

If `hf` is not found, the legacy command is `huggingface-cli download` with identical arguments. If pip complains about an externally managed environment, add `--break-system-packages`.

## 2. Pick the right files

**GGUF models** - download one quant file with `--include`:

```bash
hf download unsloth/Qwen3.8-27B-GGUF --include "Qwen3.8-27B-UD-Q4_K_XL.gguf" \
  --local-dir ~/models/Qwen3.8-27B-GGUF
```

**Colibri containers** - download the whole directory (do not filter, the engine needs every shard plus `config.json`):

```bash
hf download Justvugg/GLM-5.3-Flash-colibri-int4-g64 \
  --local-dir ~/models/GLM-5.3-Flash-colibri-int4-g64
```

Quant size guide for GGUF: Q4_K_M / UD-Q4_K_XL are the sweet spot for quality per gigabyte. Below Q3 quality falls fast; above Q5 the size doubles for a difference you will not notice in a terminal.

## 3. Download on the machine with the WAN pipe

This is the single biggest time save in the whole process. On one homelab, a NAS sustained **~14.4 MB/s** aggregate with 8 parallel workers while a Mac single-stream managed only **1.3 MB/s**. For a 195GB container, that is the difference between half a day and a month.

- Download big models on the NAS/server, then move them over the LAN (2.5GbE shifts ~282 MB/s via `rsync` or `ssh`).
- The HF CLI parallelizes internally; let it.
- Disk space check before you start: a GLM-5.3-Flash container is ~195GB (62 shards), the flagship ~114GB (38 shards).

## 4. Long downloads: the nohup pattern

Anything over an hour should run detached, logging to a file:

```bash
nohup env HF_HUB_DISABLE_XET=1 hf download Justvugg/GLM-5.3-Flash-colibri-int4-g64 \
  --local-dir /volume1/ai-models/colibri/GLM-5.3-Flash-colibri-int4-g64 \
  > download.log 2>&1 &

# watch progress:
tail -f download.log
du -sh /volume1/ai-models/colibri/GLM-5.3-Flash-colibri-int4-g64
```

!!! warning "Stopping a download"
    Kill the **exact PIDs** you started (captured at launch), never a name-pattern kill like `pkill -f hf` - you will take out unrelated processes.

!!! warning "If the download stalls at 0% with live processes"
    That is a Xet transfer hang. Kill the exact PIDs and relaunch with `HF_HUB_DISABLE_XET=1`. Every long download we run uses this flag up front.

## 5. Verify before trusting

Not all uploads are healthy. Before serving a freshly downloaded model:

```bash
# GGUF: check the file size against the HF page, then just load it
# colibri containers: use the engine's own checks
COLI_MODEL=/path/to/GLM-5.3-Flash-colibri-int4-g64 coli doctor --deep
COLI_MODEL=/path/to/GLM-5.3-Flash-colibri-int4-g64 coli plan
```

`doctor` checks RAM, disk, the model container and the engine; `plan` shows where weights and experts will be placed. One broken republish shipped whole shard ranges empty, so a tensor census against `config.json` is worth the minute on first download.

Next: [serve it](serving-llamacpp.md).
