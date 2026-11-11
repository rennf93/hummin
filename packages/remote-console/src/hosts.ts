/**
 * hosts: the browser-side host registry and appearance store. The registry
 * (localStorage key "rc.hosts") holds one entry per hummin endpoint: label,
 * origin, and the bearer token. Tokens live only in this browser and are sent
 * only as the Authorization header to their own host. Appearance preferences
 * (localStorage key "rc.appearance") carry the Phase D panel shape now:
 * preset, accent hue, and motion axes, applied to the document root
 * by App.
 */
/// <reference lib="dom" />

const HOSTS_KEY = "rc.hosts";
const APPEARANCE_KEY = "rc.appearance";

export interface HostEntry {
	id: string;
	label: string;
	origin: string;
	token: string;
}

export type RemoteConsolePreset = "studio" | "glass" | "paper" | "terminal";

export type MotionPreference = "auto" | "off";

export interface Appearance {
	preset: RemoteConsolePreset;
	accentHue: number;
	motion: MotionPreference;
}

export const DEFAULT_APPEARANCE: Appearance = { preset: "studio", accentHue: 190, motion: "auto" };

/** Last seen event older than this marks a connected stream stale. */
export const STALE_AFTER_MS = 30_000;

/** Normalizes an origin into the base URL the console fetches: trimmed, with
 * one trailing slash at most. */
export function normalizeOrigin(raw: string): string {
	return raw.trim().replace(/\/+$/, "");
}

const ORIGIN_ERROR = "origin must be an http(s) URL, e.g. http://127.0.0.1:8080";

/** Strict origin: an absolute http(s) URL reduced to `url.origin`, so
 * `http://x` and `http://x:80` are one host. Throws on anything else. */
function parseOrigin(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new Error(ORIGIN_ERROR);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(ORIGIN_ERROR);
	return url.origin;
}

/** The /remote-control URL fragment is the server's token: 32 random bytes as
 * hex (extensions/lib/remote-console/index.ts). Accepting any base64url-safe
 * string of 32+ characters stays conservative without pinning the encoding. */
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{32,}$/;

/** Parses raw localStorage JSON into entries. Unparsable or malformed records
 * are dropped (the registry is a trust boundary: values come from storage). */
export function parseHosts(raw: string | null): HostEntry[] {
	if (raw === null || raw.trim() === "") return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const hosts: HostEntry[] = [];
	for (const item of parsed) {
		const entry = parseHost(item);
		if (entry === null) continue;
		// Later entries repeating an id or origin are dropped: ids key the store, origins key the connection.
		if (hosts.some((host) => host.id === entry.id || host.origin === entry.origin)) continue;
		hosts.push(entry);
	}
	return hosts;
}

function parseHost(item: unknown): HostEntry | null {
	if (typeof item !== "object" || item === null) return null;
	const record = item as Record<string, unknown>;
	const id = typeof record.id === "string" ? record.id : "";
	let origin = "";
	try {
		origin = typeof record.origin === "string" ? parseOrigin(record.origin) : "";
	} catch {
		return null;
	}
	const token = typeof record.token === "string" ? record.token : "";
	const label =
		typeof record.label === "string" && record.label.trim() !== "" ? record.label.trim() : hostLabel(origin);
	if (id === "" || origin === "" || token === "") return null;
	return { id, label, origin, token };
}

/** Fallback label: the host part of the origin, or the origin itself. */
function hostLabel(origin: string): string {
	try {
		return new URL(origin).host;
	} catch {
		return origin;
	}
}

/** Reads the registry from localStorage. */
export function listHosts(): HostEntry[] {
	return parseHosts(localStorage.getItem(HOSTS_KEY));
}

/** Best-effort persistence: localStorage writes throw in Safari private mode
 * and when the quota is full, and losing a registry edit is better than
 * breaking the session, so the failure is swallowed. */
function writeHosts(hosts: readonly HostEntry[]): void {
	try {
		localStorage.setItem(HOSTS_KEY, JSON.stringify(hosts));
	} catch {
		// Unavailable storage: the registry stays in memory for this session.
	}
}

/** Adds a host with a fresh id; the origin must be an absolute http(s) URL. */
export function addHost(input: { label: string; origin: string; token: string }): HostEntry {
	if (input.origin.trim() === "") throw new Error("origin is required");
	const origin = parseOrigin(input.origin);
	if (input.token.trim() === "") throw new Error("token is required");
	const hosts = listHosts();
	if (hosts.some((host) => host.origin === origin)) throw new Error(`host for ${origin} already exists`);
	const entry: HostEntry = {
		id: crypto.randomUUID(),
		label: input.label.trim() !== "" ? input.label.trim() : hostLabel(origin),
		origin,
		token: input.token.trim(),
	};
	writeHosts([...hosts, entry]);
	return entry;
}

