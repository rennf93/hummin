import { defineConfig } from "vitest/config";

// Workspace packages (pi-telemetry, pi-schema) resolve to their sources, so Chord's tests need no build.
// At most 4 test files at once: the tests start esbuild builds and child processes of their own, and one file per core
// (the default) oversubscribes the machine, so a plugin build or rollout took 4 times its time alone and the end to end
// test ran past its 5 s limit (about 2.4 s with 4, 5.1 s with 11 files on 12 cores, same load).
export default defineConfig({
	test: { environment: "node", setupFiles: ["./test/real-tmpdir.ts"], maxWorkers: 4 },
	resolve: { conditions: ["source"] },
	ssr: { resolve: { conditions: ["source"] } },
});
