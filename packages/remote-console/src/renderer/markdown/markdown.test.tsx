// Corpus-driven tests for the markdown pipeline: inertness under the markdown bomb,
// the 20KB render cap, unicode hostility, autolink hardening, and structural parsing.
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { loadCorpusEvents, snapshotText } from "../test/corpus.ts";
import { mount } from "../test/mount.tsx";
import { Markdown } from "./Markdown.tsx";
import { parseMarkdown } from "./parse.ts";

/** Asserts the rendered container carries no executable or event-handler surface:
 * no script-like elements, no on* attributes, no javascript: hrefs anywhere. */
function assertInert(container: HTMLElement): void {
	const dangerous = container.querySelectorAll(
		"script, iframe, object, embed, form, input, style, img, svg:not(.rc-icon), video, audio",
	);
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

	it("links real email addresses but leaves package specs as text", async () => {
		const mounted = await mount(
			<Markdown
				text={
					"mail a@b.com, first.last@sub.example.org. Pkgs chord@1.7.0 pi-telemetry@1.7.0 @scope/pkg@1.2.3 name@^1.2 name@latest"
				}
			/>,
		);
		try {
			const hrefs = Array.from(mounted.container.querySelectorAll("a")).map((link) => link.getAttribute("href"));
			expect(hrefs).toEqual(["mailto:a@b.com", "mailto:first.last@sub.example.org"]);
			expect(mounted.container.textContent).toContain(
				"chord@1.7.0 pi-telemetry@1.7.0 @scope/pkg@1.2.3 name@^1.2 name@latest",
			);
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
		const parsed = parseMarkdown('```ts\nconst broken = "never closed"\nstill inside');
		expect(parsed.length).toBe(1);
		const block = parsed[0];
		expect(block?.kind).toBe("code");
		if (block?.kind !== "code") throw new Error("expected a code block");
		expect(block.closed).toBe(false);
		expect(block.code).toBe('const broken = "never closed"\nstill inside');
		const mounted = await mount(<Markdown text={'```ts\nconst broken = "never closed"'} />);
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
			expect(mounted.container.textContent).toContain("todo");
			expect(mounted.container.textContent).toContain("done");
			expect(mounted.container.textContent).not.toContain("[x]");
			const boxes = Array.from(mounted.container.querySelectorAll(".rc-md-check"));
			expect(boxes.map((box) => box.getAttribute("role"))).toEqual(["img", "img"]);
			expect(boxes.map((box) => box.getAttribute("aria-label"))).toEqual(["not completed", "completed"]);
			expect(boxes.map((box) => box.getAttribute("data-checked"))).toEqual(["false", "true"]);
			expect(boxes[1]?.closest("li")?.textContent).toBe("done");
			expect(mounted.container.querySelectorAll("blockquote").length).toBe(1);
			expect(mounted.container.querySelectorAll("hr").length).toBe(1);
		} finally {
			await mounted.unmount();
		}
	});

	it("wraps a table in the overflow wrapper", async () => {
		const mounted = await mount(<Markdown text={"| a | b |\n| - | - |\n| 1 | 2 |"} />);
		try {
			const table = mounted.container.querySelector("table");
			expect(table?.parentElement?.className).toBe("rc-md-table-wrap");
		} finally {
			await mounted.unmount();
		}
	});

	it("keeps a normal table header, including inline code and bold cells", async () => {
		const mounted = await mount(<Markdown text={"| `code` | **bold** | plain |\n|---|:-:|--:|\n| 1 | 2 | 3 |"} />);
		try {
			const heads = Array.from(mounted.container.querySelectorAll("thead th"));
			expect(heads.map((th) => th.textContent)).toEqual(["code", "bold", "plain"]);
			expect(heads[0]?.querySelector("code.rc-md-code")).not.toBeNull();
			expect(heads[1]?.querySelector("strong")).not.toBeNull();
		} finally {
			await mounted.unmount();
		}
	});

	it("renders no thead for an all-empty header row and still aligns the body", async () => {
		const mounted = await mount(<Markdown text={"| | |\n|---|--:|\n| a | b |"} />);
		try {
			expect(mounted.container.querySelector("thead")).toBeNull();
			const cells = mounted.container.querySelectorAll("tbody td");
			expect(cells.length).toBe(2);
			expect((cells[1] as HTMLElement).style.textAlign).toBe("right");
		} finally {
			await mounted.unmount();
		}
	});

	it("renders each ordered list item once", async () => {
		const mounted = await mount(<Markdown text={"1. first item\n2. second item"} />);
		try {
			expect(mounted.container.querySelectorAll("li").length).toBe(2);
			expect(mounted.container.textContent?.match(/first item/g)).toHaveLength(1);
		} finally {
			await mounted.unmount();
		}
	});
});

