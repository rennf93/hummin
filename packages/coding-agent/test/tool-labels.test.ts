import { describe, expect, it } from "vitest";
import { formatToolLabel } from "../src/core/tools/render-utils.ts";

describe("formatToolLabel", () => {
	it("gives each tool its own Title Case label", () => {
		expect(formatToolLabel("bash").trim()).toBe("Bash");
		expect(formatToolLabel("read").trim()).toBe("Read");
		expect(formatToolLabel("edit").trim()).toBe("Edit");
		expect(formatToolLabel("ls").trim()).toBe("List");
		expect(formatToolLabel("todo").trim()).toBe("Plan");
	});

	it("auto-title-cases snake_case names without overrides", () => {
		expect(formatToolLabel("task_status").trim()).toBe("Task Status");
		expect(formatToolLabel("task_cancel").trim()).toBe("Task Cancel");
		expect(formatToolLabel("my_custom_tool").trim()).toBe("My Custom Tool");
	});

	it("returns the bare label; call sites add the two-space separator", () => {
		expect(formatToolLabel("read")).toBe("Read");
		expect(formatToolLabel("bash")).toBe("Bash");
	});
});
