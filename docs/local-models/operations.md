# Keeping servers running

A model you start by hand in a terminal dies with the terminal. This page covers running servers as real services, and the operating rules that keep a multi-model machine healthy.

## The rules (learned the hard way)

1. **Solo on small-RAM machines.** Two GGUF servers on a 32GB Mac fight for page cache and both degrade. Check who is resident before starting another:

   ```bash
   ps aux | grep llama-server
   ```

2. **CPU-only for giant MoE GGUFs on the Mac.** `--n-gpu-layers 0` is mandatory in the service definition: Metal buffers for a 500GB-class model are a guaranteed OOM, and it takes down whatever else is generating - we lost a live session to exactly this.

3. **Never glob `/Volumes/*` in launchd scripts on macOS.** Processes started by launchd get TCC `EPERM` on directory listings under `/Volumes` on external disks, and llama-server must *list* a multi-shard model's directory to discover its parts. Two fixes that work:
   - Use **exact absolute paths** for the model file.
   - For network shares, mount **under your home directory** (`~/mnt/ai-models`), which avoids the whole class of failure:

     ```bash
     mkdir -p ~/mnt/ai-models
     mount_smbfs //user@nas.local/ai-models ~/mnt/ai-models
     ```

4. **Keep colibri warm.** The first generation after a colibri start can take up to an hour (cold page cache); a restart resets the warm cache, which is the expensive part. Restart llama.cpp freely - it warms in seconds.

5. **Stop things by exact PID, never by pattern.** Applies to downloads, servers, anything long-running.

## Mac: launchd template

Save as `~/Library/LaunchAgents/com.hummin.mymodel.plist` (full annotated version in [Server Templates](../reference/templates.md)):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.hummin.mymodel</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/llama-server</string>
    <string>--host</string><string>0.0.0.0</string>
    <string>--port</string><string>9990</string>
    <string>--model</string><string>/exact/path/to/model.gguf</string>
    <string>--alias</string><string>mymodel</string>
    <string>--ctx-size</string><string>65536</string>
    <string>--jinja</string>
    <string>--api-key</string><string>YOURKEY</string>
  </array>
  <key>RunAtLoad</key><false/>
  <key>KeepAlive</key><dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>StandardOutPath</key><string>~/Library/Logs/mymodel-llm.log</string>
  <key>StandardErrorPath</key><string>~/Library/Logs/mymodel-llm.log</string>
</dict>
</plist>
```

`RunAtLoad=false` + `KeepAlive` on failed exit means: starts on demand, restarts on crash, does not hog RAM at boot.

Control it:

```bash
launchctl load   ~/Library/LaunchAgents/com.hummin.mymodel.plist
launchctl start  com.hummin.mymodel        # logs: ~/Library/Logs/mymodel-llm.log
launchctl stop   com.hummin.mymodel
launchctl unload ~/Library/LaunchAgents/com.hummin.mymodel.plist
launchctl kickstart gui/501/com.hummin.mymodel   # quick restart while loaded
```

Keep `com.hummin.*` as the label convention - it makes your fleet greppable: `launchctl list | grep hummin`.

Also worth knowing on a Mac that sleeps: stop the external disk from sleeping mid-generation with `sudo pmset -a disksleep 0`, or run long sessions under `caffeinate`.

## Linux: docker compose

`restart: unless-stopped` + the official `ghcr.io/ggml-org/llama.cpp:server` image (see the [compose example](serving-llamacpp.md#as-a-docker-service-linux-nas)). Restart containers freely; the model directory is a read-only mount.

## Ports

One port per service, documented, never reused casually. A convention that works:

| Range | Use |
|---|---|
| 9990-9995 | Mac GGUF services (one per model) |
| 9996 | Linux/NAS llama.cpp |
| 9997 | colibri GLM-5.3 flagship |
| 9998 | colibri GLM-5.3-Flash / interactive daily driver |
| 9999 | reserved (UGOS nginx on UGREEN NAS - never use) |
| 11434 | Ollama |

Pick from 9990 upward, checking what is free first (`lsof -iTCP -sTCP:LISTEN`).

## First smoke test for any new service

1. Co-run check: only the new server starting.
2. `curl -s -H "Authorization: Bearer KEY" http://127.0.0.1:PORT/health`
3. `curl -s -H "Authorization: Bearer KEY" http://127.0.0.1:PORT/v1/models` - your alias is there.
4. One chat completion, timed.
5. In hummin: `/reload`, confirm the model appears with no `(offline)` badge.

Back to: [troubleshooting](troubleshooting.md) when something fights back.
