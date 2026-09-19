# Settings

hummin uses JSON settings files with project settings overriding global settings.

| Location | Scope |
|----------|-------|
| `~/.hummin/agent/settings.json` | Global (all projects) |
| `.pi/settings.json` | Project (current directory) |

Edit directly or use `/settings` for common options. To save startup model defaults interactively, use `/model` and press Ctrl+S on the desired model. To save the startup thinking level, use `/thinking` and press Ctrl+S.

## Project Trust

On interactive startup, hummin asks before trusting a project folder that contains project-local settings, resources, or project `.agents/skills` and has no saved decision for the folder or a parent folder in `~/.hummin/agent/trust.json`. Trusting a project allows hummin to load `.pi/settings.json` and `.pi` resources, install missing project packages, and execute project extensions.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, they use `defaultProjectTrust` from global settings: `ask` (default) and `never` ignore those project resources, while `always` trusts them. Pass `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

If no extension or saved decision applies, `defaultProjectTrust` controls the fallback behavior. Set it to `"ask"`, `"always"`, or `"never"` in `~/.hummin/agent/settings.json`, or change it with `/settings`.

`hummin config` and package commands use the same project trust flow, except `hummin update` never prompts. Pass `--approve` to trust project-local settings for one command or `--no-approve` to ignore them.

Use `/trust` in interactive mode to save a project trust decision for future sessions, including trust for the immediate parent folder. It writes `~/.hummin/agent/trust.json` only; the current session is not reloaded, so restart hummin for changes to take effect.

## All Settings

### Model & Thinking

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultProvider` | string | - | Startup provider (e.g., `"anthropic"`, `"openai"`; saved with Ctrl+S in `/model`, or edited manually) |
| `defaultModel` | string | - | Startup model ID (saved with Ctrl+S in `/model`, or edited manually) |
| `defaultThinkingLevel` | string | - | Startup thinking level (saved with Ctrl+S in `/thinking`, or edited manually): `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` |
| `modelThinkingLevels` | object | - | Per-model startup thinking levels keyed by `"provider/modelId"`; configure from `/settings` → Default thinking level per model or edit manually |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in output |
| `showCacheMissNotices` | boolean | `false` | Show transcript notices for significant prompt-cache misses, compaction or branch-summary usage, and provider recovery diagnostics such as dropped Anthropic thinking blocks |
| `thinkingBudgets` | object | - | Custom token budgets per thinking level. Anthropic, Google, and Bedrock use these natively. OpenAI-compatible models use them when `compat.thinkingTokenBudgetField` (or `supportsThinkingTokenBudget`) is set. |

#### thinkingBudgets

```json
{
  "thinkingBudgets": {
    "minimal": 1024,
    "low": 4096,
    "medium": 10240,
    "high": 32768
  }
}
```

