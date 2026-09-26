# Environment Variables

hummin uses environment variables in three ways:

- Variables such as `PI_OFFLINE` configure the hummin process.
- hummin sets process markers so child processes can identify hummin as the launching agent.
- Commands run by the LLM-callable shell tools receive session-state variables describing the current session.

Fork-specific `HUMMIN_*` variables are documented in [hummin Process Configuration](#hummin-process-configuration) below. Unless noted there, a `HUMMIN_*` variable overrides the corresponding settings.json value (env beats settings).

Provider API-key variables are documented separately in [Provider Authentication](providers.md#use-an-api-key-from-the-environment).

## Process Marker

The CLI and RPC entry points set two process markers:

- `AI_AGENT=hummin` is a generic marker that lets tooling identify hummin as the agent that launched the process.
- `PI_CODING_AGENT=true` and `HUMMIN_CODING_AGENT=true` let child processes detect that they run inside hummin.

Child processes inherit these markers. They are not session-specific and are not set automatically when hummin is embedded through the SDK.

## Shell Tool Session Environment

Commands run by the `bash` and `powershell` tools receive the current hummin session state:

| Variable | Description |
|----------|-------------|
| `PI_SESSION_ID` | Current session ID |
| `PI_SESSION_FILE` | Absolute path to the current session JSONL file; unset for ephemeral sessions |
| `PI_PROVIDER` | Currently selected model provider |
| `PI_MODEL` | Currently selected model ID |
| `PI_REASONING_LEVEL` | Current effective reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |

The values are resolved when each command starts. Switching models or changing the reasoning level therefore affects the next shell command without restarting hummin. `PI_PROVIDER` and `PI_MODEL` identify the selected model, not a different upstream model that a router may choose internally.

When asked which model or provider is running, inspect these variables instead of inferring the answer from the system prompt:

```bash
printf '%s/%s\n' "$PI_PROVIDER" "$PI_MODEL"
printf 'reasoning=%s session=%s\n' "$PI_REASONING_LEVEL" "$PI_SESSION_ID"
```

The session file can be inspected directly when the session is persistent:

```bash
if [ -n "$PI_SESSION_FILE" ]; then
  tail -n 1 "$PI_SESSION_FILE"
fi
```

These variables are injected into the LLM-callable `bash` and `powershell` tools. They are not injected into user-entered `!` or `!!` commands.

### Custom Shell Tools

Tools created with `createBashTool()` or `createPowerShellTool()` expose the session environment by default when registered with hummin. Injection happens before `spawnHook`, so a hook receives the variables in `ctx.env`:

```typescript
const bashTool = createBashTool(cwd, {
  spawnHook: (ctx) => ({
    ...ctx,
    env: { ...ctx.env, CI: "1" },
  }),
});
```

Disable session metadata independently of the spawn hook:

```typescript
const powershellTool = createPowerShellTool(cwd, {
  exposeSessionEnvironment: false,
  spawnHook: (ctx) => ctx,
});
```

When disabled, hummin removes inherited values for these variables so nested processes do not expose stale parent-session metadata.

## Process Configuration

These variables are read by hummin itself:

| Variable | Description |
|----------|-------------|
| `PI_CODING_AGENT_DIR` | Override the config directory; default is `~/.hummin/agent` |
| `PI_CODING_AGENT_SESSION_DIR` | Override session storage; overridden by `--session-dir` |
| `PI_PACKAGE_DIR` | Override the package directory, useful for Nix/Guix store paths |
| `PI_OFFLINE` | Disable automatic network activity, including model catalog refreshes |
| `PI_SKIP_VERSION_CHECK` | Disable the `pi.dev` latest-version request |
| `PI_TELEMETRY` | Override install/update telemetry and provider attribution headers: `1`/`true`/`yes` or `0`/`false`/`no` |
| `PI_CACHE_RETENTION` | Set to `long` for extended provider prompt caching where supported |
| `PI_SHARE_VIEWER_URL` | Override the base URL used by `/share` |
| `PI_RADIUS_GATEWAY` | Override the Radius gateway origin used by `/bug` uploads and Radius relay connections |
| `PI_HARDWARE_CURSOR` | Set to `1` to show the hardware cursor; see [Terminal setup](terminal-setup.md) |
| `PI_HYPERLINKS` | Override OSC 8 hyperlink detection with `1`, `0`, or `auto` |
| `PI_IMAGE_PROTOCOL` | Override inline image detection with `kitty`, `iterm2`, `none`, or `auto` |
| `PI_TRUE_COLOR` | Override truecolor detection with `1`, `0`, or `auto` |
| `PI_TUI_ESC_TIMEOUT` | How long to wait after a lone ESC before treating it as Escape, in milliseconds; defaults to `100` over SSH and `10` otherwise. Increase if Alt-key input is misread as Escape |
| `VISUAL`, `EDITOR` | External editor fallback when `externalEditor` is unset |
| `HTTP_PROXY`, `HTTPS_PROXY` | Proxy outbound HTTP requests |

Provider credentials such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and cloud-provider configuration are listed in [Provider Authentication](providers.md#use-an-api-key-from-the-environment).

## hummin Process Configuration

These fork-specific variables are read by hummin and its bundled extensions. Where a settings.json key exists, the `HUMMIN_*` variable overrides it (env beats settings).

### Memory

| Variable | Description |
|----------|-------------|
| `HUMMIN_MEMORY` | `1` enables project-memory distillation, `0` forces it off; overrides `memoryEnabled` (default off, experimental). Spawned distill/fold/cron children always run with `HUMMIN_MEMORY=0` so their shutdown handlers cannot recurse |
| `HUMMIN_MEMORY_MODE` | `lesson` or `vault`; overrides `memoryMode` (default `lesson`) |
| `HUMMIN_MEMORY_DIR` | Lesson storage dir; default `<agentDir>/memory` |
| `HUMMIN_MEMORY_VAULT_DIR` | Vault directory; overrides `memoryVaultDir` (default `~/.hummin/agent/vault`) |
| `HUMMIN_MEMORY_PROVIDER` | Provider for the no-model-selected fallback of fold/distill/expansion calls; overrides `memoryProvider` (default `zai`). The session's selected model wins when one is selected |
| `HUMMIN_MEMORY_MODEL_ID` | Model id for the same fallback; overrides `memoryModelId` (default `glm-5.3-flash`) |
| `HUMMIN_MEMORY_QUERY_EXPAND` | `0` disables model-assisted query expansion in memory recall and vault search |
| `HUMMIN_MEMORY_EMBED` | `0` disables embeddings hybrid retrieval (`memoryEmbed: false` is equivalent) |
| `HUMMIN_MEMORY_EMBED_URL` | OpenAI-shaped embeddings endpoint for hybrid recall; overrides `memoryEmbedUrl`. Unset: the first fleet server is probed once for `/v1/embeddings` |
| `HUMMIN_MEMORY_TOOLS` | `1` loads the memory extension tools-only (vault search + `/memory`, no recall injection, no distill/fold) even though `HUMMIN_MEMORY=0`; set for spawned `task` and cron children |
| `HUMMIN_MEMORY_AUTO_FOLD_THRESHOLD` | Inbox lesson count that triggers an automatic fold pass; default `3`, `0` disables |
| `HUMMIN_MEMORY_MAX_CHARS` | Transcript tail (characters) passed to the distiller; default `12000` |

### Local fleet and provider

| Variable | Description |
|----------|-------------|
| `HUMMIN_INSTANCES` | Comma-separated local inference server base URLs for the hummin provider; overrides `localInstances` |
| `HUMMIN_COLIBRI_INSTANCES` | Pre-rename fallback for `HUMMIN_INSTANCES` |
| `HUMMIN_CTX` | Fallback context window (tokens) for fleet models when the server's `/props` does not report one and no fresh `fleet-health.json` entry exists |
| `HUMMIN_COLIBRI_CTX` | Pre-rename fallback for `HUMMIN_CTX` |
| `HUMMIN_FLEET_HEALTH_FILE` | Overrides the fleet health file path (default `<agentDir>/fleet-health.json`) |
| `HUMMIN_TELEMETRY` | `0` disables the local telemetry event sink |
| `HUMMIN_FLEET_SSH_HOST` | Overrides `fleet.docker.sshHost` |
| `HUMMIN_FLEET_COMPOSE_DIR` | Overrides `fleet.docker.composeDir` |
| `HUMMIN_FLEET_LAUNCHD_DOMAIN` | Overrides `fleet.launchd.domain` |
| `HUMMIN_FLEET_PLIST_DIR` | Overrides `fleet.launchd.plistDir` |
| `HUMMIN_FLEET_AUTOSTART` | `1`/`0` forces fleet autostart on/off |

### Extensions

| Variable | Description |
|----------|-------------|
| `HUMMIN_SANDBOX` | `workspace` enables sandboxed bash, `0`/`off` forces it off; overrides `sandbox.mode` |
| `HUMMIN_BASHGUARD` | `0` disables the bashguard extension |
| `HUMMIN_GUARDRAILS` | `0` disables the guardrails extension |
| `HUMMIN_AGENTS` | `0` forces inter-session messaging off; overrides `agents.enabled` |
| `HUMMIN_AGENTS_NAME` | Overrides the session registry name (`agents.name`) |
| `HUMMIN_CRON` | `0` disables the cron scheduler; tools stay registered and no-op with an in-band notice |
| `HUMMIN_MCP` | `0` disables the MCP extension |
| `HUMMIN_JITI_CACHE` | `0` disables the extension loader's jiti transform cache |

### Guardrails tool-call budget

Disabled by default; opt in by setting `HUMMIN_BUDGET_TOOL_CALL_HALT_AT`.

| Variable | Description |
|----------|-------------|
| `HUMMIN_BUDGET_TOOL_CALL_HALT_AT` | Tool calls per turn before the guardrail halts the run (`0` = off, the default) |
| `HUMMIN_BUDGET_TOOL_CALL_WARN_AT` | Warn threshold (`0` = off) |
| `HUMMIN_BUDGET_LOOP_THRESHOLD` | Identical-call count inside the window that counts as a loop (default `3`) |
| `HUMMIN_BUDGET_LOOP_WINDOW` | Loop-detection window in seconds (default `10`) |
| `HUMMIN_BUDGET_PER_TOOL_WINDOW_MS` | Rolling per-tool window in milliseconds (default `60000`) |
| `HUMMIN_BUDGET_PER_TOOL_RETRY_LIMIT` | Per-tool retry limit inside the window (default `8`) |
| `HUMMIN_BUDGET_EXEMPT_VERBS` | Comma-separated tool verbs exempt from budget checks (default `read,grep,find,ls`) |
| `HUMMIN_BUDGET_ABSOLUTE_RETRY_MULTIPLIER` | Multiplier applied to the session-absolute retry cap (default `3`) |

### Other

| Variable | Description |
|----------|-------------|
| `HUMMIN_OFFLINE` | `1` disables startup network operations (alias of `PI_OFFLINE`, same as `--offline`) |
| `HUMMIN_ALLOW_UPSTREAM_UPDATE` | `1` allows `hummin update self` to replace this fork with upstream pi; blocked by default (update with `git pull` in your clone instead) |
| `HUMMIN_VIM` | TUI editor | `1` selects vim modal editing (same as `editorMode: "vim"`) |
| `HUMMIN_CODING_AGENT` | Set to `true` by hummin entry points; child-process marker |
| `HUMMIN_SHARE_VIEWER_URL` | Override the base URL used by `/share` |
| `HUMMIN_COMPACT_PROMPT_AUTO` | `0` disables automatic compact prompt mode for models with a context window at or below 32768 tokens |
| `AI_AGENT` | Generic agent marker set to `hummin` for child processes |
