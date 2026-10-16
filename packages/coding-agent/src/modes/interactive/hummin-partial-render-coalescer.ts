import type { ToolExecutionComponent } from "./components/tool-execution.ts";

type PartialToolResult = Omit<Parameters<ToolExecutionComponent["updateResult"]>[0], "isError" | "durationMs">;

/** Coalescing window for streaming partial tool results. */
const PARTIAL_RENDER_INTERVAL_MS = 16;

/** Coalesced partial tool results waiting for their trailing render. */
export class PartialRenderCoalescer {
	private pending = new Map<string, { result: PartialToolResult; timer: ReturnType<typeof setTimeout> }>();

	/**
	 * Leading-edge render immediately, then coalesce bursts into one trailing render.
	 * Partial streams can emit many chunks per second; each updateResult rebuilds the component tree, so per-chunk renders waste work.
	 */
	update(
		toolCallId: string,
		result: PartialToolResult,
		getComponent: () => ToolExecutionComponent | undefined,
		requestRender: () => void,
	): void {
		const component = getComponent();
		if (!component) return;
		const pending = this.pending.get(toolCallId);
		if (pending) {
			pending.result = result;
			return;
		}
		component.updateResult({ ...result, isError: false }, true);
		this.pending.set(toolCallId, {
			result,
			timer: setTimeout(() => {
				const queued = this.pending.get(toolCallId);
				this.pending.delete(toolCallId);
				if (!queued) return;
				const target = getComponent();
				if (target) {
					target.updateResult({ ...queued.result, isError: false }, true);
					requestRender();
				}
			}, PARTIAL_RENDER_INTERVAL_MS),
		});
	}

	/** Drop any queued partial render; the final result already rendered. */
	cancel(toolCallId: string): void {
		const queued = this.pending.get(toolCallId);
		if (queued) {
			clearTimeout(queued.timer);
			this.pending.delete(toolCallId);
		}
	}
}
