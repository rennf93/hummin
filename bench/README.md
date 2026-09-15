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
