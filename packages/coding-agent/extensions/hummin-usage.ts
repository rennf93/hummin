import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";

/**
 * Usage visibility: /context (token breakdown vs the model's context window)
 * and /cost (cumulative session cost, split local-served vs cloud).
 *
 * Local-first accounting: cache-hit ratio is first-class (prefill is the
 * scarce resource on the fleet), and cost reporting shows the local share.
 * Values measured from provider usage are labeled exact; character-based
 * heuristics are labeled est.
 */

export const CHARS_PER_TOKEN = 4;

/** Default compaction reserve when settings are not reachable (settings default). */
export const DEFAULT_RESERVE_TOKENS = 16384;

/** Provider price shape, $/M tokens, satisfied by ModelRuntime's Model.cost. */
export interface ModelRates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** Minimal usage shape shared by provider usage and test fixtures. */
export interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Actual dollars for this message when the provider reported them. */
	cost?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

/** Minimal pricing lookup, satisfied by ModelRegistry / ModelRuntime. */
export interface ModelPriceSource {
	getModel(provider: string, modelId: string): { cost: ModelRates } | undefined;
}

/** Rough token estimate from character count. Always labeled est. */
export function estimateTokens(chars: number): number {
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Token estimate for one tool: schema + description + prompt guidelines. */
export function estimateToolTokens(tool: Pick<ToolInfo, "description" | "parameters" | "promptGuidelines">): number {
	const schemaChars = JSON.stringify(tool.parameters ?? {}).length;
	const descChars = (tool.description ?? "").length;
	const guideChars = (tool.promptGuidelines ?? "").length;
	return estimateTokens(schemaChars + descChars + guideChars);
}

/** Total estimated tokens for the active tool surface. */
export function estimateToolsTokens(tools: readonly ToolInfo[]): number {
	return tools.reduce((sum, tool) => sum + estimateToolTokens(tool), 0);
}

// ---------------------------------------------------------------------------
// /context
// ---------------------------------------------------------------------------

export type Precision = "exact" | "est";

export interface ContextRow {
	label: string;
	tokens: number;
	precision: Precision;
	detail?: string;
}

export interface ContextReport {
	rows: ContextRow[];
	/** Conversation tokens measured from the last assistant message usage, or null when none yet. */
	conversationTokens: number | null;
	/** cacheRead / (input + cacheRead + cacheWrite), or null when nothing was billed. */
	cacheHitRatio: number | null;
	/** contextWindow - conversationTokens, or null when either is unknown. */
	remainingTokens: number | null;
	/** Token count at which auto-compaction triggers (window - reserve). */
	compactionTrigger: number | null;
	contextWindow: number | null;
}

export function cacheHitRatioOf(usage: UsageLike | undefined): number | null {
	if (!usage) return null;
	const billed = usage.input + usage.cacheRead + usage.cacheWrite;
	if (billed <= 0) return null;
	return usage.cacheRead / billed;
}

export function conversationTokensOf(usage: UsageLike | undefined): number | null {
	if (!usage) return null;
	const tokens = usage.input + usage.cacheRead + usage.cacheWrite;
	return tokens > 0 ? tokens : null;
}

export function buildContextReport(input: {
	systemPromptChars: number;
	tools: readonly ToolInfo[];
	lastUsage: UsageLike | undefined;
	contextWindow: number | undefined;
	reserveTokens: number;
}): ContextReport {
	const systemTokens = estimateTokens(input.systemPromptChars);
	const toolTokens = estimateToolsTokens(input.tools);
	const conversationTokens = conversationTokensOf(input.lastUsage);
	const window = input.contextWindow;
	return {
		rows: [
			{ label: "system prompt", tokens: systemTokens, precision: "est", detail: `${input.systemPromptChars} chars / ${CHARS_PER_TOKEN}` },
			{ label: "tools", tokens: toolTokens, precision: "est", detail: `${input.tools.length} active` },
			{
				label: "conversation",
				tokens: conversationTokens ?? 0,
				precision: conversationTokens === null ? "est" : "exact",
				detail:
					conversationTokens === null
						? "no assistant usage yet"
						: `input ${input.lastUsage?.input} + cacheRead ${input.lastUsage?.cacheRead} + cacheWrite ${input.lastUsage?.cacheWrite}`,
			},
		],
		conversationTokens,
		cacheHitRatio: cacheHitRatioOf(input.lastUsage),
		remainingTokens: window === undefined || conversationTokens === null ? null : Math.max(0, window - conversationTokens),
		compactionTrigger: window === undefined ? null : Math.max(0, window - input.reserveTokens),
		contextWindow: window ?? null,
	};
}

function padRight(text: string, width: number): string {
	return text.length >= width ? text : `${text}${" ".repeat(width - text.length)}`;
}

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 10_000) return `${Math.round(tokens / 1000)}k`;
	if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
	return String(tokens);
}

