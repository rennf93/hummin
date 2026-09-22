# Agent teamwork

Multiple hummin sessions working as a team - across terminal tabs, projects, and even scheduled wake-ups. No external orchestrator: sessions talk to each other through a local broker.

## Messaging between sessions

- `agent_send` / `agent_inbox` - sessions message each other directly. Delivery into a session is a follow-up message that starts (or queues) a turn.
- `/agents` - who is online, inbox view, rename.
- `/agent-name` - persist this session's broker name so others can address it.
- Offline inbox per target: 100 entries / 1MiB, 20 FIFO replay on reconnect, rate-limited 10/60s per peer.
- `@project:<dir>` broadcasts to every session working in a project.

The broker is a Unix-domain socket at `~/.hummin/agent/agents/broker.sock` (0700/0600). The first session binds it; later sessions connect as clients; stale sockets are rebound automatically.

## Shared task board

```text
/team
```

A shared cross-session task board (JSON store with PID-liveness locks): add, claim, release, complete, delete tasks from any session in any project. The canonical pattern: one session decomposes work onto the board, other sessions claim and work items.

## Subagents

The `task` tool spawns bounded child sessions (`hummin -p`) with a fast/local/explicit model, foreground or background:

- Max 8 concurrent children; children get `HUMMIN_MEMORY=0` so they never touch your memory pipeline.
- `/background` (or `ctrl+b`) - panel of running background tasks and monitors, with tail and cancel.

## Scheduled wake-ups

```text
/cron
```

Detached scheduled wake-ups per project: entries, next run, delete. A single-scheduler lock prevents double-fires; `HUMMIN_CRON=0` disables entirely. Wake-ups fire while any session is open in that project.