### UI & Display

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `theme` | string | `"dark"` | Theme name (`"dark"`, `"light"`, or custom) |
| `externalEditor` | string | `$VISUAL`, then `$EDITOR`, then Notepad on Windows or `nano` elsewhere | Command for Ctrl+G external editor; takes precedence over environment variables |
| `quietStartup` | boolean | `false` | Hide startup header |
| `defaultProjectTrust` | string | `"ask"` | Fallback project trust behavior: `"ask"`, `"always"`, or `"never"`. Global setting only |
| `collapseChangelog` | boolean | `false` | Show condensed changelog after updates |
| `enableInstallTelemetry` | boolean | `true` | Send the anonymous install/update ping and selected provider attribution headers. This does not control update checks |
| `enableAnalytics` | boolean | `false` | Opt-in analytics data sharing. Currently only asked for during the experimental first-time setup (`PI_EXPERIMENTAL=1`) |
| `trackingId` | string | - | Analytics tracking identifier, generated when `enableAnalytics` is turned on |
| `doubleEscapeAction` | string | `"tree"` | Action for double-escape: `"tree"`, `"fork"`, or `"none"` |
| `treeFilterMode` | string | `"default"` | Default filter for `/tree`: `"default"`, `"no-tools"`, `"user-only"`, `"labeled-only"`, `"all"` |
| `editorPaddingX` | number | `0` | Horizontal padding for input editor (0-3) |
| `outputPad` | number | `1` | Horizontal padding for user messages, assistant messages, and thinking (0 or 1) |
| `autocompleteMaxVisible` | number | `5` | Max visible items in autocomplete dropdown (3-20) |
| `showHardwareCursor` | boolean | `false` | Show the terminal cursor while TUI positions it for IME support |
| `tuiMode` | string | `"regular"` | Interactive TUI mode: `"regular"` or experimental `"fullscreen"`. Changes from `/settings` apply immediately; `--tui-mode` overrides this setting at startup |
| `fullscreenExitOutput` | string | `"transcript"` | Fullscreen exit output: `"transcript"` prints the final transcript and resume hint, while `"resume-hint"` restores the previous screen and prints only the resume hint. Has no effect in regular TUI mode |
| `fullscreenScrollbar` | string | `"auto"` | Fullscreen transcript scrollbar: `"auto"` shows it temporarily while scrolling or while the pointer is over its rightmost-column track, `"always"` reserves that column and keeps it visible, and `"hidden"` hides it. Has no effect in regular TUI mode |
| `fullscreenCopyOnSelect` | boolean | `true` | Automatically copy selected text in fullscreen mode. When disabled, selections stay highlighted and `Ctrl+X` copies the active selection |

For VS Code, include `--wait` so hummin resumes after the editor exits:

```json
{
  "externalEditor": "code --wait"
}
```

### Telemetry and update checks

`enableInstallTelemetry` controls the anonymous install/update ping to `https://pi.dev/api/report-install` and attribution headers for OpenRouter, NVIDIA NIM, and Cloudflare provider requests. Opting out disables both. It does not disable update checks; hummin can still fetch `https://pi.dev/api/latest-version` to look for the latest version.

Set `PI_SKIP_VERSION_CHECK=1` to disable the version update check. Use `--offline` or `PI_OFFLINE=1` to disable all startup network operations described here, including update checks, package update checks, and install/update telemetry.

### Network

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `httpProxy` | string | - | HTTP proxy URL applied as `HTTP_PROXY` and `HTTPS_PROXY`. Global setting only. |

```json
{
  "httpProxy": "http://127.0.0.1:7890"
}
```

### Warnings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `warnings.anthropicExtraUsage` | boolean | `true` | Show a warning when Anthropic subscription auth may use paid extra usage |

```json
{
  "warnings": {
    "anthropicExtraUsage": false
  }
}
```

### Compaction

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `compaction.enabled` | boolean | `true` | Enable auto-compaction |
| `compaction.reserveTokens` | number | `16384` | Tokens reserved for LLM response |
| `compaction.keepRecentTokens` | number | `20000` | Recent tokens to keep (not summarized) |
| `compaction.modelOverrides` | object | - | Per-model `reserveTokens` and `keepRecentTokens` overrides keyed by exact `"provider/modelId"` |

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

