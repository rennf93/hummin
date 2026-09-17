# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- Use concise, clear, simple language. Define unavoidable jargon before using it.
- Explain non-trivial designs and problems as: problem, concrete example or short trace, then solution. State why the solution is necessary and distinguish it from optional complexity.
- Prefer concrete behavior and small illustrations over abstract summaries, dense terminology, or unexplained lists of changes.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead, then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes.

## Commands

- After code changes (not docs): `npm run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Does not run tests.
- Never run `npm run build` or `npm test` unless requested by the user.
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. Otherwise run specific tests from the package root:
  - Vitest: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/specific.test.ts`
  - `packages/tui` (`node:test`): `node --test test/specific.test.ts`
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- When regressions tests for fixing a github issue, add a comment with the github issue number next to the test.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- Never wait on long-running work (builds, test runs, CI) with blocking `sleep`/poll loops in `bash`. Start a `monitor` for the process or status check and let it deliver output; keep bash calls for one-shot commands.
- Never commit unless the user asks.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- When updating `undici`, you MUST read its changelog/release notes for the target version and evaluate whether any changes may affect functionality before applying the update.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- If `packages/coding-agent/npm-shrinkwrap.json` needs regen, run `node scripts/generate-coding-agent-shrinkwrap.mjs` (verify with `--check` or `npm run check`). New deps with lifecycle scripts require review and an explicit allowlist entry in that script; never add one silently.
- Pre-commit blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1`. Don't bypass unless the user wants the lockfile change committed.

## Git

Multiple pi sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Committing:

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- `packages/ai/src/models.generated.ts` may always be included alongside your files.
- Message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <commit message> (optionally multiple lines)`. Message is informative and concise.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Issues and PRs

See `CONTRIBUTING.md` for the contributor gate (auto-close workflows, `lgtm`/`lgtmi`, quality bar).

When reviewing PRs:

- Do not run `gh pr checkout`, `git switch`, or otherwise move the worktree to the PR branch unless the user explicitly asks.
- Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show`/`git diff` against fetched refs to inspect PR metadata, commits, and patches without changing branches.
- If you need PR file contents, fetch/read them into temporary files or use `git show <ref>:<path>` without switching branches.

When creating issues:

- Add `pkg:*` labels for affected packages (`pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`); use all that apply.

When posting issue/PR comments:

- Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
- Keep comments concise, technical, in the user's tone.
- End every AI-posted comment with the AI-generated disclaimer line specified by the originating prompt (e.g. `This comment is AI-generated by `/wr``).

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the message so merging auto-closes the issue. For multiple issues, repeat the keyword per issue (`closes #1, closes #2`); a shared keyword (`closes #1, #2`) only closes the first.

## Testing pi Interactive Mode with tmux

For testing pi's interactive mode, load and follow [.pi/skills/interactive-testing.md](.pi/skills/interactive-testing.md).

## Changelog

Location: `packages/*/CHANGELOG.md` (one per package).

Sections under `## [Unreleased]`: `### Breaking Changes` (API changes requiring migration), `### Added`, `### Changed`, `### Fixed`, `### Removed`.

Rules:

- All new entries go under `## [Unreleased]`. Read the full section first and append to existing subsections; never duplicate them.
- Released version sections (e.g. `## [0.12.2]`) are immutable; never modify them.
- Do not create changelog entries when working on a branch other than `main` or pull request

Attribution:

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/earendil-works/pi/issues/123))`
- External contributions: `Added feature X ([#456](https://github.com/earendil-works/pi/pull/456) by [@username](https://github.com/username))`

## Releasing

For release preparation, publishing, verification, or recovery, load and follow [.pi/skills/release.md](.pi/skills/release.md).

## hummin specifics (this fork)

- Fork policy: thin overlay on upstream pi - zero deletions, and `@earendil-works/*` internal package names stay for cheap upstream merges. Do not sweep renames without the user's explicit go.
- Private design docs live OUTSIDE the repo at `~/Documents/GitHub/ZZZ/hummin-docs/` (SPEC, DESIGN, HANDOFF progress doc). Do not move them into the repo.
- `packages/coding-agent/extensions/hummin-local.ts` invariants: keep separate engine/host providers so servers remain independently selectable. The local provider id is `hummin` (renamed from `colibri`; the colibri *engine* name still refers to the external container runtime). `HUMMIN_INSTANCES` overrides the ordered `fleet.servers` settings (`HUMMIN_COLIBRI_INSTANCES` and settings key `colibriInstances` kept as pre-rename fallbacks). Fleet order defines preference; offline catalog entries come only from explicitly configured server `models`. Keep personal fleet addresses, service targets, and model catalogs in private settings. Per-model context windows come from server `/props` with `HUMMIN_CTX` as fallback; qwen-family models carry `thinkingFormat: "qwen-chat-template"`. Never introduce guessed placeholder model ids for unreachable servers.
- `packages/coding-agent/extensions/hummin-memory.ts`: any spawned child (distill, fold) MUST set `HUMMIN_MEMORY=0` in its child env - otherwise the shutdown handler recurses unboundedly (bug class, fixed once already).
- `src/core/http-dispatcher.ts` replaces the global fetch with an undici `EnvHttpProxyAgent`. Local model servers need `httpIdleTimeoutMs: 0` in user settings (slow prefills otherwise look like dead connections); do not "fix" reported hangs by shortening default timeouts.
- Runtime process title is `hummin`; a TUI session and spawned `-p` children look identical in `ps` - never kill by name pattern.
- Extensions autoload from `~/.hummin/agent/extensions/` (runtime TS, synced from `packages/coding-agent/extensions/` after changes).
- Verify absence claims with a search before asserting them - both a `/copy` command and the vault contents were wrongly declared missing before (2026-09).
- Inspect uncommitted worktree changes (`git diff`) before attributing them to other sessions; never invent ownership. Ask the user if genuinely unclear.
- Memory/vault tests must point `HUMMIN_MEMORY_DIR` and `HUMMIN_MEMORY_VAULT_DIR` at temp dirs; never let tests write the real `~/.hummin/agent/memory` store (65 test lessons had to be pruned once).
- When a `HUMMIN_*` setting "doesn't apply", check env overrides first: `HUMMIN_MEMORY_VAULT_DIR`, `HUMMIN_MEMORY_PROVIDER`, `HUMMIN_MEMORY_MODEL_ID`, `HUMMIN_INSTANCES`, `HUMMIN_CTX` silently beat `settings.json`.
- Spawning parallel child tasks in one worktree: state each child's file ownership explicitly in its brief, and expect transient in-flight parse errors in cross-package test runs.
- Memory: inspect the vault through the built-in `vault` tool, not raw `find`/`cat` over vault directories. The live vault dir is `HUMMIN_MEMORY_VAULT_DIR` (`~/hummin-vault`), which overrides the default `~/.hummin/agent/vault` and the settings value - working in the default dir when the env var is set creates duplicate graphs. Fold/curate guardrails live in the vault's AGENTS.md (machine-managed by `vaultContract()` in hummin-memory.ts).

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