describe("list item blocks", () => {
	it("joins a soft-wrapped continuation into one inline item", async () => {
		const mounted = await mount(<Markdown text={"- a\n  b"} />);
		try {
			expect(mounted.container.querySelectorAll("li").length).toBe(1);
			expect(mounted.container.querySelector("li")?.textContent?.replace(/\s+/g, " ")).toBe("a b");
			expect(mounted.container.querySelector("li p")).toBeNull();
		} finally {
			await mounted.unmount();
		}
	});

	it("renders a block-level first line inside the item", async () => {
		const mounted = await mount(<Markdown text={"- > q"} />);
		try {
			expect(mounted.container.querySelector("li blockquote")?.textContent).toBe("q");
		} finally {
			await mounted.unmount();
		}
	});
});

describe("code blocks", () => {
	it("renders a header with the language, a copy button, and a non-wrapping body", async () => {
		const mounted = await mount(<Markdown text={"```ts\nconst a = 1;\n```"} />);
		try {
			expect(mounted.container.querySelector(".rc-code-head .rc-label")?.textContent).toBe("ts");
			const button = mounted.container.querySelector<HTMLButtonElement>(".rc-code-head button");
			expect(button?.getAttribute("aria-label")).toBe("Copy code");
			expect(mounted.container.querySelector(".rc-code-body")?.textContent).toBe("const a = 1;");
		} finally {
			await mounted.unmount();
		}
	});

	it("copies the source through navigator.clipboard and swaps the icon to a check", async () => {
		const writeText = vi.fn(() => Promise.resolve());
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		const mounted = await mount(<Markdown text={"```ts\nconst a = 1;\n```"} />);
		try {
			const button = mounted.container.querySelector<HTMLButtonElement>(".rc-code-head button");
			await act(async () => {
				button?.click();
			});
			expect(writeText).toHaveBeenCalledWith("const a = 1;");
			expect(mounted.container.querySelector(".rc-code-head button")?.getAttribute("aria-label")).toBe("Copied");
		} finally {
			Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
			await mounted.unmount();
		}
	});

	it("falls back to a hidden textarea and execCommand when the clipboard API is absent", async () => {
		Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
		const execCommand = vi.fn(() => true);
		Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
		const mounted = await mount(<Markdown text={"```\nx\n```"} />);
		try {
			await act(async () => {
				mounted.container.querySelector<HTMLButtonElement>(".rc-code-head button")?.click();
			});
			expect(execCommand).toHaveBeenCalledWith("copy");
			expect(document.querySelector("textarea")).toBeNull();
			expect(mounted.container.querySelector(".rc-code-head button")?.getAttribute("aria-label")).toBe("Copied");
			expect(mounted.container.querySelector(".rc-code-head .rc-sr-only")?.textContent).toBe("Copied");
		} finally {
			Reflect.deleteProperty(document, "execCommand");
			await mounted.unmount();
		}
	});

	it("shows Copy failed for about 1.5s when both copy paths fail, then resets", async () => {
		vi.useFakeTimers();
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText: () => Promise.reject(new Error("denied")) },
			configurable: true,
		});
		Object.defineProperty(document, "execCommand", { value: () => false, configurable: true });
		const mounted = await mount(<Markdown text={"```\nx\n```"} />);
		try {
			await act(async () => {
				mounted.container.querySelector<HTMLButtonElement>(".rc-code-head button")?.click();
			});
			const button = () => mounted.container.querySelector(".rc-code-head button");
			expect(button()?.getAttribute("aria-label")).toBe("Copy failed");
			expect(mounted.container.querySelector(".rc-code-head .rc-sr-only")?.getAttribute("aria-live")).toBe("polite");
			expect(mounted.container.querySelector(".rc-code-head .rc-sr-only")?.textContent).toBe("Copy failed");
			await act(async () => {
				vi.advanceTimersByTime(1600);
			});
			expect(button()?.getAttribute("aria-label")).toBe("Copy code");
		} finally {
			vi.useRealTimers();
			Reflect.deleteProperty(document, "execCommand");
			Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
			await mounted.unmount();
		}
	});
});