#### Per-model compaction overrides

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000,
    "modelOverrides": {
      "some-provider/big-model": {
        "reserveTokens": 400000
      },
      "local/small-model": {
        "reserveTokens": 2048,
        "keepRecentTokens": 4096
      }
    }
  }
}
```

Keys match exact, case-sensitive `provider/modelId` values, not names or glob patterns. Model IDs may contain slashes (for example, `openrouter/anthropic/claude-sonnet-4`).

Each token setting resolves independently: matching model override → ordinary `compaction` setting → built-in default. In the example, `some-provider/big-model` keeps the ordinary 20000 recent tokens. Token values must be non-negative safe integers. Invalid values in the matching model override produce an error when read; only omitted fields fall back to the ordinary setting. Model override entries must be objects. Invalid ordinary token settings produce an error when read, even if the active model has a valid override. Only omitted ordinary values use built-in defaults. Zero is accepted, but `reserveTokens: 0` leaves no response margin and also sets the summarization output budget to zero.

Global and project settings merge recursively **before** model lookup. A project can override one field for a model without replacing its other fields or other models. A global model-specific value takes precedence over a project-wide fallback; override the same model entry in the project to change it.

`enabled` is not model-specific. The active model's token settings apply to manual compaction, automatic threshold checks (including between assistant turns), and overflow recovery. Switching models takes effect on the next check or compaction. Configure overrides in JSON; `/settings` retains the ordinary auto-compaction toggle.

See [compaction.md](compaction.md) for trigger and summarization behavior.

### Branch Summary

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved when selecting branch history; output is capped at 4096 tokens |
| `branchSummary.skipPrompt` | boolean | `false` | Skip "Summarize branch?" prompt on `/tree` navigation (defaults to no summary) |

### Retry

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `retry.enabled` | boolean | `true` | Enable automatic agent-level retry on transient errors |
| `retry.maxRetries` | number | `3` | Maximum agent-level retry attempts |
| `retry.baseDelayMs` | number | `2000` | Base delay for agent-level exponential backoff (2s, 4s, 8s) |
| `retry.maxAgentDelayMs` | number | `60000` | Max agent-level retry delay (60s) |
| `retry.provider.timeoutMs` | number | SDK default | Provider/SDK request timeout in milliseconds |
| `retry.provider.maxRetries` | number | `0` | Provider/SDK retry attempts |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Max server-requested delay before failing (60s) |

Agent-level retries use exponential backoff capped by `retry.maxAgentDelayMs`, so long retry runs stay responsive after prolonged outages.

When a provider requests a retry delay longer than `retry.provider.maxRetryDelayMs`, the request fails immediately with an informative error instead of waiting silently. Set it to `0` to disable the limit.

Keep `retry.provider.maxRetries` at `0` unless provider-level retries are explicitly needed. Setting it above `0` can make SDK/provider retries handle out-of-usage-limit errors before hummin sees them, which may block the agent until the provider quota resets in some circumstances.

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "maxAgentDelayMs": 60000,
    "provider": {
      "timeoutMs": 3600000,
      "maxRetries": 0,
      "maxRetryDelayMs": 60000
    }
  }
}
```

### Message Delivery

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `steeringMode` | string | `"one-at-a-time"` | How steering messages are sent: `"all"` or `"one-at-a-time"` |
| `followUpMode` | string | `"one-at-a-time"` | How follow-up messages are sent: `"all"` or `"one-at-a-time"` |
| `streamingSubmitMode` | string | `"steer"` | What submitting a message does while the agent is streaming: `"steer"` interrupts the current turn with the message, `"followUp"` queues it until the turn ends |
| `messageTimestamps` | boolean | `true` | Show a dim local timestamp under user and extension messages |
| `transport` | string | `"auto"` | Preferred transport for providers that support multiple transports: `"sse"`, `"websocket"`, `"websocket-cached"`, or `"auto"` |
| `httpIdleTimeoutMs` | number | `300000` | HTTP header/body idle timeout in milliseconds, also used by providers with explicit stream idle timeouts. Set to `0` to disable. |
| `websocketConnectTimeoutMs` | number | `15000` | WebSocket connect/open handshake timeout in milliseconds for providers that support WebSocket transports. Set to `0` to disable. |

### Terminal & Images

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `terminal.showTerminalProgress` | boolean | `false` | Emit OSC 9;4 terminal progress indicators while the agent works |
| `terminal.showImages` | boolean | `true` | Show images in terminal (if supported) |
| `terminal.imageWidthCells` | number | `60` | Preferred inline image width in terminal cells |
| `terminal.clearOnShrink` | boolean | `false` | Clear empty rows when content shrinks (can cause flicker) |
| `terminal.hyperlinks` | boolean or `"auto"` | `"auto"` | Override OSC 8 hyperlink support (advanced, JSON-only) |
| `terminal.images` | string or boolean | `"auto"` | Override image protocol support with `"kitty"`, `"iterm2"`, `false`, or `"auto"` (advanced, JSON-only) |
| `terminal.trueColor` | boolean or `"auto"` | `"auto"` | Override truecolor support (advanced, JSON-only) |
| `images.autoResize` | boolean | `true` | Resize images to 2000x2000 max. Applies to `@file` attachments, `read`, and images returned by tools |
| `images.blockImages` | boolean | `false` | Block all images from being sent to LLM |

