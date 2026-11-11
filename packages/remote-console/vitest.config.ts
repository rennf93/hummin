// vitest wiring for the remote console: happy-dom environment, tests anywhere under the package root.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	root: fileURLToPath(new URL(".", import.meta.url)),
	test: {
		environment: "happy-dom",
		include: ["**/*.{test,spec}.{ts,tsx}"],
	},
});
