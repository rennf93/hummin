# Troubleshooting

Every failure we have actually hit with local models and hummin, with the fix.

## Downloads

| Symptom | Fix |
|---|---|
| Download stalls at 0% with live processes | Xet transfer hang. Kill the exact PIDs (never a pattern kill), relaunch with `HF_HUB_DISABLE_XET=1` |
| `hf` command not found | `export PATH="$HOME/.local/bin:$PATH"`, or use legacy `huggingface-cli download` (same arguments) |
| pip refuses to install (externally managed env) | Add `--break-system-packages` |
| Download interrupted | Just re-run the same `hf download` command - it resumes |

## Serving

| Symptom | Fix |
|---|---|
| `unknown model architecture: 'glm5next'` | The GGUF's architecture is newer than your llama.cpp build (GLM-5.3 is still unmerged upstream). Use the colibri container instead |
| llama-server dies with `invalid ggml type` | The GGUF's quant format is newer than your llama.cpp build; wait for engine support or use a more standard quant |
| llama.cpp slow on an efficiency-core CPU | Set `--threads` to the real core count |
| Mac OOM when loading a huge MoE | `--n-gpu-layers 0` - Metal buffers for giant models are a guaranteed crash |
| launchd server cannot find model files on an external disk | TCC EPERM on `/Volumes` listings. Exact paths, or a home-dir mount point (`~/mnt/ai-models`) |
| First token takes forever on the NAS | Cold colibri cache (up to 1h) or slow CPU prefill - keep it warm, use the fast machine for interactive work |
| colibri restart is slow again | A restart resets the warm expert cache, which is the expensive part. Don't bounce it casually |
| External disk sleeps mid-generation (Mac) | `sudo pmset -a disksleep 0`, or run under `caffeinate` |
| Port already in use | `lsof -iTCP -sTCP:LISTEN`, pick another port, keep the [convention](operations.md#ports) |

## hummin client

| Symptom | Fix |
|---|---|
| Model missing from the picker | Its server was unreachable at session start. Fix the server, then `/reload` or restart the session |
| Picker shows the wrong context size | Server was still loading during discovery; `/props` is only read at session start. Restart the session |
| HTTP 401 | Key mismatch between server and client. Test scripts must export the same key as the server; keyless servers accept any placeholder |
| HTTP 429 | Server mid-generation. The extension retries automatically; if you hit it raw with curl, just retry |
| "Connection error" but the server is up | Client missing the API key, or mDNS: switch `.local` hostnames to IP addresses |
| Slow prefill looks like a dead connection | Set `httpIdleTimeoutMs: 0` (disabled) for local models |
| Wrong model answered | Two servers serve the same id; the first in `HUMMIN_COLIBRI_INSTANCES` wins. Reorder by preference |
| Context overflow errors | The picker's context window came from the fallback (`HUMMIN_COLIBRI_CTX`) because the server does not report one. Set it to the real window |

## Quick diagnostics

```bash
# is the server up?
curl -s -H "Authorization: Bearer KEY" http://HOST:PORT/health

# does it know the model?
curl -s -H "Authorization: Bearer KEY" http://HOST:PORT/v1/models

# does it actually generate? (colibri, first time: be patient)
curl -s http://HOST:PORT/v1/chat/completions \
  -H "Authorization: Bearer KEY" -H "Content-Type: application/json" \
  -d '{"model":"ALIAS","messages":[{"role":"user","content":"Say hi in 5 words"}]}'

# inside hummin
/doctor      # settings, fleet, credentials, extensions
/status      # fleet health at a glance
/context     # token breakdown with cache-hit ratio
```

If raw curl works and hummin does not, the problem is client config (env vars, session not restarted). If curl fails, fix the server first - hummin can only show what the server exposes.