export function formatContextReport(report: ContextReport): string {
	const labelWidth = Math.max(...report.rows.map((row) => row.label.length)) + 2;
	const lines = report.rows.map(
		(row) =>
			`${padRight(row.label, labelWidth)}${formatTokens(row.tokens).padStart(8)}  (${row.precision === "est" ? "est" : "exact"})${row.detail ? `  ${row.detail}` : ""}`,
	);
	const linesOut = [...lines];
	if (report.contextWindow !== null) linesOut.push(`context window${" ".repeat(labelWidth - "context window".length)}${formatTokens(report.contextWindow).padStart(8)}`);
	if (report.conversationTokens !== null && report.remainingTokens !== null)
		linesOut.push(`remaining${" ".repeat(labelWidth - "remaining".length)}${formatTokens(report.remainingTokens).padStart(8)}  (exact, vs window)`);
	if (report.cacheHitRatio !== null) linesOut.push(`cache hit: ${(report.cacheHitRatio * 100).toFixed(1)}% (exact, last request)`);
	if (report.compactionTrigger !== null) linesOut.push(`compaction triggers at ${formatTokens(report.compactionTrigger)} tokens (window - reserve)`);
	linesOut.push("est = chars/4 heuristic; exact = provider-reported usage");
	return linesOut.join("\n");
}

// ---------------------------------------------------------------------------
// /cost
// ---------------------------------------------------------------------------

const LOCAL_PROVIDER_RE = /hummin|colibri|llamacpp|ollama|local/i;

/** A provider counts as local-served (billed $0) when its name says so. */
export function isLocalProvider(provider: string): boolean {
	return LOCAL_PROVIDER_RE.test(provider);
}

export interface UsageSample {
	provider: string;
	model: string;
	usage: UsageLike;
}

/** Compute a message's cost in dollars, $/M pricing like cache-stats pricing lookup. */
export function messageCost(sample: UsageSample, models: ModelPriceSource | undefined): number {
	if (sample.usage.cost && sample.usage.cost.total > 0) return sample.usage.cost.total;
	const rates = models?.getModel(sample.provider, sample.model)?.cost;
	if (!rates) return 0;
	return (
		(sample.usage.input * rates.input +
			sample.usage.output * rates.output +
			sample.usage.cacheRead * rates.cacheRead +
			sample.usage.cacheWrite * rates.cacheWrite) /
		1_000_000
	);
}

export interface ModelCostRow {
	provider: string;
	model: string;
	requests: number;
	inputTokens: number;
	outputTokens: number;
	cost: number;
	local: boolean;
}

export interface CostReport {
	total: number;
	/** Cost of locally served requests; $0 by definition. */
	localTotal: number;
	cloudTotal: number;
	rows: ModelCostRow[];
}

