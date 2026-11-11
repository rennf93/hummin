// vite wiring for the remote console: react + tailwind plugins, relative base, dist output.
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	base: "./",
	build: {
		outDir: "dist",
	},
});
