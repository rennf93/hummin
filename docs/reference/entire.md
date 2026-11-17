# Entire

Optional integration with the [Entire](https://entire.com) CLI: session capture and
checkpoints, brain recall, and the cross-agent skills pack. Projects without Entire are
unaffected - nothing arms, nothing is sent.

## What hummin does

A bundled `entire-companion` extension arms itself only when a project is Entire-enabled
(`.entire/settings.json` or `.entire/settings.local.json` up the tree from the project root)
and the `entire` binary is on PATH. When armed it:

- forwards session lifecycle events to `entire hooks pi <event>` (same contract as Entire's
  official pi integration, except skill invocations are not reported), so checkpoints,
  transcripts, brain recall, and resume work for hummin sessions;
- delivers brain `brief`/`recall` output as a hidden context message (capped at 600
  characters; never written into `AGENTS.md`/`CLAUDE.md` by hummin);
- hardens agent-driven bash with `GIT_TERMINAL_PROMPT=0`, like the official forwarder;
- adds a `/entire` command printing the facts for this project (armed state, `entire status`,
  where data lives).

hummin never runs `entire enable`, never writes `.entire` settings or git hooks, never
pushes, and installs no daemons. Those stay yours.

Sessions are attributed to agent "pi" inside Entire until hummin is a built-in agent there.

## Where data goes

- **Local, always**: Entire copies each session transcript to `.entire/metadata/` (sanitized,
  **not redacted**, kept until you delete it or run `entire clean`) plus caches under
  `.entire/tmp/`. The agent's own transcript is never modified.
- **Checkpoint refs**: after a commit, Entire condenses the transcript (sanitized, then
  redacted by the configured scanners) into git objects at `refs/entire/checkpoints/*` in
  your repository's object store. Redaction is best-effort: pasted images are not scanned,
  street-address detection is US-only, and unrecognized low-entropy secrets can pass.
- **Push**: checkpoint refs leave the machine only when you run `git push`, to the
  destination Entire elects. With no `checkpoint_remote` configured, that destination is your
  origin - readable by anyone with access to that repo. Entire asks about this policy on the
  first push and proceeds automatically if the question goes unanswered. The
  dedicated-private-repo recipe below is the common way to avoid it.
- **Push queue**: with pushing disabled, refs keep accumulating in the local queue, and
  re-enabling push later sends all of them on the next `git push` - flip the setting only if
  that is what you want.

## Postures (pick your own; hummin manages whichever you chose)

- **Collaboration default**: do nothing. Checkpoint refs follow your normal `git push`, so
  teammates can read session history alongside the code.
- **Fully local**: `entire configure --skip-push-sessions`, `"telemetry": false` in
  `.entire/settings.local.json` (or `ENTIRE_TELEMETRY_OPTOUT=1`), and `ENTIRE_NO_AUTO_UPDATE=1`.
  Capture stays local; nothing is pushed.
- **Private checkpoint repo**: `entire configure --checkpoint-remote github:you/your-private-repo`.
  Checkpoints push there instead of origin. Restricting destinations further is possible with
  your own `pre-push` guard.

Entire's always-on background egress, independent of hummin: a daily version check and
metadata-only telemetry (PostHog, EU). Both have the opt-outs listed above. `entire status`
and `entire doctor` are network-free. Brain stays local unless you run `entire brain connect`;
memory distill can send session content to your model provider and asks before enabling.

## Skills

Entire publishes a cross-agent skill pack (search, explain, recall, replay, review, session
handoff, and more). Install it where hummin already looks:

```
npx skills add https://github.com/entireio/skills --all
```

That lands in `~/.agents/skills`, which hummin scans. Requirements: Entire CLI >= 0.11, a repo
with Entire sessions, and `entire login` for indexed-history skills.

## Brain

```
entire plugin install brain
entire-brain setup
```

Brain builds a local, inspectable memory layer from retained sessions and docs. Recall
reaches the hummin session through the hook envelope above; there is also
`entire-brain mcp` on some plugin versions if you prefer explicit MCP tools. The optional
graph plugin adds the code index.
