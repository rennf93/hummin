# Coding workflow benchmarks

The benchmark runs fixtures sequentially in disposable directories, verifies
results with independent checkers, and retains JSON event logs and stderr under
`bench/results/` (gitignored). Failed working copies are retained for inspection.

```sh
node bench/run.mjs --provider <provider-id> --model <model-id> --fixture multi-file
```

Use the exact provider ID from the model picker for local models. The runner
uses the built CLI; rebuild it before comparing implementations. A live run
uses the selected model and its normal credentials. The runner disables memory
distillation in children and does not run fixtures concurrently.

## Coverage

| Fixture/check | Behavior |
| --- | --- |
| `fix-bug`, `fib-module`, `find-defect` | Original small coding tasks |
| `multi-file` | Fix fractional quantities and zero-tax handling across modules |
| `preserve-work` | Follow AGENTS.md and preserve an existing user draft and export |
| `command-recovery` | Follow a failed command's diagnostic, fix code, verify |
| `test/suite/hummin-workflows.test.ts` | Faux-provider compaction constraints, memory delivery, actual write/rewind integration |

The new checkers live outside the agent's working directory. Each has a known
reference solution, and validation confirms the broken input fails before
checking that the reference solution passes:

```sh
node bench/run.mjs --validate-fixtures
node --test bench/metrics.test.mjs bench/run.test.mjs
```

These commands use no model. The runner test substitutes a mock CLI; the
coding-agent workflow tests use the suite harness and faux provider. They verify
the execution machinery and context flow, not a real model's reasoning quality.

## Measurements

Each result records correctness, elapsed time, tool calls/errors, final token
usage, compactions, approval requests, exit status, revision and CLI fingerprint.
Only final assistant events contribute usage; partial streaming snapshots do not.
Headless runs have no human input, so `humanInterventions` is zero and
`unattended` is true. This is not a prediction of interventions in interactive use.
A nonzero agent exit or timeout fails the run even if the checker accepts files.

Keep provider/model/thinking settings and machine load consistent for comparisons.
Extension code is loaded at runtime: record/sync the extension version too when
comparing runs. Checkers and prompts are fingerprinted; the CLI fingerprint alone
does not describe private settings or dynamically loaded resources.

The deterministic checks have been exercised during implementation. Real-model
baselines for the new fixtures are not included; run them when the chosen server
is available. Do not interpret reference-solution passes as model benchmark scores.

## Nightly offline regression gate

`node bench/run.mjs --offline` runs the real built CLI (`npm run build` first)
with a scripted model instead of a provider: `faux-provider.mjs` is loaded with
`-e` and replays a fixed plan from `faux-scripts.json` (shell commands, a write
of each `reference/` file, final text). No network, no credentials, no model.
Isolation: each fixture gets a fresh temp working directory and a fresh temp
`HUMMIN_CODING_AGENT_DIR` (so settings, friction logs and post-mortems stay out
of `~/.hummin/agent`), `HUMMIN_MEMORY=0`, `--no-session` and `--offline`.
Extensions still autoload from the real agent dir via the process home, but the
bench only reads them. Fixture commands run with the caller's environment.
Only fixtures listed in `faux-scripts.json` run (those with a `reference/`).
It exercises the real agent loop, tools, checkers and metrics, so it catches
harness, tool and agent-loop regressions. It says nothing about model quality.

`node bench/compare.mjs <results.json | dir>` compares the run with the
committed `bench/baseline.json` and exits 1 on a regression. `npm run bench:offline`
does both. The `offline-bench` job in `.github/workflows/hummin-bench.yml` runs
it on push, PR and the nightly cron, and uploads the results as an artifact.

| Metric | Gate |
| --- | --- |
| pass (checker plus clean exit) | fails if a baseline pass now fails, or a fixture is missing |
| `toolErrors` | fails if above baseline |
| `toolCalls` | fails if it differs by more than `toolCallTolerance` (0: the script is fixed) |
| wall time | report-only |

Wall time is mostly CLI startup (about 4s per fixture) and varies on shared
runners, so gating it would flake; it is printed next to the baseline. Tokens
are not gated: the scripted model reports zero usage.
`command-recovery` has one expected tool error (the deliberately failing
`verify-old.mjs`).

A failure means the agent loop, a tool, the CLI startup path or a fixture
changed behavior with the model held constant. Read the uploaded
`*.events.jsonl` and `*.stderr.txt` for the failing fixture. If the change is
intended (new tool call, new fixture, changed checker), refresh the baseline
in the same change:

```sh
npm run build
node bench/run.mjs --offline
node bench/compare.mjs bench/results --update   # rewrites bench/baseline.json
```

Review the `baseline.json` diff before committing it. Add a fixture to the
gate by adding a `reference/` solution and a `faux-scripts.json` entry.
