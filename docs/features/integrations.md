# Integrations

hummin meets the rest of your toolchain without plugins-by-GUI: MCP, LSP, web, and a full automation surface.

## MCP client

Model Context Protocol servers configured under `mcpServers` (stdio JSON-RPC). Their tools appear as model-callable `mcp_<server>_<tool>` entries.

```text
/mcp       # server status + restart
```

## TypeScript LSP

When `typescript-language-server` is available, the model gets real language tools instead of grep-shaped guessing:

| Tool | Purpose |
|---|---|
| `lsp_diagnostics` | Type errors, live |
| `lsp_definition` | Jump to definition |
| `lsp_references` | Find all references |
| `lsp_hover` | Type info |

```text
/lsp       # server status + restart
```

## Web

- `web_search` - DuckDuckGo search
- `web_fetch` - fetch with an **SSRF guard** (internal addresses and metadata endpoints are refused)

## cc-tg-hub Telegram bridge

With a [cc-tg-hub](https://github.com/rennf93/cc-tg-hub) broker running (installed once with `bunx cc-tg-hub setup`), `TG_HUB=1 hummin` registers the session with the broker and makes it drivable from your phone:

- One Telegram forum topic per session; messages arrive as user input (steering the current turn when one is running).
- A `tg_reply` tool answers the topic.
- Tools listed in `TG_HUB_ASK_TOOLS` (or `tgHub.askTools`) raise **Allow/Deny** buttons before they run - Deny blocks the call; Allow never bypasses a terminal dialog, so pair it with `--approve` for fully unattended use.

Claude Code sessions and hummin sessions can share one broker, one bot, one poller. One broker per machine (Telegram allows one `getUpdates` poller per bot token). Claude Code sessions need their own flag: `claude --dangerously-load-development-channels server:cc-tg-hub`.

## Extensions

TypeScript extensions in `~/.hummin/agent/extensions/` autoload at startup with hot reload and a transform cache. This is the mechanism behind the local fleet provider - see [Connecting to hummin](../local-models/fleet.md) - and it is the same API available to yours.

## Prompt templates, skills, packages

- **Skills** follow the Agent Skills standard: `/skill:<name>`.
- **Prompt templates** become first-class slash commands.
- **Packages** install from npm or git: `hummin package install|remove|update|list`.

## Automation surface

- **SDK** for embedding, **RPC mode** and **JSON event mode** for scripts.
- **`hooks.json`** for shell-level lifecycle automation (see [Safety](safety.md)).
- **Cron** for scheduled wake-ups (see [Agent Teamwork](teamwork.md)).
- `/remote-control` - loopback browser view of the session with prompt/abort, for when you want to drive from a phone-shaped window on the same machine.