### Shell

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `shellPath` | string | - | Custom shell path (e.g., for Cygwin on Windows); supports a leading `~` for the home directory |
| `shellCommandPrefix` | string | - | Prefix for every bash command (e.g., `"shopt -s expand_aliases"`) |
| `npmCommand` | string[] | - | Command argv used for npm package lookup/install operations (e.g., `["mise", "exec", "node@20", "--", "npm"]`) |

Windows paths in JSON must use forward slashes or escaped backslashes:

```json
{
  "shellPath": "C:/Program Files/Git/bin/bash.exe"
}
```

```json
{
  "shellPath": "C:\\Program Files\\Git\\bin\\bash.exe"
}
```

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

`npmCommand` is used for all npm package-manager operations, including installs, uninstalls, and dependency installs inside git packages. User-scoped npm packages install under `~/.hummin/agent/npm/`; project-scoped npm packages install under `.pi/npm/`. Use argv-style entries exactly as the process should be launched. When `npmCommand` is configured, git package dependency installs use plain `install` to avoid npm-specific flags in wrappers or alternate package managers.

### Tools

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultTools` | string[] | - | Built-in tools enabled initially. When omitted, hummin uses its standard defaults |

`defaultTools` selects the built-in tools enabled at startup. Extension and SDK custom tools remain enabled. Available built-ins are `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, and `ls`:

```json
{
  "defaultTools": ["bash", "edit", "write"]
}
```

On Windows, select `powershell` instead of `bash`, or include both:

```json
{
  "defaultTools": ["read", "powershell", "edit", "write"]
}
```

An empty array starts with no built-in tools while preserving extension and SDK custom tools. `--tools` replaces this behavior with a strict allowlist for all tools, `--no-tools` disables all tools, and `--no-builtin-tools` disables the built-in defaults. `--exclude-tools` filters the resulting list. A project `defaultTools` array replaces the global array.

### Sessions

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sessionDir` | string | - | Directory where session files are stored. Accepts absolute or relative paths, plus `~`. |

```json
{ "sessionDir": ".pi/sessions" }
```

When multiple sources specify a session directory, precedence is `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, then `sessionDir` in settings.json.

