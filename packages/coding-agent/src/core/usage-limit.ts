/**
 * Provider usage-limit detection. Some providers (OpenRouter, Z.AI coding plans, ...)
 * fail turns with a textual reset time ("Usage limit reached for 5 hour. Your limit
 * will reset at 2026-11-17 15:19:15") instead of machine-readable Retry-After
 * headers. hummin parses that time so the session can wait out the window and
 * continue automatically instead of dying.
 */

export interface UsageLimitPlan {
	resetAt: Date;
	/** Milliseconds to wait: reset time plus a small buffer, from the given now. */
	waitMs: number;
}

/** Parse the reset time out of a provider usage-limit error message. */
export function parseUsageLimitResetAt(errorMessage: string): Date | undefined {
	if (!/usage limit/i.test(errorMessage)) return undefined;
	const patterns = [
		/will reset at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?)/i,
		/resets? at (\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?)/i,
	];
	for (const pattern of patterns) {
		const match = errorMessage.match(pattern);
		if (!match) continue;
		const parsed = new Date(match[1].replace(" ", "T"));
		if (!Number.isNaN(parsed.getTime())) return parsed;
	}
	return undefined;
}

/**
 * Wait plan for a detected reset: reset time plus a 30-second buffer. Undefined
 * when the reset already passed (nothing to wait for) or the wait exceeds the
 * configured cap (surfacing the failure is better than hanging the session).
 */
export function planUsageLimitWait(
	resetAt: Date,
	maxWaitMinutes: number,
	now = new Date(),
): UsageLimitPlan | undefined {
	const waitMs = resetAt.getTime() - now.getTime() + 30_000;
	if (waitMs <= 0) return undefined;
	if (waitMs > maxWaitMinutes * 60_000) return undefined;
	return { resetAt, waitMs };
}
