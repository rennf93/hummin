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
context windows come from `/props`, with `HUMMIN_COLIBRI_CTX` as fallback.
Offline labels reflect discovery at extension load. After starting a server,
reload extensions to discover its current models.

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
copies. There is currently no automatic pruning; keep snapshots while their
sessions may need rewind. Moving/exporting a session alone does not copy its blobs.

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