### Model Cycling

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabledModels` | string[] | - | Model patterns for Ctrl+P cycling (same format as `--models` CLI flag) |

```json
{
  "enabledModels": ["claude-*", "gpt-4o", "gemini-2*"]
}
```

### Markdown

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `markdown.codeBlockIndent` | string | `"  "` | Indentation for code blocks |
| `markdown.mermaid` | string | `"streaming"` | Mermaid rendering mode: `"off"`, `"final"`, or `"streaming"` |

### Resources

These settings define where to load extensions, skills, prompts, and themes from.

Paths in `~/.hummin/agent/settings.json` resolve relative to `~/.hummin/agent`. Paths in `.pi/settings.json` resolve relative to `.pi`. Absolute paths and `~` are supported.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `packages` | array | `[]` | npm/git packages to load resources from |
| `extensions` | string[] | `[]` | Local extension file paths or directories |
| `skills` | string[] | `[]` | Local skill file paths or directories |
| `prompts` | string[] | `[]` | Local prompt template paths or directories |
| `themes` | string[] | `[]` | Local theme file paths or directories |
| `enableSkillCommands` | boolean | `true` | Register skills as `/skill:name` commands |

Arrays support glob patterns and exclusions. Use `!pattern` to exclude. Use `+path` to force-include an exact path and `-path` to force-exclude an exact path.

#### packages

String form loads all resources from a package:

```json
{
  "packages": ["pi-skills", "@org/my-extension"]
}
```

Object form filters which resources to load:

```json
{
  "packages": [
    {
      "source": "pi-skills",
      "skills": ["brave-search", "transcribe"],
      "extensions": []
    }
  ]
}
```

See [packages.md](packages.md) for package management details.

### Providers

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `providers.showAll` | boolean | `false` | `/login` surfaces curated providers (zai, hummin) plus already-configured ones only; set `true` to list all providers |

### Compact Prompt

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `compactPrompt` | boolean | `false` | Condense tool descriptions and system-prompt guidance to cut fixed prompt overhead (useful for slow-prefill local models) |

## hummin Settings

These fork-only namespaces are read by hummin extensions. Unless noted, `HUMMIN_*` environment variables override the stored settings.

### Memory (project memory + vault)

Session distillation into lessons and the knowledge-graph vault. See `/memory`.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `memoryEnabled` | boolean | `false` | Enable project-memory distillation (experimental). `HUMMIN_MEMORY=1`/`0` overrides |
| `memoryMode` | string | `"lesson"` | `"lesson"` (per-session lessons) or `"vault"` (knowledge-graph vault). `HUMMIN_MEMORY_MODE` overrides |
| `memoryVaultDir` | string | `~/.hummin/agent/vault` | Where the vault lives. `HUMMIN_MEMORY_VAULT_DIR` overrides |
| `memoryProvider` | string | `"zai"` | Provider for vault fold + distillation calls. `HUMMIN_MEMORY_PROVIDER` overrides |
| `memoryModelId` | string | `"glm-5.3-flash"` | Model id for vault fold + distillation calls. `HUMMIN_MEMORY_MODEL_ID` overrides |

Spawned distill/fold children always run with `HUMMIN_MEMORY=0` so the shutdown handler cannot recurse.

### Local Fleet

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `localInstances` | string[] | `["http://127.0.0.1:9998", "http://127.0.0.1:9997"]` | Local inference server base URLs for the hummin provider. `HUMMIN_INSTANCES` (comma-separated) overrides; `colibriInstances` is a deprecated pre-rename alias |
| `fleet` | object | - | Ordered local inference fleet; drives `/fleet`, `/status`, and the provider catalog. Empty when unconfigured (no built-in fleet) |

#### fleet

Server list order is priority: when several servers serve the same model, the first match wins.

```json
{
  "fleet": {
    "launchd": { "domain": "gui/501", "plistDir": "~/Library/LaunchAgents" },
    "docker": { "sshHost": "user@inference.example", "composeDir": "/srv/inference" },
    "servers": [
      {
        "id": "mac-qwen",
        "label": "Qwen 3.8 27B",
        "host": "Mac",
        "hostIp": "inference.example",
        "port": 8080,
        "kind": "docker",
        "target": "model-server",
        "engine": "llamacpp",
        "models": [{ "id": "qwen3.8-27b", "contextWindow": 32768 }]
      }
    ]
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `servers[].id` | string | Stable identifier (e.g. `"mac-qwen"`) |
| `servers[].label` | string | Display label; defaults to the id |
| `servers[].host` | string | Display host name; defaults to `hostIp` |
| `servers[].hostIp` | string | Routable IP/hostname used to build the OpenAI-compatible base URL |
| `servers[].port` | number | Port of the OpenAI-compatible endpoint |
| `servers[].kind` | string | `"launchd"` or `"docker"`; service manager used for probe/start/stop/restart |
| `servers[].target` | string | launchd service label, or docker compose service/container name |
| `servers[].engine` | string | `"llamacpp"` (default) or `"colibri"` (the external container engine) |
| `servers[].models` | array | Staged models this server serves (`{ id, contextWindow }`); fills the picker catalog while the server is off |
| `launchd.domain` | string | launchd domain; defaults to the current user's GUI domain (`gui/<uid>`) |
| `launchd.plistDir` | string | Directory holding the LaunchAgents plists; defaults to `~/Library/LaunchAgents` |
| `docker.sshHost` | string | SSH target of the docker host (e.g. `"user@host"`, `"localhost"` for local docker) |
| `docker.composeDir` | string | Docker compose project directory on the docker host |

`HUMMIN_FLEET_SSH_HOST`, `HUMMIN_FLEET_COMPOSE_DIR`, `HUMMIN_FLEET_LAUNCHD_DOMAIN`, and `HUMMIN_FLEET_PLIST_DIR` override the corresponding fleet fields. Per-model context windows come from the server's `/props`, with `HUMMIN_CTX` as fallback.

### MCP Servers

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `mcpServers` | object | - | stdio MCP servers exposed as tools, named `mcp_<server>_<tool>`. Project entries win per name and require project trust. `HUMMIN_MCP=0` disables the extension |

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "..." },
      "cwd": "/path/to/dir"
    }
  }
}
```

All fields are optional except `command`. Offline servers dim in `/mcp` and never register guessed tools.

### Agents (inter-session messaging)

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `agents.enabled` | boolean | `true` | Inter-session messaging across terminals and projects. `HUMMIN_AGENTS=0` forces off |
| `agents.name` | string | - | Session registry name. `HUMMIN_AGENTS_NAME` overrides |

### Bash Guard

Command classification that blocks clearly mutating or dangerous bash commands with in-band, actionable messages (not a sandbox). See `/bashguard`.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `bashguard.block` | boolean | `false` | Block known dangerous command patterns. `HUMMIN_BASHGUARD=0` disables the extension |
| `bashguard.readOnly` | boolean | `false` | Block mutating commands (read-only session mode) |
| `bashguard.exempt` | string[] | `[]` | Regex strings; a match against the raw command skips all checks. Invalid patterns are skipped (fail-open) |

### Sandbox

Sandboxed bash via a macOS seatbelt profile in `workspace` mode: writes limited to the working directory and `$TMPDIR`, network access follows the `network` field. See `/sandbox`.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sandbox.mode` | string | `"off"` | `"off"` or `"workspace"`. `HUMMIN_SANDBOX=0\|workspace` overrides the mode |
| `sandbox.network` | string | `"allow"` | `"allow"` or `"deny"` |
| `sandbox.fallback` | string | `"block"` | What happens when the sandbox cannot start: `"block"` (fail-closed) or `"allow"` (fail-open) |

