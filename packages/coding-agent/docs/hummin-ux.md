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

Model discovery uses `HUMMIN_COLIBRI_INSTANCES` when set, then configured fleet
servers, then the `colibriInstances` setting. To show a known model while its
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
