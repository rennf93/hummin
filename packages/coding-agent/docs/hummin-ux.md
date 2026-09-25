# hummin commands and fleet settings

## Fleet

`/fleet` lists configured inference servers and offers Start, Stop, and Restart.
`/status` reports the selected model, context window, fleet health, memory,
todo progress, and TUI mode. Health means the service manager reports the
process running; a model may still be loading.

Define servers in the `fleet` section of global or project settings. There is
no built-in fleet. Put preferred servers first. Server order determines fleet
display and local model preference; each host remains separately selectable.

```json
{
  "fleet": {
    "docker": {
      "sshHost": "user@inference.example",
      "composeDir": "/srv/inference"
    },
    "servers": [
      {
        "id": "workstation",
        "label": "Workstation model server",
        "host": "Workstation",
        "hostIp": "inference.example",
        "port": 8080,
        "kind": "docker",
        "target": "model-server",
        "engine": "llamacpp"
      }
    ]
  }
}
```

Supported service managers are `launchd` and Docker Compose over SSH. `target`
is the launchd label or Docker Compose service/container name. SSH and sudo
must work without interactive prompts. For launchd, the domain defaults to
the current user's GUI domain and plist paths to `~/Library/LaunchAgents`.
Override these with `fleet.launchd.domain` and `fleet.launchd.plistDir`.

Environment overrides:

- `HUMMIN_FLEET_SSH_HOST`
- `HUMMIN_FLEET_COMPOSE_DIR`
- `HUMMIN_FLEET_LAUNCHD_DOMAIN`
- `HUMMIN_FLEET_PLIST_DIR`

Model discovery uses `HUMMIN_INSTANCES` when set, then configured fleet
servers, then the `localInstances` setting. To show a known model while its
server is stopped, add an explicit `models` array to that server:

```json
"models": [{ "id": "your-server-model-alias", "contextWindow": 32768 }]
```

Use IDs your server actually advertises. Live discovery takes precedence;
context windows come from `/props`, with `HUMMIN_CTX` as fallback
(`HUMMIN_COLIBRI_CTX` is also accepted).
Offline labels reflect discovery at extension load. After starting a server,
reload extensions to discover its current models.

Local response budgets use the available context window after accounting for
the prompt and a safety margin. Thinking and answer text share that budget;
reasoning models are no longer limited to 4,096 output tokens by the provider.

## Memory

With memory enabled, submit `# remember this` to capture a note in
`<vault>/inbox/`. It does not start an agent turn. `/memory` shows memory state,
vault location, entity counts, inbox and processed counts, and recent fold
entries. Existing `/vault-fold`, `/vault-recall`, and `/vault-canvas` commands
remain available in vault mode.

## Project setup and diagnostics

`/init` prepares project instructions from the README, package metadata,
top-level directory names, and existing instructions using one cloud model
call. Review the generated text before saving. Existing `AGENTS.md` requires
confirmation before replacement.

`/doctor` checks settings, fleet services, ZAI authentication, loaded extensions,
and vault Git status.

## Session export

`/export` writes a Markdown session transcript in the current project.
Supply a path to choose its destination. Explicit `.html` and `.jsonl` paths
retain the existing export formats.

## Background tasks and Monitor

`task` accepts `fast` (cloud default), `local` (first available online fleet
model), or an exact `provider/model` ID. IDs retain their case and any slashes
in the model name. An invalid working directory or unavailable model is an
error; tasks do not silently run elsewhere. `background: true` returns an ID
and delivers a completion notification. `task_status` reads its output and
`task_cancel` cancels it.

Local inference uses a per-server lock shared by processes using the same
agent directory, held until streaming finishes. Waiting and busy retries are
cancellable. The lock uses the endpoint origin as its key: configure the same
hostname consistently. Different machines and non-hummin clients still depend
on server-side serialization. A crashed holder's lease expires after two minutes.

