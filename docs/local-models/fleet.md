# Connecting to hummin

hummin ships a bundled extension that turns every OpenAI-compatible server on your LAN - colibri, llama.cpp, Ollama, anything - into entries in **one model picker**, with per-server serialization, health probing and real context windows. The engine behind each server does not matter.

## 1. Point hummin at your servers

One environment variable, comma-separated, **order is preference**: the first server serving a model wins, later duplicates become automatic fallbacks.

```bash
# ~/.zshrc
export HUMMIN_COLIBRI_INSTANCES="http://nas:9996,http://nas:9998,http://mac:9998"
export COLI_API_KEY=your-key               # omit if servers run keyless
```

| Variable | Purpose |
|---|---|
| `HUMMIN_COLIBRI_INSTANCES` | Server base URLs; duplicates dedupe into one picker entry with fallback ordering |
| `COLI_API_KEY` | Bearer token; a placeholder is sent for keyless servers |
| `HUMMIN_COLIBRI_CTX` | Fallback context window (default 16384), used only when a server does not report one |

!!! tip "Use IPs, not `.local` names"
    mDNS is flaky on mixed Linux networks. Your Pis and NAS will silently disappear from discovery on bad days; IP addresses do not.

## 2. Start hummin and pick a model

```bash
hummin
/model
```

What you will see:

- Every model found on any configured server, in one namespace, with a **host badge** (e.g. `Qwen3.8-27B [NAS]`).
- Unreachable servers contribute **no models** until a session restart - no guessed placeholder ids.
- Offline catalog entries are marked `(offline)`; selecting one offers to **start its server** if the fleet is configured (see below).
- The `/model` picker's "set as default" action works for local models exactly like cloud ones.

## 3. Discovery and context windows

- Model ids come from each server's own `/v1/models` - the server is the source of truth, hummin invents nothing.
- Context windows are read from each server's `/props` when available. llama.cpp serves it; colibri does not, so colibri models use `HUMMIN_COLIBRI_CTX`.
- Discovery happens at **session start**. After starting or stopping a server, run `/reload` or restart the session.
- If the picker shows a wrong context size, the server was still loading during discovery - restart the session once the server is up.

## 4. Concurrency is handled, not thrown at you

Local servers are single-file by nature (colibri generates one reply at a time; llama.cpp queues by KV budget). The extension:

- **Serializes per server**: one in-flight request per origin, no manual queuing on your side.
- **Retries 429** busy responses with capped backoff.
- **Fails over**: if a server is down or dies mid-request, the next server in `HUMMIN_COLIBRI_INSTANCES` serving the same model takes over. Deliberately narrow: model-level errors (context overflow, bad request) surface to you instead of cascading across every host.

## 5. Reasoning controls

Qwen-family models map hummin's thinking level onto `chat_template_kwargs.enable_thinking`, which llama.cpp applies per request:

```text
/thinking off     # direct answers, zero reasoning tokens
/thinking high    # deeper reasoning
```

The default is ON (medium). Other model families register without thinking controls.

## 6. The fleet: start and stop servers from hummin

If you register servers in settings under `fleet.servers[]`, hummin health-probes them and gives you a control panel:

- `/fleet` - every inference server with **Start / Stop / Restart** actions
- `/status` - fleet health dashboard alongside model, memory and todos
- Start-from-picker: selecting an offline fleet model offers to start its server (readiness-gated; `fleet.autoStart` skips the confirm)

Supported control: launchd on the Mac, docker-over-SSH on Linux hosts. This is how the model picker and your actual services stay in sync.

## 7. Client-side tuning for slow models

- Set `httpIdleTimeoutMs: 0` (disabled) for local models - slow prefills otherwise look like dead connections.
- hummin's own prompt is ~5.4K tokens (system + tools). llama.cpp's prefix cache absorbs that across turns in one session; the first request of a session pays it.
- `/cost` splits local-served (free) from cloud spend, so you can see what your fleet is saving you.

Next: [keeping servers running](operations.md).
