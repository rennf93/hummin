/**
 * attention: how the console asks for a glance when the tab is in the
 * background (DESIGN.md 7). The tab title carries the session name and the
 * count of waiting approvals, the favicon gets a dot (warn while an approval
 * waits, primary while the run works), and an opt-in system notification fires
 * once per new hold while the tab is hidden. The opt-in lives in localStorage
 * ("rc.notify": "on" | "off"); every access is best-effort like hosts.ts.
 */
/// <reference lib="dom" />
import { useEffect, useRef } from "react";
import type { WireApproval } from "./harness/replay-log.ts";

const NOTIFY_KEY = "rc.notify";
const ICON_HREF = "./icons/favicon-64.png";
const ICON_SIZE = 64;
const DOT_SIZE = 20;
const ARGS_SUMMARY_CHARS = 80;

export type AttentionState = "idle" | "working" | "approval";

export function formatTitle(sessionName: string | null, hostLabel: string | null, pendingApprovals: number): string {
	const name = sessionName || hostLabel || "hummin console";
	return pendingApprovals > 0 ? `(${pendingApprovals}) Approval - ${name} - hummin` : `${name} - hummin`;
}

let iconImage: Promise<HTMLImageElement> | null = null;

function loadIcon(): Promise<HTMLImageElement> {
	iconImage ??= new Promise((resolve, reject) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error("favicon failed to load"));
		image.src = ICON_HREF;
	});
	return iconImage;
}

/** The favicon href for a state: the plain icon when idle, else the icon with a corner dot as a data URL. */
export async function faviconHref(state: AttentionState, colors: { warn: string; primary: string }): Promise<string> {
	if (state === "idle") return ICON_HREF;
	const image = await loadIcon();
	const canvas = document.createElement("canvas");
	canvas.width = ICON_SIZE;
	canvas.height = ICON_SIZE;
	const context = canvas.getContext("2d");
	if (context === null) return ICON_HREF;
	context.drawImage(image, 0, 0, ICON_SIZE, ICON_SIZE);
	context.fillStyle = state === "approval" ? colors.warn : colors.primary;
	context.beginPath();
	context.arc(ICON_SIZE - DOT_SIZE / 2, ICON_SIZE - DOT_SIZE / 2, DOT_SIZE / 2, 0, Math.PI * 2);
	context.fill();
	return canvas.toDataURL("image/png");
}

export function loadNotify(): boolean {
	try {
		return localStorage.getItem(NOTIFY_KEY) === "on";
	} catch {
		return false;
	}
}

export function saveNotify(on: boolean): void {
	try {
		localStorage.setItem(NOTIFY_KEY, on ? "on" : "off");
	} catch {
		// Private mode or full quota: the choice lasts until reload only.
	}
}

/** Notifications can be shown right now: opted in, secure, granted, and the tab is hidden. */
function canNotify(): boolean {
	return (
		loadNotify() &&
		window.isSecureContext &&
		"Notification" in window &&
		Notification.permission === "granted" &&
		document.hidden
	);
}

function notifyHold(name: string, hold: WireApproval): void {
	const firstLine = hold.argsPreview.split("\n")[0] ?? "";
	const summary = firstLine.length > ARGS_SUMMARY_CHARS ? `${firstLine.slice(0, ARGS_SUMMARY_CHARS)}...` : firstLine;
	const note = new Notification(`Approval needed - ${name}`, { body: `${hold.toolName}: ${summary}`, tag: hold.id });
	note.onclick = () => {
		window.focus();
		note.close();
	};
}

export function useAttention({
	sessionName,
	hostLabel,
	holds,
	working,
	ready,
	scope,
}: {
	sessionName: string | null;
	hostLabel: string | null;
	holds: readonly WireApproval[];
	working: boolean;
	/** The active host's first snapshot has landed: holds are real, not the pre-snapshot empty list. */
	ready: boolean;
	/** Identifies the host and session the holds belong to; a change re-seeds. */
	scope: string;
}): void {
	const state: AttentionState = holds.length > 0 ? "approval" : working ? "working" : "idle";
	const title = formatTitle(sessionName, hostLabel, holds.length);
	useEffect(() => {
		document.title = title;
	}, [title]);

	useEffect(() => {
		let stale = false;
		const root = getComputedStyle(document.documentElement);
		const colors = {
			warn: root.getPropertyValue("--rc-warn").trim(),
			primary: root.getPropertyValue("--rc-primary").trim(),
		};
		faviconHref(state, colors).then(
			(href) => {
				const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
				if (!stale && link !== null && link.getAttribute("href") !== href) link.setAttribute("href", href);
			},
			() => undefined,
		);
		return () => {
			stale = true;
		};
	}, [state]);

	// Holds present when a scope first becomes ready are seeded as seen, so only later arrivals notify.
	const seen = useRef<{ scope: string; ids: Set<string> } | null>(null);
	useEffect(() => {
		if (!ready) {
			seen.current = null;
			return;
		}
		if (seen.current === null || seen.current.scope !== scope) {
			seen.current = { scope, ids: new Set(holds.map((hold) => hold.id)) };
			return;
		}
		for (const hold of holds) {
			if (seen.current.ids.has(hold.id)) continue;
			seen.current.ids.add(hold.id);
			if (canNotify()) notifyHold(sessionName || hostLabel || "hummin console", hold);
		}
	}, [holds, sessionName, hostLabel, ready, scope]);
}