### Laya child-dispatch review

When enabled, Hummin reviews `task` and `cron_create` before the child starts.
The review gives the Laya System-1 service the child prompt and the named
provider/model/thinking configurations available from the real runtime catalog.
Laya chooses one of those configurations using the profile description, speed,
cost, and thinking depth. `fast`, `local`, and an omitted model resolve through
the normal child-model selection rules; the review does not invent model IDs or
cross providers to manufacture a recommendation.

Each catalog entry is a real provider/model/thinking configuration. Profile
metadata may describe a configuration without changing its identity:

```json
{
  "provider": "zai",
  "modelId": "glm-5.3",
  "description": "strong reasoning for multi-step implementation",
  "speed": "normal",
  "cost": { "input": 1, "output": 4 },
  "thinkingLevels": ["off", "low", "medium", "high"]
}
```

The profile fields are descriptive metadata: `description`, `speed`, numeric
`cost.input` and `cost.output`, and the supported `thinkingLevels`. They are
matched by exact `provider` and `modelId`; the runtime catalog remains the
source of truth and an unknown model is never fabricated. The settings key
`layaRightSize.swingThreshold` (default `0.6`, global or project) controls when a
mismatch blocks: the gate compares the confidence mass of Laya's pick against
the requested configuration's mass (its margin) and blocks when the margin meets
the threshold. With no per-label probabilities the margin degrades to absolute
confidence. `/settings` exposes the gate under Fleet: enabled flag, swing
threshold, and a profile editor (add, delete, and per-profile text/toggle
fields). `HUMMIN_LAYA_RIGHTSIZE=off` and
`HUMMIN_LAYA_RIGHTSIZE_SWING` override the setting for one process.

The selected child thinking level is passed through to `hummin -p`. A review can
therefore identify a thinking-level or model-profile mismatch.
A high-confidence mismatch pauses dispatch and reports the suggested real
configuration plus a review ID; the parent may continue only with an explicit
override reason tied to that review. A lower-confidence mismatch is advisory
and the child runs with the requested configuration. If Laya is disabled,
unavailable, times out, or returns an unusable answer, the review fails open and
the child proceeds. The audit is recorded in `laya-gate.log`.

This is a Hummin feature. Pi is the upstream project Hummin is built on; Pi's
own model-selection documentation does not define this Laya review or the
Hummin fleet capability metadata.

### Laya bash gate

Before a bash command runs, the gate classifies it in three tiers. Read-only
allowlist commands (`ls`, `git log`, `curl` GET, `npm run check`, ...) pass
without a read. Deterministic classifiers then handle the enumerable ends:
additive writes (`git add`/`commit`, `git checkout -b`, plain `git push`,
repo-relative `cp`/`rsync` installs, `rm -rf` of build/dist/node_modules/cache
dirs) pass, while canonical discards (`git reset --hard`, `git clean -f`,
`git checkout -- <paths>`, `git stash drop/clear`, `git branch -D`,
`git push --force`, `DROP DATABASE/TABLE`, `mkfs`, `rm -rf` of home or glob
targets) block without a read. Everything else - unfamiliar commands and mixed
chains - is scored by a Laya yes/no read and blocked once at P >= 0.7
(`layaGateThreshold` setting, `HUMMIN_LAYA_GATE_THRESHOLD` env). A block tells
the model to confirm with the user or verify the target is backed up, then
re-run with a `# laya-gate: confirmed` marker; confirmations are audited in
`laya-gate.log`. All failure modes fail open: dead Laya never blocks.

Measured constraint (laya 0.3.20): gate reads route to the english checkpoint
(512-token context), so long rubrics truncate from the tail, and instruction
edits past the head do not move scores. The deterministic classifiers, not the
prompt, carry the precision; routing reads to the multilingual checkpoint
saturates every command to P >= 0.87 and cannot discriminate.

The `monitor` tool runs a shell watch and delivers output without model polling:

