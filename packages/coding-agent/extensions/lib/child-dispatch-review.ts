import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getAgentDir, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildCatalog, decideRightSize, type ModelLike, type ModelProfile, type RightSizeConfig, type ThinkingLevel } from "./model-rightsize.ts";
export type { ThinkingLevel } from "./model-rightsize.ts";

export type ChildDispatchKind = "task" | "cron" | "memory-distill" | "memory-fold";
export interface DispatchReceipt { reviewId: string; fingerprint: string; kind: ChildDispatchKind; prompt: string; cwd: string; configuration: { provider: string; modelId: string; thinking: ThinkingLevel }; recommendation?: { provider: string; modelId: string; thinking: ThinkingLevel }; }
export interface ChildDispatchInput { kind: ChildDispatchKind; prompt: string; cwd: string; model?: string; thinking?: ThinkingLevel; reviewId?: string; overrideReason?: string; receipt?: DispatchReceipt; }
export interface ChildDispatchOptions { agentDir?: string; laya?: (state: string, questions: { name: string; type: "choice" | "score"; instructions: string; criteria: string[] }[]) => Promise<{ answer: string; p: number }[]>; layaTimeoutMs?: number; profiles?: readonly ModelProfile[]; config?: RightSizeConfig; }
type Ctx = { modelRegistry: { getAvailable(): readonly Model<Api>[] } };
interface Held { receipt: DispatchReceipt; reason: string; status: "pending" | "accepted" | "overridden"; confidence?: number; margin?: number; }
const pathFor = (dir: string) => join(dir, "child-dispatch-reviews.json");
const read = (dir: string): Held[] => { try { const value = JSON.parse(readFileSync(pathFor(dir), "utf8")) as unknown; if (!Array.isArray(value)) throw new Error("Invalid child dispatch review store."); return value as Held[]; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } };
// Every allowed dispatch appends an accepted record; keep the store bounded.
// Pruning a long-idle receipt is fail-safe: its next retry is re-reviewed.
const MAX_STORE_RECORDS = 200;
const write = (dir: string, value: Held[]) => { const capped = value.length > MAX_STORE_RECORDS ? value.slice(-MAX_STORE_RECORDS) : value; mkdirSync(dir, { recursive: true }); const path = pathFor(dir); const tmp = path + "." + process.pid + "." + randomUUID(); writeFileSync(tmp, JSON.stringify(capped, null, 2), { mode: 0o600 }); renameSync(tmp, path); };
// Concurrent prepareChildDispatch calls each read the store snapshot and the
// second write would clobber the first receipt (observed: "keeps concurrent
// independent pending reviews" intermittently dropping a review). This
// tail-chained mutex serializes the read -> review -> write critical section.
// `write` stays synchronous: re-entering the lock from inside the critical
// section would deadlock, and sync writes from resolveChildDispatchReview are
// atomic under JS single-threading.
const storeLocks = new Map<string, Promise<unknown>>();
const withStoreLock = async <T>(dir: string, fn: () => Promise<T>): Promise<T> => {
	const prior = storeLocks.get(dir) ?? Promise.resolve();
	const run = prior.catch(() => undefined).then(fn);
	storeLocks.set(dir, run);
	try { return await run; } finally { if (storeLocks.get(dir) === run) storeLocks.delete(dir); }
};
const audit = (dir: string, record: Record<string, unknown>) => { try { appendFileSync(join(dir, "child-dispatch-reviews.log"), JSON.stringify({ ...record, ts: new Date().toISOString() }) + "\n"); } catch { return; } };
const fingerprint = (input: ChildDispatchInput, configuration: { provider: string; modelId: string; thinking: ThinkingLevel }) => createHash("sha256").update(JSON.stringify([input.kind, input.prompt, input.cwd, configuration])).digest("hex").slice(0, 24);
export async function createLayaChoiceCall(state: string, questions: { name: string; type: "choice" | "score"; instructions: string; criteria: string[] }[], timeoutMs = 4000): Promise<{ answer: string; p: number; probabilities?: Record<string, number> }[]> {
 const url = (process.env.HUMMIN_LAYA_URL?.trim() || "http://127.0.0.1:9989/v1/systemone");
 const controller = new AbortController();
 const timer = setTimeout(() => controller.abort(), timeoutMs);
 try {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(process.env.COLI_API_KEY ? { authorization: "Bearer " + process.env.COLI_API_KEY } : {}) }, body: JSON.stringify({ state, questions: Object.fromEntries(questions.map((question) => [question.name, { type: question.type, instructions: question.instructions, criteria: question.criteria }])) }), signal: controller.signal });
  if (!response.ok) throw new Error("Laya HTTP " + response.status);
  const payload = await response.json() as { answers?: Record<string, { choice?: string; score?: number; probabilities?: Record<string, number>; answer_confidence?: number }> };
  return questions.map((question) => {
   const answer = payload.answers?.[question.name];
   const selected = question.type === "choice" ? answer?.choice : typeof answer?.score === "number" ? question.criteria[Math.round(answer.score)] : undefined;
   const probability = selected ? answer?.probabilities?.[selected] : undefined;
   if (!selected || !Number.isFinite(probability)) throw new Error("Laya returned an invalid choice");
   return { answer: selected, p: probability as number, probabilities: answer?.probabilities };
  });
 } finally { clearTimeout(timer); }
}
export function resolveChildModel(requested: string | undefined, ctx: Ctx): Model<Api> | undefined {
 const value = requested?.trim() || "fast"; const models = ctx.modelRegistry.getAvailable();
 if (value === "fast") return models.find((model) => model.provider === "zai" && model.id === "glm-5.3-flash");
 if (value === "local") return models.find((model) => "humminHost" in model && !(("humminOffline" in model) && model.humminOffline));
 const slash = value.indexOf("/"); if (slash < 1) return undefined;
 // Exact provider/model lookups must not resolve an offline fleet entry: the
 // committed subagent model-routing contract rejects offline models (the
 // rewrite silently accepted them, breaking test/hummin-processes.test.ts).
 return models.find((model) => model.provider === value.slice(0, slash) && model.id === value.slice(slash + 1) && !(("humminOffline" in model) && model.humminOffline));
}
export async function prepareChildDispatch(input: ChildDispatchInput, ctx: Ctx, options: ChildDispatchOptions = {}): Promise<{ action: "allow" | "block" | "advisory"; reviewId?: string; reason?: string; configuration: { provider: string; modelId: string; thinking: ThinkingLevel }; receipt?: DispatchReceipt }> {
 if (!options.agentDir) options.agentDir = getAgentDir();
 if (!options.laya) options.laya = (state, questions) => createLayaChoiceCall(state, questions, options.layaTimeoutMs);
 if (!options.config || !options.profiles) {
  try {
   const settings = SettingsManager.create(input.cwd);
   const raw = settings.getGlobalSettings() as SettingsManagerSettings;
   const project = settings.getProjectSettings() as SettingsManagerSettings;
   const source = { ...raw, ...project };
   options.config ||= settings.getLayaRightSizeConfig();
   options.profiles ||= Array.isArray(source.layaRightSize?.profiles) ? source.layaRightSize.profiles as ModelProfile[] : [];
  } catch {
   options.config ||= { enabled: true, swingThreshold: 0.6 };
   options.profiles ||= [];
  }
 }
 const model = resolveChildModel(input.model, ctx); if (!model) return { action: "block", reason: "Unknown or unavailable child model.", configuration: { provider: "", modelId: input.model || "", thinking: input.thinking || "off" } };
 const levels = ("thinkingLevels" in model && model.thinkingLevels ? model.thinkingLevels : getSupportedThinkingLevels(model as Model<Api>)) as ThinkingLevel[]; const thinking = input.thinking || (levels.includes("off") ? "off" : levels[0]); if (!levels.includes(thinking)) return { action: "block", reason: "Unsupported thinking level for selected model.", configuration: { provider: model.provider, modelId: model.id, thinking } };
 const configuration = { provider: model.provider, modelId: model.id, thinking }; const base: ChildDispatchInput = { kind: input.kind, prompt: input.prompt, cwd: input.cwd, model: model.provider + "/" + model.id, thinking }; const id = fingerprint(base, configuration);
 // All receipt resolution and store writes happen inside the lock: the
 // pre-lock fast path this once duplicated could write an override outside
 // the mutex, reintroducing the exact clobber race the lock exists for.
 return withStoreLock(options.agentDir ?? "", async () => {
  const records = options.agentDir ? read(options.agentDir) : [];
  const prior = input.reviewId ? records.find((entry) => entry.receipt.reviewId === input.reviewId) : records.find((entry) => entry.receipt.fingerprint === id);
  if ((input.reviewId || input.receipt) && !prior) return { action: "block" as const, reviewId: input.reviewId, reason: "Unknown child dispatch review.", configuration };
  if (prior) {
   if (input.receipt && (input.receipt.reviewId !== prior.receipt.reviewId || input.receipt.fingerprint !== prior.receipt.fingerprint)) return { action: "block" as const, reviewId: prior.receipt.reviewId, reason: "Forged dispatch receipt.", configuration };
   const recommendationMatch = prior.receipt.recommendation && prior.receipt.recommendation.provider === configuration.provider && prior.receipt.recommendation.modelId === configuration.modelId && prior.receipt.recommendation.thinking === configuration.thinking;
   if ((!recommendationMatch && prior.receipt.fingerprint !== id) || prior.receipt.prompt !== input.prompt || prior.receipt.cwd !== input.cwd || prior.receipt.kind !== input.kind) return { action: "block" as const, reviewId: prior.receipt.reviewId, reason: "Dispatch receipt does not match this request.", configuration };
   if (input.overrideReason && input.overrideReason.trim().length < 12) return { action: "block" as const, reviewId: prior.receipt.reviewId, reason: "A reasoned override is required.", configuration };
   if (prior.status === "accepted" || prior.status === "overridden") return { action: "allow" as const, reviewId: prior.receipt.reviewId, reason: prior.reason, configuration: prior.status === "accepted" && prior.receipt.recommendation ? prior.receipt.recommendation : prior.receipt.configuration, receipt: prior.receipt };
   if (prior.status === "pending" && !input.overrideReason) return { action: "block" as const, reviewId: prior.receipt.reviewId, reason: prior.reason, configuration };
   if (input.overrideReason) { prior.status = "overridden"; prior.reason = input.overrideReason.trim(); if (options.agentDir) write(options.agentDir, records); return { action: "allow" as const, reviewId: prior.receipt.reviewId, reason: prior.reason, configuration, receipt: prior.receipt }; }
  }
  const receipt: DispatchReceipt = { reviewId: randomUUID(), fingerprint: id, kind: input.kind, prompt: input.prompt, cwd: input.cwd, configuration };
  const candidates = ctx.modelRegistry.getAvailable().map((entry) => ({ provider: entry.provider, id: entry.id, reasoning: entry.reasoning, cost: entry.cost, thinkingLevels: ("thinkingLevels" in entry && entry.thinkingLevels ? entry.thinkingLevels : getSupportedThinkingLevels(entry as Model<Api>)) as ThinkingLevel[] }));
  let decision; try { decision = await decideRightSize({ subtask: input.prompt, requested: model.provider + "/" + model.id, thinking, catalog: buildCatalog(candidates as ModelLike[], options.profiles), config: options.config || { enabled: true, swingThreshold: 0.6 }, laya: options.laya || (async () => { throw new Error("Laya unavailable"); }) }); } catch { return { action: "advisory" as const, reason: "Laya unavailable; dispatch allowed.", configuration }; }
  // Re-read after the Laya await: a sync writer (resolveChildDispatchReview)
  // may have updated the store while this review was in flight; its update
  // must not be clobbered by the stale pre-await snapshot.
  const latest = options.agentDir ? read(options.agentDir) : records;
  if (decision.action !== "block") {
   receipt.recommendation = configuration;
   if (options.agentDir) {
	  write(options.agentDir, latest.concat({ receipt, reason: decision.reason || "Dispatch approved.", status: "accepted", confidence: decision.consulted ? decision.confidence : undefined, margin: decision.margin }));
	  if (decision.consulted) audit(options.agentDir, { reviewId: receipt.reviewId, action: decision.action, confidence: decision.confidence, margin: decision.margin });
   }
   return { action: decision.action, reviewId: receipt.reviewId, reason: decision.reason, configuration, receipt };
  }
  receipt.recommendation = decision.suggestedModel;
  const reason = (decision.reason || "Laya held dispatch.") + " Review ID: " + receipt.reviewId;
  if (options.agentDir) { write(options.agentDir, latest.concat({ receipt, reason, status: "pending" })); audit(options.agentDir, { reviewId: receipt.reviewId, action: "hold", kind: input.kind }); }
  return { action: "block" as const, reviewId: receipt.reviewId, reason, configuration };
 });
}
interface SettingsManagerSettings { layaRightSize?: { profiles?: unknown }; }
export function listChildDispatchReviews(agentDir = getAgentDir()): Held[] { return read(agentDir); }
export function resolveChildDispatchReview(reviewId: string, reason: string, agentDir = getAgentDir(), mode: "accept" | "override" = "override"): Held {
 const records = read(agentDir); const record = records.find((entry) => entry.receipt.reviewId === reviewId);
 if (!record) throw new Error("Unknown child dispatch review: " + reviewId);
 if (reason.trim().length < 12) throw new Error("A reasoned override is required.");
 if (mode === "accept" && !record.receipt.recommendation) throw new Error("This review has no recommendation to accept.");
 record.status = mode === "accept" ? "accepted" : "overridden"; record.reason = reason.trim(); write(agentDir, records); audit(agentDir, { reviewId, action: mode }); return record;
}
export function registerChildDispatchReviewTool(pi: ExtensionAPI): void { pi.registerTool({ name: "child_dispatch_review", label: "Child dispatch review", description: "List or resolve held child dispatch reviews.", parameters: Type.Object({ action: Type.Union([Type.Literal("list"), Type.Literal("accept"), Type.Literal("override")]), review_id: Type.Optional(Type.String()), reason: Type.Optional(Type.String()) }), async execute(_id, params) { const input = params as { action: "list" | "accept" | "override"; review_id?: string; reason?: string }; if (input.action === "list") return { content: [{ type: "text", text: JSON.stringify(listChildDispatchReviews(), null, 2) }], details: {} }; if (!input.review_id || !input.reason) throw new Error("review_id and reason are required"); const record = resolveChildDispatchReview(input.review_id, input.reason, getAgentDir(), input.action); return { content: [{ type: "text", text: "Resolved " + record.receipt.reviewId }], details: {} }; } }); }
