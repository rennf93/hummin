// Corpus-driven tests for the markdown pipeline: inertness under the markdown bomb,
// the 20KB render cap, unicode hostility, autolink hardening, and structural parsing.
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown.tsx";
import { parseMarkdown } from "./parse.ts";
import { loadCorpusEvents, snapshotText } from "../test/corpus.ts";
import { mount } from "../test/mount.tsx";

/** Asserts the rendered container carries no executable or event-handler surface:
 * no script-like elements, no on* attributes, no javascript: hrefs anywhere. */
function assertInert(container: HTMLElement): void {
	const dangerous = container.querySelectorAll("script, iframe, object, embed, form, input, style, img, svg, video, audio");
	expect(dangerous.length).toBe(0);
	for (const element of container.querySelectorAll("*")) {
		for (const attribute of Array.from(element.attributes)) {
			const name = attribute.name.toLowerCase();
			expect(name.startsWith("on"), `unexpected handler attribute ${name}`).toBe(false);
			const value = attribute.value.toLowerCase().trim();
			if (name === "href" || name === "src" || name === "xlink:href") {
				expect(value.startsWith("javascript:"), `unexpected javascript: in ${name}`).toBe(false);
			}
		}
	}
}

describe("markdown pipeline", () => {
	it("renders the markdown-bomb inert: no script elements, no handlers, no javascript: hrefs", async () => {
		const bomb = snapshotText(loadCorpusEvents("markdown-bomb.md"));
		const mounted = await mount(<Markdown text={bomb} />);
		try {
			assertInert(mounted.container);
			// Raw HTML renders as escaped text, not elements.
			expect(mounted.container.textContent).toContain('<script>alert("script")</script>');
			expect(mounted.container.textContent).toContain('<iframe src="https://evil.example/frame"></iframe>');
			expect(mounted.container.textContent).toContain(`<img src="x" onerror="alert('img-onerror')">`);
			expect(mounted.container.textContent).toContain(`<a href="javascript:alert(1)">javascript href</a>`);
			// The hostile structures still parse: nested list depth, the huge table, the fence.
			expect(mounted.container.textContent).toContain("level 6");
			expect(mounted.container.querySelectorAll("tbody tr").length).toBe(120);
			expect(mounted.container.querySelectorAll(".rc-code-unclosed").length).toBe(1);
		} finally {
			await mounted.unmount();
		}
	});

	it("renders autolinks with rel noopener and target blank", async () => {
		const bomb = snapshotText(loadCorpusEvents("markdown-bomb.md"));
		const mounted = await mount(<Markdown text={bomb} />);
		try {
			const links = Array.from(mounted.container.querySelectorAll("a"));
			expect(links.length).toBeGreaterThan(0);
			for (const link of links) {
				expect(link.getAttribute("rel")).toBe("noopener noreferrer");
				expect(link.getAttribute("target")).toBe("_blank");
			}
			const hrefs = links.map((link) => link.getAttribute("href"));
			expect(hrefs).toContain("https://example.com/a?b=1&c=2");
			expect(hrefs).toContain("https://www.example.com/page");
			expect(hrefs).toContain("mailto:user@example.com");
			expect(hrefs).toContain("https://bracketed.example");
		} finally {
			await mounted.unmount();
		}
	});

	it("renders an inline javascript: link as plain text with the destination visible", async () => {
		const mounted = await mount(<Markdown text={"see [click me](javascript:alert(1)) for details"} />);
		try {
			assertInert(mounted.container);
			expect(mounted.container.querySelectorAll("a").length).toBe(0);
			expect(mounted.container.textContent).toContain("click me (javascript:alert(1))");
		} finally {
			await mounted.unmount();
		}
	});

	it("caps the oversize 51KB block at 20KB with an explicit notice", async () => {
		const events = loadCorpusEvents("oversize.txt");
		const block = snapshotText(events);
		expect(block.length).toBe(51318);
		const mounted = await mount(<Markdown text={block} />);
		try {
			const notices = mounted.container.querySelectorAll("[data-rc-truncated]");
			expect(notices.length).toBe(1);
			expect(notices[0]?.textContent).toContain("20000");
			expect(notices[0]?.textContent).toContain("51318");
			// The DOM stays bounded: notice plus rendered head, never the full 51KB.
			expect((mounted.container.textContent ?? "").length).toBeLessThan(26000);
		} finally {
			await mounted.unmount();
		}
	});

	it("renders broken-unicode without throwing and keeps the text readable", async () => {
		const text = snapshotText(loadCorpusEvents("broken-unicode.txt"));
		const mounted = await mount(<Markdown text={text} />);
		try {
			expect(mounted.container.textContent).toContain("lone high surrogate:");
			expect(mounted.container.textContent).toContain("RTL override:");
			expect(mounted.container.textContent).toContain("zero width joiner family:");
		} finally {
			await mounted.unmount();
		}
	});

	it("terminates on an unclosed fence and marks the block honestly", async () => {
		const parsed = parseMarkdown("```ts\nconst broken = \"never closed\"\nstill inside");
		expect(parsed.length).toBe(1);
		const block = parsed[0];
		expect(block?.kind).toBe("code");
		if (block?.kind !== "code") throw new Error("expected a code block");
		expect(block.closed).toBe(false);
		expect(block.code).toBe('const broken = "never closed"\nstill inside');
		const mounted = await mount(<Markdown text={"```ts\nconst broken = \"never closed\""} />);
		try {
			expect(mounted.container.textContent).toContain("fence not closed");
			expect(mounted.container.textContent).toContain("never closed");
		} finally {
			await mounted.unmount();
		}
	});

	it("parses nested lists, task items, quotes, and rules", async () => {
		const text = ["- a", "  - b", "    - c", "- [ ] todo", "- [x] done", "", "> quoted", "", "---"].join("\n");
		const mounted = await mount(<Markdown text={text} />);
		try {
			// both nesting levels sit under the top list; the first carries the third level
			const nested = mounted.container.querySelectorAll(".rc-md-ul ul");
			expect(nested.length).toBe(2);
			expect(nested[0]?.textContent).toContain("b");
			expect(nested[0]?.querySelector("ul")?.textContent).toContain("c");
			const topList = mounted.container.querySelector(".rc-md-ul");
			const topItems = Array.from(topList?.children ?? []).filter((child) => child.tagName === "LI");
			expect(topItems.length).toBe(3);
			expect(mounted.container.textContent).toContain("[ ] todo");
			expect(mounted.container.textContent).toContain("[x] done");
			expect(mounted.container.querySelectorAll("blockquote").length).toBe(1);
			expect(mounted.container.querySelectorAll("hr").length).toBe(1);
		} finally {
			await mounted.unmount();
		}
	});
});