export function buildCostReport(samples: readonly UsageSample[], models: ModelPriceSource | undefined): CostReport {
	const order: string[] = [];
	const byKey = new Map<string, ModelCostRow>();
	for (const sample of samples) {
		const key = `${sample.provider}/${sample.model}`;
		let row = byKey.get(key);
		if (!row) {
			row = {
				provider: sample.provider,
				model: sample.model,
				requests: 0,
				inputTokens: 0,
				outputTokens: 0,
				cost: 0,
				local: isLocalProvider(sample.provider),
			};
			byKey.set(key, row);
			order.push(key);
		}
		row.requests += 1;
		row.inputTokens += sample.usage.input + sample.usage.cacheRead + sample.usage.cacheWrite;
		row.outputTokens += sample.usage.output;
		row.cost += messageCost(sample, models);
	}
	const rows = order.map((key) => byKey.get(key) as ModelCostRow);
	return {
		total: rows.reduce((sum, row) => sum + row.cost, 0),
		localTotal: rows.filter((row) => row.local).reduce((sum, row) => sum + row.cost, 0),
		cloudTotal: rows.filter((row) => !row.local).reduce((sum, row) => sum + row.cost, 0),
		rows,
	};
}

function formatDollars(cost: number): string {
	return `$${cost.toFixed(cost >= 0.01 ? 2 : 4)}`;
}

export function formatCostReport(report: CostReport): string {
	const lines = report.rows.map(
		(row) =>
			`${row.provider}/${row.model}  ${row.requests} req  in ${formatTokens(row.inputTokens)}  out ${formatTokens(row.outputTokens)}  ${formatDollars(row.cost)}${row.local ? " (local)" : ""}`,
	);
	lines.push(`total: ${formatDollars(report.total)}  served locally ($${report.localTotal.toFixed(2)})  cloud ${formatDollars(report.cloudTotal)}`);
	if (report.rows.some((row) => row.local)) lines.push("local-served models run on the fleet and bill $0");
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function interactiveOnly(ctx: ExtensionContext, command: string): boolean {
	if (ctx.mode === "tui") return true;
	ctx.ui.notify(`/${command} is interactive only`, "info");
	return false;
}

function lastAssistantUsage(ctx: ExtensionContext): UsageLike | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" && entry.message.role === "assistant") return entry.message.usage;
	}
	return undefined;
}

function assistantSamples(ctx: ExtensionContext): UsageSample[] {
	return ctx.sessionManager
		.getBranch()
		.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "assistant"
				? [{ provider: entry.message.provider, model: entry.message.model, usage: entry.message.usage }]
				: [],
		);
}

export default function humminUsage(pi: ExtensionAPI): void {
	pi.registerCommand("context", {
		description: "Show context window usage: system prompt, tools, conversation, cache hit, remaining",
		category: "Usage",
		handler: async (_args, ctx) => {
			if (!interactiveOnly(ctx, "context")) return;
			try {
				const active = new Set(pi.getActiveTools());
				const tools = pi.getAllTools().filter((tool) => active.has(tool.name));
				const report = buildContextReport({
					systemPromptChars: ctx.getSystemPrompt().length,
					tools,
					lastUsage: lastAssistantUsage(ctx),
					contextWindow: ctx.model?.contextWindow,
					reserveTokens: DEFAULT_RESERVE_TOKENS,
				});
				ctx.ui.notify(formatContextReport(report), "info");
			} catch (error) {
				ctx.ui.notify(`context: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("cost", {
		description: "Show cumulative session cost split by model, local-served vs cloud",
		category: "Usage",
		handler: async (_args, ctx) => {
			if (!interactiveOnly(ctx, "cost")) return;
			try {
				const samples = assistantSamples(ctx);
				if (!samples.length) {
					ctx.ui.notify("cost: no assistant responses in this session yet", "info");
					return;
				}
				const report = buildCostReport(samples, { getModel: (provider, id) => ctx.modelRegistry.find(provider, id) });
				ctx.ui.notify(formatCostReport(report), "info");
			} catch (error) {
				ctx.ui.notify(`cost: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
