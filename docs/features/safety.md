# Safety

An agent that runs bash needs brakes. hummin ships several layers, all visible and all toggleable - not vibes, actual mechanisms.

## Bash sandboxing

Workspace-mode sandboxing with real OS primitives: **macOS seatbelt** on Apple, **bubblewrap** on Linux.

- Writes restricted to the working directory and temp; secrets unreadable; configurable network policy.
- A real capability probe at startup - not assumed support.
- Blocked commands surface as in-band `[Sandbox]` blocks so you can see what happened and why.
- Child processes inherit the sandbox.

Toggle and inspect with `/sandbox`.

## Bashguard

An advisory matrix over destructive commands: flags `rm -rf`-class operations, `sed -i` rewrites, and writes outside the working directory as in-band notices before they run.

- Opt-in **block mode** and read-only **deny mode** when you want teeth, not just warnings.
- Exempt regexes for commands you trust.

Status and config: `/bashguard`.

## Guardrails

- **Loop detector**: catches the same tool called with the same args over and over.
- **Per-tool circuit breaker**: stops a misbehaving tool instead of the whole session.
- **Optional cumulative tool budget** (disabled by default) for hard cost control.
- Post-mortems after a guardrail trips, so the failure is legible.

## Hooks

`hooks.json` runs shell hooks on four lifecycle events. `tool_call` hooks can **block a tool with a reason** before it executes. Fail-open by design, with a loaded-hooks table and reload at `/hooks`.

## Checkpoints

- Every `edit`/`write` is snapshotted, content-addressed.
- `/rewind` restores files **and/or** the conversation to an earlier prompt, with conflict detection.
- 30-day blob retention.

## Trust and network

- **Project trust gating** for project-local resources, MCP servers, hooks and agent registration, with a `defaultProjectTrust` fallback. First touch of a new project asks.
- **Web fetch SSRF guard**: internal addresses and metadata endpoints are not fetchable.
- **Remote control** runs on loopback with a token and CSP - the terminal stays the answerer for approvals.
