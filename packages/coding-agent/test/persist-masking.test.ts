import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { maskSecrets, maskSessionEntry } from "../src/core/persist-masking.ts";
import {
	type CustomMessageEntry,
	type SessionEntry,
	SessionManager,
	type SessionMessageEntry,
} from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

const GITHUB_TOKEN = `ghp_${"a1B2".repeat(9)}`;
const OPENAI_PROJECT_KEY = `sk-proj-${"x9y8".repeat(6)}`;
const OPENAI_KEY = `sk-${"Zq3Wn9".repeat(5)}`;
const ANTHROPIC_KEY = `sk-ant-${"k7L2".repeat(6)}`;
const OPENROUTER_KEY = `sk-or-v1-${"ab".repeat(16)}`;
const AWS_ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE";
const AWS_SECRET_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const BEARER_TOKEN =
	"Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const PEM_BLOCK = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7T6xyz\n-----END RSA PRIVATE KEY-----";

describe("maskSecrets", () => {
	it("masks GitHub tokens", () => {
		expect(maskSecrets(`token ${GITHUB_TOKEN} in text`)).toBe("token [REDACTED:github] in text");
		expect(maskSecrets(`gho_${"a1B2".repeat(9)}`)).toBe("[REDACTED:github]");
	});

	it("masks OpenAI project keys and bare sk- keys", () => {
		expect(maskSecrets(`key ${OPENAI_PROJECT_KEY} here`)).toBe("key [REDACTED:openai] here");
		expect(maskSecrets(`key ${OPENAI_KEY} here`)).toBe("key [REDACTED:openai] here");
	});

	it("masks Anthropic keys", () => {
		expect(maskSecrets(`key ${ANTHROPIC_KEY} here`)).toBe("key [REDACTED:anthropic] here");
	});

	it("masks OpenRouter keys", () => {
		expect(maskSecrets(`key ${OPENROUTER_KEY} here`)).toBe("key [REDACTED:openrouter] here");
	});

	it("masks AWS access keys", () => {
		expect(maskSecrets(`access ${AWS_ACCESS_KEY} done`)).toBe("access [REDACTED:aws-access] done");
	});

	it("masks AWS secret keys that follow an aws secret/key label", () => {
		expect(maskSecrets(`aws_secret_access_key=${AWS_SECRET_KEY}`)).toBe(
			"aws_secret_access_key=[REDACTED:aws-secret]",
		);
		expect(maskSecrets(`AWS Secret Key: "${AWS_SECRET_KEY}"`)).toBe('AWS Secret Key: "[REDACTED:aws-secret]"');
		expect(maskSecrets(`using aws secret ${AWS_SECRET_KEY} today`)).toBe(
			"using aws secret [REDACTED:aws-secret] today",
		);
	});

	it("masks Authorization Bearer headers", () => {
		expect(maskSecrets(BEARER_TOKEN)).toBe("[REDACTED:bearer]");
		expect(maskSecrets("authorization: bearer abc123def456")).toBe("[REDACTED:bearer]");
		expect(maskSecrets(`"Authorization": "Bearer ${"x".repeat(50)}"`)).toBe('"[REDACTED:bearer]"');
		expect(maskSecrets(`'Authorization': 'Bearer abc123def456'`)).toBe("'[REDACTED:bearer]'");
	});

	it("masks PEM private key blocks", () => {
		expect(maskSecrets(`preamble\n${PEM_BLOCK}\nafter`)).toBe("preamble\n[REDACTED:private-key]\nafter");
	});

	it("masks each pattern inside a combined payload", () => {
		const combined = `${GITHUB_TOKEN} ${OPENAI_PROJECT_KEY} ${ANTHROPIC_KEY} ${OPENROUTER_KEY} ${AWS_ACCESS_KEY} ${BEARER_TOKEN}\n${PEM_BLOCK}`;
		const masked = maskSecrets(combined);
		expect(masked).toContain("[REDACTED:github]");
		expect(masked).toContain("[REDACTED:openai]");
		expect(masked).toContain("[REDACTED:anthropic]");
		expect(masked).toContain("[REDACTED:openrouter]");
		expect(masked).toContain("[REDACTED:aws-access]");
		expect(masked).toContain("[REDACTED:bearer]");
		expect(masked).toContain("[REDACTED:private-key]");
		expect(masked).not.toContain(GITHUB_TOKEN);
		expect(masked).not.toContain(ANTHROPIC_KEY);
	});

	it("does not mask normal code and prose", () => {
		const samples = [
			'const x = "sk-" + suffix;',
			'const prefix = "sk-proj-";',
			"const ghp_ = 1;",
			"ghp_short",
			"AKIA1234",
			"const sk = 'sk-abc';",
			"https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"aws secret key rotation policy",
			"function computeSessionKey(input) { return input.length; }",
		];
		for (const sample of samples) {
			expect(maskSecrets(sample)).toBe(sample);
		}
	});
});

