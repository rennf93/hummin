/**
 * hosts: the browser-side host registry and appearance store. The registry
 * (localStorage key "rc.hosts") holds one entry per hummin endpoint: label,
 * origin, and the bearer token. Tokens live only in this browser and are sent
 * only as the Authorization header to their own host. Appearance preferences
 * (localStorage key "rc.appearance") carry the Phase D panel shape now:
 * preset, accent hue, density, and motion axes, applied to the document root
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

export type RemoteConsolePreset = "glass" | "paper" | "terminal";

export type MotionPreference = "auto" | "off";

export interface Appearance {
	preset: RemoteConsolePreset;
	accentHue: number;
	density: number;
	motion: MotionPreference;
}

export const DEFAULT_APPEARANCE: Appearance = { preset: "glass", accentHue: 190, density: 1, motion: "auto" };

/** Last seen event older than this marks a connected stream stale. */
export const STALE_AFTER_MS = 30_000;

/** Normalizes an origin into the base URL the console fetches: trimmed, with
 * one trailing slash at most. */
export function normalizeOrigin(raw: string): string {
	return raw.trim().replace(/\/+$/, "");
}

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
		if (entry !== null) hosts.push(entry);
	}
	return hosts;
}

function parseHost(item: unknown): HostEntry | null {
	if (typeof item !== "object" || item === null) return null;
	const record = item as Record<string, unknown>;
	const id = typeof record.id === "string" ? record.id : "";
	const origin = typeof record.origin === "string" ? normalizeOrigin(record.origin) : "";
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

function writeHosts(hosts: readonly HostEntry[]): void {
	localStorage.setItem(HOSTS_KEY, JSON.stringify(hosts));
}

/** Adds a host with a fresh id; the origin must parse as an absolute URL. */
export function addHost(input: { label: string; origin: string; token: string }): HostEntry {
	const origin = normalizeOrigin(input.origin);
	if (origin === "") throw new Error("origin is required");
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
		const origin = patch.origin !== undefined ? normalizeOrigin(patch.origin) : host.origin;
		return {
			...host,
			label: patch.label !== undefined && patch.label.trim() !== "" ? patch.label.trim() : host.label,
			origin,
			token: patch.token !== undefined && patch.token.trim() !== "" ? patch.token : host.token,
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
 * duplicate error. Strips the fragment afterwards so the token never stays in
 * the address bar or history. Returns the adopted entry, or null when the
 * fragment carries no token. */
export function adoptLocalHost(fragment: string, location: Location, history: History): HostEntry | null {
	const token = fragment.replace(/^#/, "").trim();
	if (token === "") return null;
	const origin = normalizeOrigin(location.origin);
	const existing = listHosts().find((host) => host.origin === origin);
	let entry: HostEntry;
	if (existing !== undefined) {
		if (existing.token !== token) updateHost(existing.id, { token });
		entry = { ...existing, token };
	} else {
		entry = addHost({ label: hostLabel(origin), origin, token });
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
	const preset = record.preset === "paper" || record.preset === "terminal" ? record.preset : "glass";
	const accentHue = numberInRange(record.accentHue, 0, 360, DEFAULT_APPEARANCE.accentHue);
	const density = numberInRange(record.density, 0.5, 2, DEFAULT_APPEARANCE.density);
	const motion: MotionPreference = record.motion === "off" ? "off" : "auto";
	return { preset, accentHue, density, motion };
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

/** Live-edit clamp for the density axis: the 0.05 grid between 0.5 and 2. */
export function clampDensity(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_APPEARANCE.density;
	return Math.min(2, Math.max(0.5, Math.round(value * 20) / 20));
}

/** Reads the appearance prefs from localStorage. */
export function loadAppearance(): Appearance {
	return parseAppearance(localStorage.getItem(APPEARANCE_KEY));
}

/** Persists the appearance prefs to localStorage. */
export function saveAppearance(appearance: Appearance): void {
	localStorage.setItem(APPEARANCE_KEY, JSON.stringify(appearance));
}

/** Applies appearance prefs to the document root: the preset switches the
 * token sheet via data-rc-preset; the two axes are root custom properties;
 * motion="off" sets data-rc-motion so tokens.css zeroes the duration tokens. */
export function applyAppearance(root: HTMLElement, appearance: Appearance): void {
	root.dataset.rcPreset = appearance.preset;
	root.dataset.rcMotion = appearance.motion;
	root.style.setProperty("--rc-accent-hue", String(appearance.accentHue));
	root.style.setProperty("--rc-density", String(appearance.density));
}