```json
{"action":"start","command":"exec tail -f app.log","match":"ERROR","interval_sec":5,"timeout_sec":3600}
```

Use `action: "status"` or `"stop"` with its `id`; omit the ID to inspect or stop
all monitors in the session. Filters match literal, case-sensitive text.
Notifications contain at most 20 lines / about 4,000 characters, suppress
consecutive duplicates, and batch every 5 seconds by default. Each notification
can trigger a model turn. These are command results, not instructions.

Tasks and monitors drain stdout/stderr, keep an 8,000-character tail, and write
the first 1 MiB to private logs under the agent directory. Each manager allows
eight active processes. Normal session shutdown/reload cancels owned children,
with TERM followed by KILL after 1.5 seconds if needed. Task IDs are session-local;
logs survive restarts. Use `exec` for watches so cancellation owns the actual
program. Descendant daemons are not killed by process-name or process-tree searches.
Concurrent writing tasks should use separate working directories. Plan mode
blocks spawning tasks and starting monitors as well as direct write/shell tools.

## Clear and rewind

`/clear` starts a new session, preserving saved history and project files.

`/rewind` selects an earlier prompt on the active branch and offers files,
conversation, or both. File restoration requires review. Snapshots cover changes
made by this session's `edit` and `write` tools, including original uncommitted
content and files newly created by those tools. Shell changes, subagent edits,
and external effects are outside coverage. Stop background writers first.

Rewind checks all selected files before restoring any. If a file changed after,
or between, tracked edits, it reports a conflict. Symlinks, hard links, `.git`,
files outside the project, and files larger than 2 MiB are excluded with a notice.
Restoration is not a filesystem transaction: an I/O failure during application
reports which files were already restored. Avoid simultaneous external writes.

Snapshots are stored under `<agentDir>/checkpoints/blobs` with references in
session history. They survive restarts and use content hashes to share identical
copies. Session startup removes blobs unused for 30 days, preserving and refreshing
every blob referenced by the open session. Reusing a snapshot also refreshes its
age. Older sessions can lose file-rewind coverage after that retention period;
their conversation history remains available. Moving/exporting a session alone
does not copy its blobs.

## Queued messages and preferences

`/queue` lists steering and follow-up messages, including messages waiting for
compaction. Enter restores the selected message to the editor; the configured
delete key removes it. Restored images appear as paths to private temporary files,
the same representation used for clipboard images. A message already delivered
while the picker was open cannot remove a different queued message.

The footer shows `queue N` while messages are pending. `/settings` includes:

- **Enter while streaming**: steer the current run or queue a follow-up.
- **Message timestamps**: show or hide timestamps, including existing messages.

Prompt and command history persists per project, with at most 500 distinct entries.
New sessions remember the project's last available model without changing global
model defaults.

Mouse interaction works in regular terminal mode: click selector rows and completed
tool blocks, place the editor cursor, or click the pending-message hint to open
`/queue`. Hold Shift to use the terminal's native text selection and scrollback.

## Offline benchmark checks

The `Hummin offline bench` workflow runs on pushes and pull requests targeting
`main` or `zcode`, nightly on the default branch, and on manual dispatch. It validates
fixture sensitivity and tests runner/metric accounting without provider credentials
or model calls.

## Remote control

`/remote-control` starts an authenticated browser interface for the current
session and displays its URL. It shows recent conversation text, streams the
current response through periodic refreshes, accepts queued prompts, and stops
the active response. Approval dialogs stay in the terminal. Slash-command
expansion is disabled for remote prompts. `/remote-control stop`, session
replacement, reload, or shutdown revokes access by stopping the listener.

The endpoint binds to `127.0.0.1` on an ephemeral port. For another computer,
forward that port through SSH, then open the complete URL on that computer:

```sh
ssh -N -L <port>:127.0.0.1:<port> user@your-workstation
```

