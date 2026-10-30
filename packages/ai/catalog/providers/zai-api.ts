import { defineProvider } from "../define.ts";
import { ZAI_COMPLETIONS_COMPAT, zaiCodingPlanModels } from "./zai.ts";

// hummin overlay: same models as the coding plan, billed against the usage API credit.
export default defineProvider({
	id: "zai-api",
	models: (ctx) => zaiCodingPlanModels(ctx, "zai-coding-plan", "https://api.z.ai/api/paas/v4"),
	compat: { "openai-completions": ZAI_COMPLETIONS_COMPAT },
});
