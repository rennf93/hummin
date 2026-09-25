/** Pure Laya review of a child dispatch. A candidate is a real runtime model
 * and thinking configuration; this module never invents model ids or tiers. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface ModelProfile {
 provider: string; modelId: string; description?: string; speed?: string;
 cost?: { input: number; output: number }; thinkingLevels?: readonly ThinkingLevel[];
}
export interface ModelCandidate {
 provider: string; modelId: string; thinking: ThinkingLevel;
 description?: string; speed?: string; cost?: { input: number; output: number };
}
export interface Catalog { models: readonly ModelCandidate[]; }
export interface ModelLike {
 provider: string; id: string; reasoning?: boolean; cost?: { input?: number; output?: number };
 thinkingLevelMap?: Record<string, string | null>;
 thinkingLevels?: readonly ThinkingLevel[];
}
const LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
function supportedThinking(model: ModelLike): readonly ThinkingLevel[] {
 if (model.thinkingLevelMap) {
  const found = LEVELS.filter((level) => model.thinkingLevelMap?.[level] != null);
  if (found.length) return found;
 }
 return ["off"];
}
export function buildCatalog(models: readonly ModelLike[], profiles: readonly ModelProfile[] = []): Catalog {
 const byKey = new Map(profiles.map((profile) => [`${profile.provider}/${profile.modelId}`, profile]));
 const candidates: ModelCandidate[] = [];
 for (const model of models) {
  if (!model.provider || !model.id) continue;
  const profile = byKey.get(`${model.provider}/${model.id}`);
 const thinking = profile?.thinkingLevels ?? model.thinkingLevels ?? supportedThinking(model);
  for (const level of thinking) candidates.push({
   provider: model.provider, modelId: model.id, thinking: level, description: profile?.description,
   speed: profile?.speed, cost: profile?.cost ?? (model.cost?.input !== undefined && model.cost?.output !== undefined ? { input: model.cost.input, output: model.cost.output } : undefined),
  });
 }
 return { models: candidates };
}
export interface ResolvedModel { provider?: string; modelId?: string; matched: boolean; }
export function resolveRequestedModel(requested: string | undefined | null, catalog: Catalog): ResolvedModel {
 const value = requested?.trim() ?? "";
 if (!value || value === "fast" || value === "local") return { matched: false };
 const slash = value.indexOf("/");
 const provider = slash > 0 ? value.slice(0, slash) : undefined;
 const modelId = slash > 0 ? value.slice(slash + 1) : value;
 const match = catalog.models.find((entry) => (!provider || entry.provider === provider) && entry.modelId === modelId);
 return match ? { provider: match.provider, modelId: match.modelId, matched: true } : { matched: false };
}
export interface RightSizeConfig { enabled: boolean; swingThreshold: number; }
export interface LayScoreResult { answer: string; p: number; probabilities?: Record<string, number>; }
export interface LayScoreQuestion { name: string; type: "choice" | "score"; instructions: string; criteria: string[]; }
export type LayScoreCall = (state: string, questions: LayScoreQuestion[]) => Promise<LayScoreResult[]>;
export interface SuggestedModel { provider: string; modelId: string; thinking: ThinkingLevel; }
export interface RightSizeDecision { action: "allow" | "block" | "advisory"; consulted: boolean; reason?: string; confidence?: number; margin?: number; chosen?: SuggestedModel; suggestedModel?: SuggestedModel; reviewId?: string; }
function label(candidate: ModelCandidate): string { return `${candidate.provider}/${candidate.modelId} [thinking=${candidate.thinking}]`; }
function parseLabel(answer: string, candidates: readonly ModelCandidate[]): ModelCandidate | undefined {
 const value = answer.trim();
 return candidates.find((candidate) => label(candidate) === value);
}
function reviewId(task: string, chosen: ModelCandidate | undefined): string {
 let hash = 2166136261;
 for (const char of `${task}\0${chosen ? label(chosen) : ""}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
 return (hash >>> 0).toString(16);
}
export async function decideRightSize(params: {
 subtask: string; requested?: string | null; thinking?: ThinkingLevel; catalog: Catalog; config: RightSizeConfig; laya: LayScoreCall;
}): Promise<RightSizeDecision> {
 if (!params.config.enabled || !params.subtask.trim()) return { action: "allow", consulted: false };
 const resolved = resolveRequestedModel(params.requested, params.catalog);
 const chosen = resolved.matched ? params.catalog.models.find((entry) => entry.provider === resolved.provider && entry.modelId === resolved.modelId && (!params.thinking || entry.thinking === params.thinking)) : undefined;
 if (!chosen) return { action: "allow", consulted: false, reason: "Laya dispatch review skipped: requested model or thinking configuration is unresolved." };
 const sameProvider = params.catalog.models.filter((entry) => entry.provider === chosen.provider);
 const candidates = [chosen, ...sameProvider.filter((entry) => label(entry) !== label(chosen)).slice(0, 19)];
 if (candidates.length < 2) return { action: "allow", consulted: false, chosen: { provider: chosen.provider, modelId: chosen.modelId, thinking: chosen.thinking } };
 const descriptions = candidates.map((entry) => `- ${label(entry)}${entry.description ? `: ${entry.description}` : ""}${entry.speed ? `, speed=${entry.speed}` : ""}${entry.cost ? `, inputCost=${entry.cost.input}, outputCost=${entry.cost.output}` : ""}`).join("\n");
 const state = `Review child dispatch. Task:\n${params.subtask.slice(0, 4000)}\nRequested configuration: ${label(chosen)}\nAvailable same-provider configurations:\n${descriptions}`;
 let answer: LayScoreResult[];
 try { answer = await params.laya(state, [{ name: "recommended_configuration", type: "choice", instructions: "Choose the single configuration that fits this child task. Consider capability, speed, cost, and thinking depth. The parent may override, but do not choose a configuration absent from the list.", criteria: candidates.map(label) }]); }
 catch { return { action: "allow", consulted: false, chosen: { provider: chosen.provider, modelId: chosen.modelId, thinking: chosen.thinking }, reason: "Laya dispatch review unavailable; dispatch allowed." }; }
 const selected = parseLabel(answer?.[0]?.answer ?? "", candidates);
 if (!selected) return { action: "allow", consulted: true, reason: "Laya returned no valid runtime configuration; dispatch allowed." };
 const confidence = Math.max(0, Math.min(1, Number(answer[0]?.p) || 0));
 // Swing is the confidence margin between Laya's pick and the requested
 // configuration, not absolute confidence: a 0.31 top pick still means "change"
 // when the requested config only holds 0.05 of the probability mass. When the
 // caller does not supply per-label probabilities, the requested mass counts as
 // 0 and the margin degrades to absolute confidence (old behavior).
 const requestedProbability = answer?.[0]?.probabilities?.[label(chosen)];
 const margin = Math.max(0, confidence - (typeof requestedProbability === "number" ? Math.max(0, requestedProbability) : 0));
 const chosenOut = { provider: chosen.provider, modelId: chosen.modelId, thinking: chosen.thinking };
 const suggested = { provider: selected.provider, modelId: selected.modelId, thinking: selected.thinking };
 if (label(selected) === label(chosen)) return { action: "allow", consulted: true, confidence, chosen: chosenOut, suggestedModel: suggested };
 const id = reviewId(params.subtask, chosen);
 const reason = `[laya dispatch review ${id}] Laya selected ${label(selected)} for this task; requested ${label(chosen)}. Accept the recommendation or explicitly override review ${id} with a reason.`;
 return { action: margin >= params.config.swingThreshold ? "block" : "advisory", consulted: true, confidence, margin, chosen: chosenOut, suggestedModel: suggested, reason, reviewId: id };
}
