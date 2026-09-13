# Local inference with colibri

hummin is built to work against a local colibri server, so you can run GLM-5.3 and GLM-5.3-Flash on your own hardware and point the agent at it. This is a hardware-agnostic walkthrough: any x86_64 Linux machine or Apple Silicon Mac works. No cloud account required.

[Colibri](https://github.com/JustVugg/colibri) is a standalone inference engine for Mixture-of-Experts models. It keeps dense weights in RAM and streams expert weights from disk on demand, which means big models run on modest machines - at modest speed. A GPU is optional.

## 1. Sizing: can your machine run it?

| Model | colibri container | Download | Disk | Notes |
|---|---|---|---|---|
| GLM-5.3-Flash | `Justvugg/GLM-5.3-Flash-colibri-int4-g64` | ~195 GB | ~195 GB + a few GB runtime files | daily driver |
| GLM-5.3 | `Justvugg/GLM-5.3-colibri-int4-g64` | ~114 GB | ~114 GB | flagship |

- **RAM**: works from ~16 GB, comfortable at 32 GB. More RAM means a bigger hot-expert cache and faster warm responses.
- **Disk**: a fast NVMe SSD is strongly recommended. Colibri reads experts from disk on every token, so disk speed is speed. Put the model on NVMe if you can; a fast external SSD works on Mac.
- **CPU**: anything reasonable; the workload is mostly streaming plus modest compute.
- **Speed expectations**: roughly 0.5-2 tok/s warm on typical hardware. This is a "frontier model, slow sip" setup - great for agent runs, not for interactive chat. Measure on your machine with `coli tune`.

## 2. Install colibri

Prebuilt binaries are on the [releases page](https://github.com/JustVugg/colibri/releases) (check it for the latest version):

```bash
# Linux x86_64 (use colibri-vX-linux-x86_64.tar.gz on Mac: macos-arm64)
mkdir -p ~/colibri && cd ~/colibri
curl -LO https://github.com/JustVugg/colibri/releases/download/v1.10.2/colibri-v1.10.2-linux-x86_64.tar.gz
tar xzf colibri-v1.10.2-linux-x86_64.tar.gz -C ~/colibri
cd colibri
python3 coli info
```

Only Python 3 is needed on top (the engine is C, the launcher is Python). If the prebuilt binary fails on your distro, build from source:

```bash
sudo apt install -y build-essential git python3
git clone https://github.com/JustVugg/colibri ~/colibri-src
cd ~/colibri-src/c
./setup.sh
make glm53
```

## 3. Download a model container

Colibri reads its own int4 safetensors containers (not GGUF). Downloads are resumable - re-run the same command if interrupted. If the download hangs at 0%, disable the Xet transfer path (`export HF_HUB_DISABLE_XET=1`) and retry.

```bash
python3 -m pip install --user -U huggingface_hub
export PATH="$HOME/.local/bin:$PATH"

hf download Justvugg/GLM-5.3-Flash-colibri-int4-g64 \
  --local-dir ~/colibri-models/GLM-5.3-Flash-colibri-int4-g64
```

Debian 12+ may refuse `pip install` with an "externally managed environment" error; add `--break-system-packages` to the pip call, or use a venv.

## 4. Verify, tune, chat

```bash
export COLI_MODEL=~/colibri-models/GLM-5.3-Flash-colibri-int4-g64
python3 ~/colibri/coli doctor --deep    # checks RAM, disk, container
python3 ~/colibri/coli plan             # shows weight/expert placement
python3 ~/colibri/coli tune             # measures the best profile for your disk
COLI_MODEL=$COLI_MODEL python3 ~/colibri/coli chat --topp 0.85
```

First replies can be slow (experts cold from disk); it warms up as colibri caches hot experts in RAM. `--topp 0.85` reads fewer expert bytes per token - the documented speed tip.

## 5. Serve on the network

```bash
export COLI_API_KEY=$(openssl rand -hex 24)   # save this; hummin will need it
COLI_MODEL=$COLI_MODEL COLI_API_KEY=$COLI_API_KEY \
  python3 ~/colibri/coli serve --host 0.0.0.0 --port 9998 --no-browser
```

Endpoints: `/v1/models`, `/v1/chat/completions` (OpenAI), `/v1/messages` (Anthropic protocol), `/health`. One generation runs at a time; extra requests queue, and overflow gets HTTP 429. Clients authenticate with `Authorization: Bearer $COLI_API_KEY`.

Pick an uncommon port (colibri uses 9998/9997 in the examples below). Repeat with a second terminal and a second `COLI_MODEL`/port to serve both models.

### Keep it running (Linux, systemd)

```ini
# /etc/systemd/system/colibri.service
[Unit]
Description=Colibri OpenAI-compatible server (GLM-5.3-Flash)
After=network-online.target

[Service]
User=youruser
Environment=COLI_MODEL=/home/youruser/colibri-models/GLM-5.3-Flash-colibri-int4-g64
Environment=COLI_API_KEY=your-key
Environment=RAM_GB=100
Environment=CTX=16384
ExecStartPre=/usr/bin/test -f /home/youruser/colibri-models/GLM-5.3-Flash-colibri-int4-g64/config.json
ExecStart=/usr/bin/python3 /home/youruser/colibri/coli serve --host 0.0.0.0 --port 9998 --no-browser
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now colibri
```

`RAM_GB` caps how much RAM colibri claims (leave headroom for everything else on the box); `CTX` sets the context window (default 4096; 16384 fits coding-agent prompts, more costs RAM). On macOS, run the same command under `tmux` or a launchd plist.

## 6. Connect hummin

```bash
export HUMMIN_COLIBRI_INSTANCES="http://your-server:9998,http://your-server:9997"
export COLI_API_KEY=your-key                   # omit if the server runs keyless
hummin -e /path/to/hummin/packages/coding-agent/extensions/colibri.ts
```

Then `/model` and pick a `colibri` entry. Each instance becomes a provider; models are discovered from `/v1/models` automatically. The extension serializes requests per instance and retries the documented busy response (429 + `x-colibri-queue-wait-ms`) with capped backoff.

Environment variables:

| Variable | Purpose |
|---|---|
| `HUMMIN_COLIBRI_INSTANCES` | comma-separated server base URLs (default: two local instances on 9998/9997) |
| `COLI_API_KEY` | bearer token; placeholder is sent for keyless servers |
| `HUMMIN_COLIBRI_CTX` | advertised context window per model (default: 16384) |

`-e` loads the extension for one run. To install it persistently, use `hummin install /path/to/packages/coding-agent/extensions/colibri.ts` (built-in autoload is on the roadmap; see [SPEC-ZCODE-CLI.md](SPEC-ZCODE-CLI.md)).

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| Download stalls at 0% | `export HF_HUB_DISABLE_XET=1`, re-run the download (it resumes) |
| Prebuilt binary fails to start | build from source (step 2) |
| `doctor` complains about disk speed | move the model to NVMe; this directly buys tokens/s |
| HTTP 429 from the server | the instance is mid-generation; the hummin extension retries automatically |
| HTTP 401 | `COLI_API_KEY` mismatch between server and client |
| Port already in use | pick another port in `serve` and in `HUMMIN_COLIBRI_INSTANCES` |
| Everything works but it is slow | that is the design point of colibri: check `coli tune`, keep the model on NVMe, raise RAM |

## 8. Running both models

Download both containers and run one `serve` per model on different ports (e.g. 9998 for Flash, 9997 for GLM-5.3). hummin lists them as separate providers and the picker groups them first. Each server generates one response at a time; running two servers doubles your concurrency ceiling, though they share the same disk pipe.
