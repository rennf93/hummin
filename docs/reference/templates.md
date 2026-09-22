# Server templates

Copy-paste starting points for running local models as real services. Adjust paths, ports and keys; read the surrounding pages for the flags that matter ([llama.cpp](../local-models/serving-llamacpp.md), [colibri](../local-models/serving-colibri.md)).

## Mac: launchd plist (llama.cpp)

Save as `~/Library/LaunchAgents/com.hummin.mymodel.plist`:

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

```bash
launchctl load   ~/Library/LaunchAgents/com.hummin.mymodel.plist
launchctl start  com.hummin.mymodel        # logs: ~/Library/Logs/mymodel-llm.log
launchctl stop   com.hummin.mymodel
launchctl unload ~/Library/LaunchAgents/com.hummin.mymodel.plist
launchctl kickstart gui/501/com.hummin.mymodel   # quick restart while loaded
```

!!! warning
    `--model` must be an **exact absolute path**. launchd processes get TCC EPERM listing `/Volumes/*` external disks, and llama-server must list a multi-shard model's directory to discover its parts. For network shares, mount under your home directory.

Add `--n-gpu-layers 0` before `--jinja` for giant MoE GGUFs - Metal on those is a guaranteed OOM.

## Linux: docker compose (llama.cpp)

```yaml
services:
  qwen-27b:
    image: ghcr.io/ggml-org/llama.cpp:server
    container_name: qwen-27b
    restart: unless-stopped
    ports: ["9996:9996"]
    volumes: ["/volume1/ai-models/llama.cpp:/models:ro"]
    command: ["--host", "0.0.0.0", "--port", "9996",
              "--model", "/models/Qwen3.8-27B-UD-Q4_K_XL.gguf",
              "--alias", "qwen3.8-27b", "--ctx-size", "262144",
              "--threads", "4", "--jinja", "--api-key", "YOURKEY"]
```

## Linux: systemd (colibri)

```ini
[Unit]
Description=colibri OpenAI-compatible server (GLM-5.3-Flash)
After=network-online.target

[Service]
User=youruser
Environment=COLI_MODEL=/volume1/ai-models/colibri/GLM-5.3-Flash-colibri-int4-g64
Environment=COLI_API_KEY=PASTE_YOUR_KEY_HERE
Environment=CTX=16384
ExecStart=/usr/bin/python3 /opt/colibri/coli serve --host 0.0.0.0 --port 9998 --no-browser
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now colibri-flash.service
systemctl status colibri-flash.service
```

One unit per model: distinct port and its own `RAM_GB`/`--ram` budget, leaving headroom for the OS and Docker.

## Long downloads (any host)

```bash
nohup env HF_HUB_DISABLE_XET=1 hf download REPO/NAME \
  --local-dir /path/to/model \
  > download.log 2>&1 &
```

Watch with `tail -f download.log` and `du -sh`; stop by exact PID only.

## Verify any of the above

```bash
curl -s -H "Authorization: Bearer KEY" http://127.0.0.1:PORT/health
curl -s -H "Authorization: Bearer KEY" http://127.0.0.1:PORT/v1/models
```

Then in hummin: `/reload` and confirm the model shows with no `(offline)` badge.
