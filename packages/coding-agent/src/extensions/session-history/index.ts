import type { ExtensionFactory } from "../../core/extensions/types.ts";
import { createSessionsToolDefinition, SESSIONS_TOOL_NAME } from "./tool.ts";

/**
 * Registers the inactive `sessions` tool and arms it whenever a session starts with a
 * predecessor (`/carry`, `/clear`, `/fork`, `/resume`). Fresh first sessions keep their
 * context lean: the tool's schema is only declared once looking back is possible.
 */
export function createSessionHistoryExtension(): ExtensionFactory {
	return (pi) => {
		pi.registerTool(createSessionsToolDefinition());
		pi.on("session_start", (event) => {
			// Tool handlers run after the registry is built and bindings are applied, so both calls
			// below are live here. A --tools allowlist that excludes the tool makes setActiveTools
			// ignore the unknown name, which is the intended opt-out.
			if (!event.previousSessionFile) return;
			const active = pi.getActiveTools();
			if (!active.includes(SESSIONS_TOOL_NAME)) {
				pi.setActiveTools([...active, SESSIONS_TOOL_NAME]);
			}
		});
	};
}

export default createSessionHistoryExtension();