/** Updates the mutable fields of one host; unknown ids are a no-op. */
export function updateHost(id: string, patch: Partial<Pick<HostEntry, "label" | "origin" | "token">>): void {
	const hosts = listHosts();
	const next = hosts.map((host) => {
		if (host.id !== id) return host;
		const origin = patch.origin !== undefined ? parseOrigin(patch.origin) : host.origin;
		if (origin !== host.origin && hosts.some((other) => other.origin === origin))
			throw new Error(`host for ${origin} already exists`);
		return {
			...host,
			label: patch.label !== undefined && patch.label.trim() !== "" ? patch.label.trim() : host.label,
			origin,
			token: patch.token !== undefined && patch.token.trim() !== "" ? patch.token.trim() : host.token,
		};
	});
	writeHosts(next);
}

/** Removes one host by id; unknown ids are a no-op. */
export function removeHost(id: string): void {
	writeHosts(listHosts().filter((host) => host.id !== id));
}

/** Adopts the fragment token of a /remote-control URL for the page's own
 * origin: opening that URL is the intended one-click enrollment for the local
 * host. Upserts, because every /remote-control start rotates the token - an
 * existing registry entry for this origin gets the fresh token instead of a
 * duplicate error. The registry write is best-effort: when storage is
 * unavailable (private mode, full quota) the entry is still returned so the
 * session connects, and the fragment is stripped from the address bar either
 * way - the token must never stay in the URL or history. Returns the adopted
 * entry, or null when the fragment is not a server token. */
export function adoptLocalHost(fragment: string, location: Location, history: History): HostEntry | null {
	const token = fragment.replace(/^#/, "").trim();
	// Any other fragment (an anchor, a foreign token) is not ours: leave it in the URL.
	if (!TOKEN_FORMAT.test(token)) return null;
	const origin = normalizeOrigin(location.origin);
	const existing = listHosts().find((host) => host.origin === origin);
	let entry: HostEntry;
	try {
		if (existing !== undefined) {
			if (existing.token !== token) updateHost(existing.id, { token });
			entry = { ...existing, token };
		} else {
			entry = addHost({ label: hostLabel(origin), origin, token });
		}
	} catch {
		// Registry write failed (storage unavailable): keep the entry in memory.
		entry =
			existing !== undefined
				? { ...existing, token }
				: { id: crypto.randomUUID(), label: hostLabel(origin), origin, token };
	}
	history.replaceState(null, "", location.pathname + location.search);
	return entry;
}

/** Parses raw localStorage JSON into the appearance shape, with defaults for
 * missing or out-of-range fields (storage is a trust boundary). Records saved
 * before the motion axis existed parse as "auto". */
export function parseAppearance(raw: string | null): Appearance {
	if (raw === null || raw.trim() === "") return DEFAULT_APPEARANCE;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return DEFAULT_APPEARANCE;
	}
	if (typeof parsed !== "object" || parsed === null) return DEFAULT_APPEARANCE;
	const record = parsed as Record<string, unknown>;
	const preset: RemoteConsolePreset =
		record.preset === "glass" || record.preset === "paper" || record.preset === "terminal" ? record.preset : "studio";
	const accentHue = numberInRange(record.accentHue, 0, 360, DEFAULT_APPEARANCE.accentHue);
	const motion: MotionPreference = record.motion === "off" ? "off" : "auto";
	return { preset, accentHue, motion };
}

function numberInRange(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return fallback;
	return value;
}

/** Live-edit clamp for the accent hue axis: integer hue in 0-360. */
export function clampAccentHue(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_APPEARANCE.accentHue;
	return Math.min(360, Math.max(0, Math.round(value)));
}

/** Reads the appearance prefs from localStorage. */
export function loadAppearance(): Appearance {
	return parseAppearance(localStorage.getItem(APPEARANCE_KEY));
}

/** Persists the appearance prefs to localStorage; best-effort like the host
 * registry (private mode and quota errors must not break the panel). */
export function saveAppearance(appearance: Appearance): void {
	try {
		localStorage.setItem(APPEARANCE_KEY, JSON.stringify(appearance));
	} catch {
		// Unavailable storage: the prefs stay in memory for this session.
	}
}

/** Applies appearance prefs to the document root: the preset switches the
 * token sheet via data-rc-preset; the hue axis is a root custom property;
 * motion="off" sets data-rc-motion so tokens.css zeroes the duration tokens. */
export function applyAppearance(root: HTMLElement, appearance: Appearance): void {
	root.dataset.rcPreset = appearance.preset;
	root.dataset.rcMotion = appearance.motion;
	root.style.setProperty("--rc-accent-hue", String(appearance.accentHue));
	// An older build left an inline density; drop it so the token sheet default applies.
	root.style.removeProperty("--rc-density");
}