### Editor Mode

Modal (vim-style) editing for the input editor. `HUMMIN_VIM=1` overrides the setting.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `editorMode` | string | `"default"` | `"default"` or `"vim"`. In vim mode: Escape enters NORMAL (motions `h j k l 0 $ w b e gg G`, edits `x dw dd cw`, `yy`/`p`, `u` undo), `i`/`a`/`o` return to INSERT. A dim `-- INSERT --` / `-- NORMAL --` indicator renders on the editor border |

### Custom Statusline

User-ordered footer segments. When `statusline` has at least one non-empty side, it replaces the fixed footer rows. Known tokens: `dir`, `repo`, `branch`, `model`, `provider`, `ctx`, `tokens`, `cost`, `queue`, `background`, `sandbox`, `mcp`, `git`, `diff`. Unknown tokens render dim as-is.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `statusline.left` | string[] | `[]` | Left-aligned segment tokens (empty array falls back to the fixed layout) |
| `statusline.right` | string[] | `[]` | Right-aligned segment tokens |

## Example

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "defaultThinkingLevel": "medium",
  "modelThinkingLevels": {
    "anthropic/claude-sonnet-4-20250514": "high"
  },
  "theme": "dark",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3
  },
  "enabledModels": ["claude-*", "gpt-4o"],
  "warnings": {
    "anthropicExtraUsage": true
  },
  "packages": ["pi-skills"]
}
```

## Project Overrides

Project settings (`.pi/settings.json`) override global settings. Nested objects are merged:

```json
// ~/.hummin/agent/settings.json (global)
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 16384 }
}

// .pi/settings.json (project)
{
  "compaction": { "reserveTokens": 8192 }
}

// Result
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 8192 }
}
```
