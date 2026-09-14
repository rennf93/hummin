/**
 * hummin-plan: plan mode (read-only) with a session-persistent toggle.
 *
 * /plan toggles the mode; the state is appended to the session (branch-safe,
 * reconstructed on load). While plan mode is ON, the tool_call hook blocks
 * write/edit and bash wholesale - reads, grep, find, ls stay available - with
 * in-band remediation text (guardrails pattern). Exit asks for confirmation.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PLAN_ENTRY = "hummin-plan-mode";

interface PlanState {
	enabled: boolean;
}

function reconstructState(ctx: ExtensionContext): boolean {
	let enabled = false;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && (entry as { customType?: string }).customType === PLAN_ENTRY) {
			const data = (entry as { data?: PlanState }).data;
			if (data && typeof data.enabled === "boolean") enabled = data.enabled;
		}
	}
	return enabled;
}

const BLOCKED_TOOLS = new Set(["edit", "write", "bash", "powershell"]);

export default function humminPlan(pi: ExtensionAPI): void {
	let planMode = false;

	pi.on("session_start", async (_event, ctx) => {
		planMode = reconstructState(ctx);
		if (planMode) pi.appendEntry(PLAN_ENTRY, { enabled: true } satisfies PlanState);
	});
	pi.on("session_tree", async (_event, ctx) => {
		planMode = reconstructState(ctx);
	});

	pi.on("tool_call", async (event) => {
		if (!planMode) return;
		if (!BLOCKED_TOOLS.has(event.toolName)) return;
		return {
			block: true,
			reason:
				"Plan mode is ON: changes are blocked. Explore, read, and design now - run /plan when you're ready to apply them.",
		};
	});

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only; blocks write/edit/bash)",
		handler: async (_args, ctx) => {
			if (planMode) {
				const confirmed = await ctx.ui.confirm(
					"Exit plan mode?",
					"Leaving plan mode unblocks write, edit, and bash for this session.",
				);
				if (!confirmed) {
					ctx.ui.notify("Still in plan mode.", "info");
					return;
				}
				planMode = false;
				pi.appendEntry(PLAN_ENTRY, { enabled: false } satisfies PlanState);
				ctx.ui.notify("Plan mode OFF - writes are unblocked.", "info");
				return;
			}
			planMode = true;
			pi.appendEntry(PLAN_ENTRY, { enabled: true } satisfies PlanState);
			ctx.ui.notify("Plan mode ON - read-only. /plan again to exit.", "info");
		},
	});
}
