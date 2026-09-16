import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

let harness: Harness | undefined;
afterEach(() => harness?.cleanup());
describe("queued user message editing", () => {
	test("removes delivered messages by identity when the prompt text repeats", async () => {
		harness = await createHarness();
		const { session } = harness;
		await session.followUp("same");
		await session.followUp("same");
		const counts: number[] = [];
		session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "user") counts.push(session.pendingMessageCount);
		});
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);
		await session.prompt("same");
		expect(counts).toEqual([2, 1, 0]);
		expect(session.getFollowUpMessages()).toEqual([]);
	});
	test("preserves extension messages preceding the chosen user message", async () => {
		harness = await createHarness();
		const { session } = harness;
		const custom = { role: "custom" as const, customType: "notice", content: "keep", display: true, timestamp: 0 };
		session.agent.steer(custom);
		await session.steer("remove");
		expect(session.removeQueuedMessage("steering", 0)).toBe("remove");
		expect(session.agent.removeSteeringAt(0)).toBe(custom);
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});
	test("identifies duplicate prompts after earlier messages leave the queue", async () => {
		harness = await createHarness();
		const { session } = harness;
		await session.followUp("same");
		await session.followUp("same");
		const [first, second] = session.getQueuedUserMessages("followUp");
		expect(session.removeQueuedMessage("followUp", 0, first)).toBe("same");
		expect(session.removeQueuedMessage("followUp", 0, first)).toBeUndefined();
		expect(session.getQueuedUserMessages("followUp")).toEqual([second]);
		expect(session.removeQueuedMessage("followUp", 1, second)).toBe("same");
		expect(session.pendingMessageCount).toBe(0);
	});
	test("preserves attachments and refuses to restore an already drained message", async () => {
		harness = await createHarness();
		const { session } = harness;
		const image = { type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" };
		await session.steer("", [image]);
		const [message] = session.getQueuedUserMessages("steering");
		expect(message.content).toContainEqual(image);
		expect(session.agent.removeSteeringAt(0)).toBe(message);
		expect(session.removeQueuedMessage("steering", 0, message)).toBeUndefined();
	});
	test("notifies after enqueueing and rejects invalid positions", async () => {
		harness = await createHarness();
		const { session } = harness;
		const pending: boolean[] = [];
		session.subscribe((event) => {
			if (event.type === "queue_update") pending.push(session.agent.hasQueuedMessages());
		});
		await session.steer("keep");
		for (const index of [-1, 0.5, Number.NaN, 4])
			expect(session.removeQueuedMessage("steering", index)).toBeUndefined();
		expect(session.getSteeringMessages()).toEqual(["keep"]);
		expect(session.removeQueuedMessage("steering", 0)).toBe("keep");
		expect(pending).toEqual([true, false]);
	});
});