The URL fragment contains a private access token. Reconnecting within the same
running session uses that URL; restarting remote control creates a new token.
The browser strips the token from its address bar after loading. Keep the original
URL for reloads. Requests require the token, enforce same-origin checks, limit
body sizes, and deduplicate recent prompt retries. No public relay is configured.

## Agent teamwork

Sessions on the same machine (any terminals, any projects) can message each other. A broker socket at `<agentDir>/agents/broker.sock` coordinates presence; the first session to start serves the rest.

- `agent_send` / `agent_inbox` tools: send text to a session by name (offline targets queue in `<agentDir>/agents/inbox/`, replayed FIFO on next start, capped). Incoming messages are data, never executed.
- `/agents` shows online sessions (name, project, uptime) and this session's name; `/agent-name <name>` renames this session persistently.
- `/team` is a shared task board (`<agentDir>/agents/team-board.json`): add/claim/release/done/delete tasks, visible to every session; the `task_board` tool drives it.
- Sessions register only in trusted projects. `HUMMIN_AGENTS=0` disables; `agents.name` in settings sets a stable name.

## Parity and safety features

- `/mcp` connects Model Context Protocol servers configured under `mcpServers` in settings (stdio transport; project servers require trust). Tools register as `mcp_<server>_<tool>`; crashed servers unregister with a notice and can restart from `/mcp`.
- `/sandbox` toggles sandboxed bash: macOS seatbelt profile or Linux bubblewrap, writes limited to the working directory and `$TMPDIR`, secrets unreadable, optional network deny (`sandbox.network: "deny"`). Probes real capability; blocks with an actionable `[Sandbox]` message when workspace mode is on but no mechanism exists. `sandbox.mode: "workspace"` enables; spawned task children inherit the mode.
- `/bashguard` advises on risky commands before they run (destructive `rm -rf`, force-push to main/master, out-of-cwd `sed -i`, write redirections), via in-band `[BashGuard]` notices. Blocking and a read-only deny mode are opt-in (`bashguard.block`, `bashguard.readOnly`).
- `hooks.json` (global `<agentDir>/hooks.json`, project `.hummin/hooks.json` with trust) runs shell commands on `tool_call`, `tool_result`, `agent_start`, `agent_end`. A `tool_call` hook's JSON output `{block: true, reason}` blocks the call. `/hooks` lists and reloads.
- `/background` (or `ctrl+b`) opens the panel of running background tasks and monitors with view-tail/cancel actions; the footer shows counts by kind.
- `# <text>` captures a note to the vault inbox without starting a turn (memory enabled).

## Usage visibility and questions

- `/context` breaks down the current prompt: system prompt and tools (estimated), conversation tokens (exact), cache-hit ratio, remaining window, and the compaction trigger line.
- `/cost` totals the session by model with a served-locally ($0) vs cloud split.
- `ask_user` asks structured multiple-choice questions through the TUI: the marked choice renders as `(recommended)`, free text is always available (select Other... or press tab and type inline; esc returns to the list), and non-interactive sessions default to the recommended choice.
- `/lsp` runs a TypeScript language server when available (`typescript-language-server` on PATH): `lsp_diagnostics`, `lsp_definition`, `lsp_references`, `lsp_hover` tools with 1-based coordinates. Requires a `tsconfig.json` or `jsconfig.json` in the project.
- `/cron` schedules wake-ups: `cron_create` with a daily `HH:MM` or `every:<minutes>` schedule runs `hummin -p <prompt>` detached in the entry's project directory. `HUMMIN_CRON=0` disables.
- `/fleet` lists configured inference servers with Start/Stop/Restart; selecting an offline fleet model in `/model` offers to start its server first (`fleet.autoStart: true` skips the prompt).
- Memory recall ranks lessons with BM25 (rare-term discrimination) plus phrase and recency bonuses; the retrieval briefing stays capped at 3 lessons / 2000 chars.
