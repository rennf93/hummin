import * as bundledPiAgentCore from "@earendil-works/pi-agent-core";
import * as bundledPiAiCompat from "@earendil-works/pi-ai/compat";
import * as bundledPiAiOauth from "@earendil-works/pi-ai/oauth";
import * as bundledPiAiProviders from "@earendil-works/pi-ai/providers/all";
import * as bundledPiTui from "@earendil-works/pi-tui";
import * as bundledTypebox from "typebox";
import * as bundledTypeboxCompile from "typebox/compile";
import * as bundledTypeboxValue from "typebox/value";
// This import is safe because loader.ts exports are not re-exported from index.ts.
// Extensions can therefore import from @earendil-works/pi-coding-agent.
import * as bundledPiCodingAgent from "../../index.ts";

/** Modules available to extensions in source and compiled binary runtimes. */
const RAW_VIRTUAL_MODULES: Record<string, unknown> = {
	typebox: bundledTypebox,
	"typebox/compile": bundledTypeboxCompile,
	"typebox/value": bundledTypeboxValue,
	"@sinclair/typebox": bundledTypebox,
	"@sinclair/typebox/compile": bundledTypeboxCompile,
	"@sinclair/typebox/value": bundledTypeboxValue,
	"@earendil-works/pi-agent-core": bundledPiAgentCore,
	"@earendil-works/pi-tui": bundledPiTui,
	// Extensions resolve the pi-ai root to the compat entrypoint (a strict
	// superset of the core entrypoint): existing extensions using the old
	// global API keep working at runtime until compat is removed.
	"@earendil-works/pi-ai": bundledPiAiCompat,
	"@earendil-works/pi-ai/compat": bundledPiAiCompat,
	"@earendil-works/pi-ai/oauth": bundledPiAiOauth,
	"@earendil-works/pi-ai/providers/all": bundledPiAiProviders,
	"@earendil-works/pi-coding-agent": bundledPiCodingAgent,
	"@mariozechner/pi-agent-core": bundledPiAgentCore,
	"@mariozechner/pi-tui": bundledPiTui,
	"@mariozechner/pi-ai": bundledPiAiCompat,
	"@mariozechner/pi-ai/compat": bundledPiAiCompat,
	"@mariozechner/pi-ai/oauth": bundledPiAiOauth,
	"@mariozechner/pi-ai/providers/all": bundledPiAiProviders,
	"@mariozechner/pi-coding-agent": bundledPiCodingAgent,
};

/**
 * hummin: pi-ai ships code-split lazy api entrypoints (for example
 * "@earendil-works/pi-ai/api/openai-completions.lazy"). The compat namespace
 * re-exports every lazy api symbol, so serve any documented api/* subpath from
 * it instead of enumerating entrypoints here. jiti looks modules up with
 * `specifier in virtualModules` and `virtualModules[specifier]`, so the `has`
 * and `get` traps cover the subpath pattern generically.
 */
const PI_AI_API_PREFIX = /^@(?:earendil-works|mariozechner)\/pi-ai\/api\//;

function withPiAiApiSubpaths(modules: Record<string, unknown>): Record<string, unknown> {
	return new Proxy(modules, {
		has(target, key) {
			return key in target || (typeof key === "string" && PI_AI_API_PREFIX.test(key));
		},
		get(target, key, receiver) {
			if (typeof key === "string" && PI_AI_API_PREFIX.test(key)) {
				// Symbols missing from compat fail with a clear error when accessed
				// instead of silently being undefined (bad import or typo).
				const compat = target["@earendil-works/pi-ai"] as object;
				return new Proxy(compat, {
					has(compatTarget, prop) {
						// Route property reads through the guarded get below.
						return typeof prop === "symbol" ? Reflect.has(compatTarget, prop) : true;
					},
					get(compatTarget, prop) {
						if (typeof prop === "symbol") return Reflect.get(compatTarget, prop);
						// Thenable probes from awaiting module namespaces are not exports.
						if (prop === "then" || prop === "catch" || prop === "finally") return undefined;
						if (prop !== "default" && !(prop in compatTarget)) {
							throw new Error(
								`"${String(prop)}" is not exported by @earendil-works/pi-ai api modules (available via the compat entrypoint)`,
							);
						}
						return Reflect.get(compatTarget, prop);
					},
				});
			}
			return Reflect.get(target, key, receiver);
		},
	});
}

/** Modules available to extensions via jiti virtualModules (with pi-ai api/* subpaths). */
export const VIRTUAL_MODULES: Record<string, unknown> = withPiAiApiSubpaths(RAW_VIRTUAL_MODULES);
