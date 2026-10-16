// Pure helpers for the HTTP dispatcher settings. The runtime undici code lives
// in ./undici-runtime.ts so that importing the SDK (via settings-manager) does
// not pull `undici` onto the import graph — importing undici has a module-init
// side effect that captures the global dispatcher (issue #9787).

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;

// Origins whose requests must never hit the idle timeout (local fleet servers
// can prefill silently for minutes). Registered before first use of the origin.
const idleTimeoutExemptOrigins = new Set<string>();

// Models may carry an empty or relative baseUrl (Azure catalog, virtual models).
function originOf(url: string | URL): string | undefined {
	const text = String(url);
	return URL.canParse(text) ? new URL(text).origin : undefined;
}

export function exemptFromHttpIdleTimeout(url: string | URL): void {
	const origin = originOf(url);
	if (origin) idleTimeoutExemptOrigins.add(origin);
}

export function isExemptFromHttpIdleTimeout(url: string | URL): boolean {
	const origin = originOf(url);
	return origin !== undefined && idleTimeoutExemptOrigins.has(origin);
}

export const HTTP_IDLE_TIMEOUT_CHOICES = [
	{ label: "30 sec", timeoutMs: 30_000 },
	{ label: "1 min", timeoutMs: 60_000 },
	{ label: "2 min", timeoutMs: 120_000 },
	{ label: "5 min", timeoutMs: 300_000 },
	{ label: "disabled", timeoutMs: 0 },
] as const;

export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.toLowerCase() === "disabled") {
			return 0;
		}
		if (trimmed.length === 0) {
			return undefined;
		}
		return parseHttpIdleTimeoutMs(Number(trimmed));
	}

	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return Math.floor(value);
}

export function formatHttpIdleTimeoutMs(timeoutMs: number): string {
	const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.timeoutMs === timeoutMs);
	if (choice) {
		return choice.label;
	}
	return `${timeoutMs / 1000} sec`;
}

export function applyHttpProxySettings(httpProxy: string | undefined): void {
	const proxy = httpProxy?.trim();
	if (!proxy) return;
	process.env.HTTP_PROXY ??= proxy;
	process.env.HTTPS_PROXY ??= proxy;
}
