import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { ensureVault, writeCanvas } from "../extensions/hummin-memory.ts";

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
	// only from the "## Links" section: the dangling [[zfs]] and the
	// frontmatter/overview produce no edges. The reciprocal pair ram-cap <->
	// hummin collapses to ONE undirected edge instead of two arcs.
	expect(canvas.edges).toHaveLength(1);
	const edge = canvas.edges[0];
	const from = canvas.nodes.find((n) => n.id === edge.fromNode);
	const to = canvas.nodes.find((n) => n.id === edge.toNode);
	expect(new Set([from?.file, to?.file])).toEqual(new Set(["entities/gotcha/ram-cap.md", "entities/tool/hummin.md"]));
	expect(existsSync(join(dir, "graph.canvas"))).toBe(true);
});

test("writeCanvas returns 0 and writes nothing for an empty vault", () => {
	const dir = mkdtempSync(join(tmpdir(), "hummin-canvas-test-"));
	createdDirs.push(dir);
	expect(writeCanvas(dir)).toBe(0);
	expect(existsSync(join(dir, "graph.canvas"))).toBe(false);
});

test("ensureVault refreshes a stale graph.canvas and skips rewriting when unchanged", () => {
	const prevVaultDir = process.env.HUMMIN_MEMORY_VAULT_DIR;
	const dir = mkdtempSync(join(tmpdir(), "hummin-canvas-refresh-test-"));
	createdDirs.push(dir);
	process.env.HUMMIN_MEMORY_VAULT_DIR = dir;
	try {
		mkdirSync(join(dir, "entities", "project"), { recursive: true });
		writeFileSync(
			join(dir, "entities", "project", "hub.md"),
			"---\ntype: project\ncreated: 2026-09-14\ntags: [project]\n---\n\nOverview.\n\n## Links\n- [[leaf]]\n",
		);
		// Simulate a canvas rendered before the newest entities existed: only
		// an older node set, missing the current entity.
		writeFileSync(join(dir, "graph.canvas"), `${JSON.stringify({ nodes: [], edges: [] }, null, "\t")}\n`);

		ensureVault();
		const refreshed = JSON.parse(readFileSync(join(dir, "graph.canvas"), "utf8")) as {
			nodes: Array<{ file: string }>;
			edges: Array<{ fromNode: string; toNode: string }>;
		};
		expect(refreshed.nodes.map((n) => n.file)).toContain("entities/project/hub.md");
		// dangling [[leaf]] still yields no edge
		expect(refreshed.edges).toHaveLength(0);

		// No entity change -> content is identical -> mtime must not move
		// (rewriting on every vault touch would dirty the vault git worktree).
		const canvasPath = join(dir, "graph.canvas");
		const before = statSync(canvasPath).mtimeMs;
		ensureVault();
		expect(statSync(canvasPath).mtimeMs).toBe(before);

		// A new entity is picked up on the next ensureVault call.
		writeFileSync(
			join(dir, "entities", "project", "leaf.md"),
			"---\ntype: project\ncreated: 2026-09-15\ntags: [project]\n---\n\nOverview.\n\n## Links\n- [[hub]]\n",
		);
		ensureVault();
		const grown = JSON.parse(readFileSync(canvasPath, "utf8")) as {
			nodes: Array<{ file: string }>;
			edges: Array<{ fromNode: string; toNode: string }>;
		};
		expect(grown.nodes).toHaveLength(2);
		expect(grown.edges).toHaveLength(1);
	} finally {
		if (prevVaultDir === undefined) delete process.env.HUMMIN_MEMORY_VAULT_DIR;
		else process.env.HUMMIN_MEMORY_VAULT_DIR = prevVaultDir;
	}
});
