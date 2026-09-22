# Serving with colibri

[Colibri](https://github.com/JustVugg/colibri) (C, Apache-2.0) runs frontier MoE models that are far bigger than your RAM. Its core idea: a 321B Mixture-of-Experts model mostly streams the same small slice of experts per token, so colibri keeps dense weights in RAM and reads the experts it needs from fast storage on demand. VRAM/RAM/disk become one memory hierarchy; a GPU is optional.

## What it reads (and what it does not)

- **Reads**: directories of `.safetensors` shards in colibri's int4 group-64 format, plus `config.json` and tokenizer files.
- **Does not read**: GGUF. It is not llama.cpp, not Ollama, and no amount of conversion tools changes that.

The GLM-5.3 family ships as first-class colibri containers:

| Container | Size | License |
|---|---|---|
| [`Justvugg/GLM-5.3-Flash-colibri-int4-g64`](https://huggingface.co/Justvugg/GLM-5.3-Flash-colibri-int4-g64) | ~195GB, 62 shards | MIT |
| [`Justvugg/GLM-5.3-colibri-int4-g64`](https://huggingface.co/Justvugg/GLM-5.3-colibri-int4-g64) | ~114GB, 38 shards | custom glm-5.3 license (fine for personal use, check terms for commercial) |

## Install

Grab the prebuilt runtime for your platform from the [releases page](https://github.com/JustVugg/colibri/releases):

```bash
# Linux x86_64 example:
mkdir -p ~/colibri && cd ~/colibri
curl -LO https://github.com/JustVugg/colibri/releases/download/v1.10.2/colibri-v1.10.2-linux-x86_64.tar.gz
tar xzf colibri-v1.10.2-linux-x86_64.tar.gz -C ~/colibri
python3 ~/colibri/colibri/coli info      # only python3 is required
```

If the prebuilt binary fails on your distro (glibc mismatch), build from source:

```bash
sudo apt update && sudo apt install -y build-essential git python3
git clone https://github.com/JustVugg/colibri ~/colibri-src
cd ~/colibri-src/c && ./setup.sh
```

## Verify the hardware and the model

```bash
export COLI_MODEL=/path/to/GLM-5.3-Flash-colibri-int4-g64
python3 ~/colibri/coli doctor --deep   # RAM, disk speed, container, engine
python3 ~/colibri/coli plan            # where weights and experts will live
python3 ~/colibri/coli tune            # best execution profile for this disk/CPU
```

Fix anything red before continuing. **Fast storage matters**: experts are read from disk on every token, so disk speed is speed. NVMe beats SATA beats network storage.

## Chat before you serve

Fastest sanity check, no HTTP involved:

```bash
COLI_MODEL=$COLI_MODEL python3 ~/colibri/coli chat --topp 0.85
```

First tokens can be slow (experts cold from disk); it warms up as colibri caches hot experts in RAM.

## Serve

```bash
export COLI_API_KEY=$(openssl rand -hex 24)
echo "Save this key somewhere safe: $COLI_API_KEY"

COLI_MODEL=$COLI_MODEL COLI_API_KEY=$COLI_API_KEY \
  python3 ~/colibri/coli serve --host 0.0.0.0 --port 9998 --no-browser
```

Knobs that matter:

| Knob | Effect |
|---|---|
| `--ram 48` (or `RAM_GB=48`) | Hot-expert cache budget. Leave headroom for the OS and everything else on the box |
| `CTX=16384` | Context window (default 4096). Raise gradually, watch RAM |
| `NGEN=512` | Max new tokens per reply (default 256) |
| `--topp 0.85` | Fewer expert bytes per token - a documented free speed win |
| `--kv-slots 16` | Persistent KV prefix reuse across requests, useful for repeated long system prompts |

## API surface

The server speaks two protocols:

- **OpenAI**: `/v1/models`, `/v1/chat/completions`, `/v1/completions` - any OpenAI SDK or curl works
- **Anthropic**: `/v1/messages` - Anthropic-protocol tools can point at it directly
- **Health**: `/health`

Streaming (SSE) and tool calling are supported. **One generation runs at a time per instance**; extra requests wait in a bounded queue and get HTTP 429 when it is full. Need parallelism? Run a second instance on another port with its own `--ram` budget - and expect 2-3x total throughput, not Nx, because instances share the same disk pipe.

## Expectations

- ~0.5-3 tok/s warm for GLM-5.3-Flash on a 4-core NAS with 128GB RAM. This is "frontier model, slow sip" territory: treat it as on-demand depth, not the default model.
- The first generation after a start can take up to an hour (cold page cache). Keep it running and warm; restarting resets the expensive part.
- The GLM-5.3-Flash model is multimodal, but colibri's API is text-only - image inputs return HTTP 400.

Next: [connect hummin to your servers](fleet.md).
