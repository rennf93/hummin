// Vitest setup: makes the temporary directory its real path, so tests that compare paths with the ones Chord reports
// (it resolves links) hold where the temporary directory is a link (macOS: /var is /private/var).

import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

process.env.TMPDIR = realpathSync(tmpdir());
