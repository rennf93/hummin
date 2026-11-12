// vite wiring for the remote console: react + tailwind plugins, relative base, dist output.
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	base: "./",
	build: {
		outDir: "dist",
		// Fonts stay files: the console server's CSP is `font-src 'self'`, which blocks the
		// data: URIs vite would inline small font subsets as.
		assetsInlineLimit: (filePath) => (/\.woff2?$/.test(filePath) ? false : undefined),
	},
});
