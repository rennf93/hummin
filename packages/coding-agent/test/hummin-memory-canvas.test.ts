import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { writeCanvas } from "../extensions/hummin-memory.ts";

const createdDirs: string[] = [];

afterAll(() => {
	for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

function makeVault(): string {
	const dir = mkdtempSync(join(tmpdir(), "hummin-canvas-test-"));
	createdDirs.push(dir);
	for (const type of ["gotcha", "tool", "project"]) {
		mkdirSync(join(dir, "entities", type), { recursive: true });
	}
	writeFileSync(
		join(dir, "entities", "gotcha", "ram-cap.md"),
		`---
type: gotcha
created: 2026-09-14
tags: [gotcha, docker]
---

Overview text.

> [!warning] Cap summary

## Links
- related to [[hummin]]
- also [[zfs]] (missing entity, no edge)
`,
	);
	writeFileSync(
		join(dir, "entities", "tool", "hummin.md"),
		`---
type: tool
created: 2026-09-14
tags: [tool]
---

Overview text.

## Links
- [[ram-cap]]
`,
	);
	return dir;
}

test("writeCanvas builds typed file nodes and Link-section edges", () => {
	const dir = makeVault();
	const count = writeCanvas(dir);
	expect(count).toBe(2);

	const canvas = JSON.parse(readFileSync(join(dir, "graph.canvas"), "utf8")) as {
		nodes: Array<{ id: string; type: string; file: string; color?: string }>;
		edges: Array<{ fromNode: string; toNode: string }>;
	};
	expect(canvas.nodes).toHaveLength(2);

	const ramCap = canvas.nodes.find((n) => n.file === "entities/gotcha/ram-cap.md");
	const hummin = canvas.nodes.find((n) => n.file === "entities/tool/hummin.md");
	expect(ramCap?.color).toBe("2");
	expect(hummin?.color).toBe("6");
	expect(ramCap?.type).toBe("file");
	expect(hummin?.type).toBe("file");

	// Edges drawn only for wikilinks that resolve to existing entities, and
	// only from the "## Links" section: ram-cap -> hummin, hummin -> ram-cap;
	// the dangling [[zfs]] and the frontmatter/overview produce no edges.
	expect(canvas.edges).toHaveLength(2);
	const edgeFiles = canvas.edges.map((e) => {
		const from = canvas.nodes.find((n) => n.id === e.fromNode);
		const to = canvas.nodes.find((n) => n.id === e.toNode);
		return `${from?.file}->${to?.file}`;
	});
	expect(edgeFiles).toContain("entities/gotcha/ram-cap.md->entities/tool/hummin.md");
	expect(edgeFiles).toContain("entities/tool/hummin.md->entities/gotcha/ram-cap.md");
	expect(existsSync(join(dir, "graph.canvas"))).toBe(true);
});

test("writeCanvas returns 0 and writes nothing for an empty vault", () => {
	const dir = mkdtempSync(join(tmpdir(), "hummin-canvas-test-"));
	createdDirs.push(dir);
	expect(writeCanvas(dir)).toBe(0);
	expect(existsSync(join(dir, "graph.canvas"))).toBe(false);
});