describe("maskSessionEntry", () => {
	it("masks message text content and leaves the original entry untouched", () => {
		const entry: SessionMessageEntry = {
			type: "message",
			id: "e1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: userMsg(`leak ${GITHUB_TOKEN} end`),
		};
		const before = JSON.stringify(entry);
		const masked = maskSessionEntry(entry);
		expect(JSON.stringify(entry)).toBe(before);
		expect(masked).not.toBe(entry);
		expect(masked).toMatchObject({ message: { content: "leak [REDACTED:github] end" } });
	});

	it("masks assistant text parts but leaves thinking and tool calls untouched", () => {
		const entry: SessionMessageEntry = {
			type: "message",
			id: "e2",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: {
				...assistantMsg(`answer ${ANTHROPIC_KEY}`),
				content: [
					{ type: "thinking", thinking: `thought ${GITHUB_TOKEN}` },
					{ type: "text", text: `answer ${ANTHROPIC_KEY}` },
				],
			},
		};
		const masked = maskSessionEntry(entry);
		expect(masked).toMatchObject({
			message: {
				content: [
					{ type: "thinking", thinking: `thought ${GITHUB_TOKEN}` },
					{ type: "text", text: "answer [REDACTED:anthropic]" },
				],
			},
		});
	});

	it("masks toolResult text parts and leaves images untouched", () => {
		const entry: SessionMessageEntry = {
			type: "message",
			id: "e3",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: {
				role: "toolResult",
				toolCallId: "call1",
				toolName: "read",
				content: [
					{ type: "text", text: `output ${OPENAI_KEY}` },
					{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
				],
				isError: false,
				timestamp: 1,
			},
		};
		const masked = maskSessionEntry(entry);
		expect(masked).toMatchObject({
			message: {
				content: [
					{ type: "text", text: "output [REDACTED:openai]" },
					{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
				],
			},
		});
	});

	it("masks custom_message string and text-part content, leaving images untouched", () => {
		const stringEntry: CustomMessageEntry = {
			type: "custom_message",
			id: "e4",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			customType: "ext:note",
			content: `note ${OPENROUTER_KEY}`,
			display: true,
		};
		expect(maskSessionEntry(stringEntry)).toMatchObject({ content: "note [REDACTED:openrouter]" });
		expect(stringEntry.content).toBe(`note ${OPENROUTER_KEY}`);

		const partsEntry: CustomMessageEntry = {
			...stringEntry,
			id: "e5",
			content: [
				{ type: "text", text: `note ${AWS_ACCESS_KEY}` },
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/jpeg" },
			],
		};
		expect(maskSessionEntry(partsEntry)).toMatchObject({
			content: [
				{ type: "text", text: "note [REDACTED:aws-access]" },
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/jpeg" },
			],
		});
	});

	it("passes non-message entry types through unchanged", () => {
		const entries: SessionEntry[] = [
			{
				type: "compaction",
				id: "c1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				summary: `summary ${GITHUB_TOKEN}`,
				firstKeptEntryId: "c1",
				tokensBefore: 100,
			},
			{
				type: "custom",
				id: "c2",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				customType: "ext:state",
				data: { secret: GITHUB_TOKEN },
			},
			{
				type: "model_change",
				id: "c3",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				provider: "anthropic",
				modelId: "test",
			},
		];
		for (const entry of entries) {
			expect(maskSessionEntry(entry)).toBe(entry);
		}
	});
});

describe("SessionManager persist masking", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "persist-masking-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("round-trips a session with secrets masked on disk and raw in memory", () => {
		const sessionDir = join(tempDir, "sessions");
		const sm = SessionManager.create(tempDir, sessionDir);
		sm.appendMessage(userMsg(`github ${GITHUB_TOKEN} aws ${AWS_ACCESS_KEY}`));
		sm.appendMessage(assistantMsg(`using aws_secret_access_key=${AWS_SECRET_KEY}`));

		const raw = readFileSync(sm.getSessionFile()!, "utf8");
		expect(raw).toContain("[REDACTED:github]");
		expect(raw).toContain("[REDACTED:aws-access]");
		expect(raw).toContain("[REDACTED:aws-secret]");
		expect(raw).not.toContain(GITHUB_TOKEN);
		expect(raw).not.toContain(AWS_ACCESS_KEY);
		expect(raw).not.toContain(AWS_SECRET_KEY);

		const entries = sm.getEntries();
		expect(entries[0].type).toBe("message");
		// The in-memory tree keeps the raw secrets; only the bytes on disk are masked.
		expect(JSON.stringify(entries)).toContain(GITHUB_TOKEN);
		expect(JSON.stringify(entries)).toContain(AWS_SECRET_KEY);
		expect(JSON.stringify(entries)).not.toContain("[REDACTED:");
	});

	it("re-opening the session loads masked entries", () => {
		const sm = SessionManager.create(tempDir, join(tempDir, "sessions"));
		sm.appendMessage(userMsg(`token ${GITHUB_TOKEN}`));
		const file = sm.getSessionFile()!;

		const reopened = SessionManager.open(file);
		const entries = reopened.getEntries();
		expect(entries).toHaveLength(1);
		expect(reopened.buildSessionProjection().messages[0]).toMatchObject({
			role: "user",
			content: "token [REDACTED:github]",
		});
	});

	it("masks custom_message entries on disk", () => {
		const sm = SessionManager.create(tempDir, join(tempDir, "sessions"));
		sm.appendCustomMessageEntry("ext:note", `note ${OPENROUTER_KEY}`, true);
		const raw = readFileSync(sm.getSessionFile()!, "utf8");
		expect(raw).toContain("[REDACTED:openrouter]");
		expect(raw).not.toContain(OPENROUTER_KEY);
	});

	it("leaves entries raw on disk when persistMasking.enabled is false", () => {
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ persistMasking: { enabled: false } }));

		const settingsManager = SettingsManager.create(tempDir, agentDir);
		expect(settingsManager.getPersistMaskingEnabled()).toBe(false);

		const sm = SessionManager.create(tempDir, join(tempDir, "sessions"));
		sm.setPersistMaskingEnabled(() => settingsManager.getPersistMaskingEnabled());
		sm.appendMessage(userMsg(`token ${GITHUB_TOKEN}`));

		const raw = readFileSync(sm.getSessionFile()!, "utf8");
		expect(raw).toContain(GITHUB_TOKEN);
		expect(raw).not.toContain("[REDACTED:");
		expect(JSON.stringify(sm.getEntries())).toContain(GITHUB_TOKEN);
	});

	it("defaults persistMasking.enabled to true", () => {
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		expect(SettingsManager.create(tempDir, agentDir).getPersistMaskingEnabled()).toBe(true);
	});
});

describe("masking coverage extensions", () => {
	it("thinking blocks and tool-call arguments are masked", () => {
		const entry = {
			type: "message",
			id: "e1",
			parentId: null,
			timestamp: "t",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", text: "the key is sk-ant-api03-abcdefghijklmnopqrstuvwx" },
					{
						type: "toolCall",
						id: "c1",
						name: "bash",
						arguments: { command: "echo ghp_AbcdEfghAbcdEfghAbcdEfghAbcdEfgh1234" },
					},
				],
			},
		} as unknown as SessionEntry;
		const masked = maskSessionEntry(entry) as Extract<SessionEntry, { type: "message" }>;
		const content = (masked.message as { content: unknown }).content as Array<{
			type: string;
			text?: string;
			arguments?: unknown;
		}>;
		expect(JSON.stringify(content)).not.toContain("sk-ant-api03");
		expect(JSON.stringify(content)).not.toContain("ghp_AbcdEfgh");
		expect((content[0] as { text: string }).text).toContain("[REDACTED:anthropic]");
		expect(JSON.stringify((content[1] as { arguments: unknown }).arguments)).toContain("[REDACTED:github]");
	});
});
