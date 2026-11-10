/**
 * App: the console shell. One SSE connection per registered host folds its
 * frames into the per-host store; the active host's slices drive the header,
 * transcript (renderer's TranscriptList, including the live slot and tool
 * cards), the approval card, and the composer. The host registry and
 * appearance prefs live browser-side (localStorage); connections rebuild only
 * when a host's identity (origin or token) changes, never on label edits.
 */
/// <reference lib="dom" />
import { useCallback, useEffect, useReducer, useState } from "react";
import {
	connectSse,
	parseProtocolEvent,
	postAbort,
	postApproval,
	postPrompt,
} from "./connection.ts";
import { ApprovalCard } from "./components/ApprovalCard.tsx";
import { Composer } from "./components/Composer.tsx";
import { Header } from "./components/Header.tsx";
import { HostRail, type AddHostInput } from "./components/HostRail.tsx";
import type { Appearance, HostEntry } from "./hosts.ts";
import { addHost, applyAppearance, listHosts, loadAppearance, removeHost, saveAppearance } from "./hosts.ts";
import { TranscriptList } from "./renderer/transcript/TranscriptList.tsx";
import { reduceHosts } from "./store.ts";
import "./shell.css";

/** The identity a connection needs; label is registry display only. */
interface ConnectionSpec {
	hostId: string;
	origin: string;
	token: string;
}

function specsEqual(a: readonly ConnectionSpec[], b: readonly ConnectionSpec[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((spec, index) => spec.hostId === b[index]?.hostId && spec.origin === b[index]?.origin && spec.token === b[index]?.token);
}

export function App() {
	const [hosts, setHosts] = useState<readonly HostEntry[]>(() => listHosts());
	const [activeId, setActiveId] = useState<string | null>(null);
	const [appearance, setAppearance] = useState<Appearance>(loadAppearance);
	const [specs, setSpecs] = useState<readonly ConnectionSpec[]>([]);
	const [store, dispatch] = useReducer(reduceHosts, {});

	// Registry changes fold into the store's identity slices.
	useEffect(() => {
		for (const host of hosts) dispatch({ type: "ensure", hostId: host.id, label: host.label, origin: host.origin });
	}, [hosts, dispatch]);

	// Selection follows the registry: the first host unless the user picked one.
	useEffect(() => {
		setActiveId((current) => (current !== null && hosts.some((host) => host.id === current) ? current : (hosts[0]?.id ?? null)));
	}, [hosts]);

	// Connection specs track identity only: label edits must not reconnect.
	useEffect(() => {
		const next = hosts.map((host) => ({ hostId: host.id, origin: host.origin, token: host.token }));
		setSpecs((previous) => (specsEqual(previous, next) ? previous : next));
	}, [hosts]);

	// One SSE connection per host for the lifetime of its identity.
	useEffect(() => {
		const connections = specs.map((spec) =>
			connectSse({
				origin: spec.origin,
				token: spec.token,
				onFrame: (frame) => {
					const event = parseProtocolEvent(frame);
					if (event !== null) dispatch({ type: "event", hostId: spec.hostId, event, receivedAt: Date.now() });
				},
				onState: (state) => dispatch({ type: "connection", hostId: spec.hostId, state }),
			}),
		);
		return () => {
			for (const connection of connections) connection.close();
		};
	}, [specs, dispatch]);

	// Appearance applies to the document root and persists per browser install.
	useEffect(() => {
		applyAppearance(document.documentElement, appearance);
		saveAppearance(appearance);
	}, [appearance]);

	const activeState = activeId !== null ? store[activeId] : undefined;
	const activeHost = hosts.find((host) => host.id === activeId);

	const selectHost = useCallback((hostId: string) => setActiveId(hostId), [setActiveId]);

	const handleAdd = useCallback((input: AddHostInput) => {
		addHost(input);
		setHosts(listHosts());
	}, [setHosts]);

	const handleRemove = useCallback((hostId: string) => {
		removeHost(hostId);
		setHosts(listHosts());
	}, [setHosts]);

	const handlePreset = useCallback((preset: Appearance["preset"]) => {
		setAppearance((current) => ({ ...current, preset }));
	}, [setAppearance]);

	const sendPrompt = useCallback(
		(text: string, deliverAs: "steer" | "followUp") => {
			if (activeHost === undefined) return;
			void postPrompt({ origin: activeHost.origin, token: activeHost.token, id: crypto.randomUUID(), text, deliverAs });
		},
		[activeHost],
	);

	const abort = useCallback(() => {
		if (activeHost === undefined) return;
		void postAbort({ origin: activeHost.origin, token: activeHost.token, id: crypto.randomUUID() });
	}, [activeHost]);

	const resolveApproval = useCallback(
		(allow: boolean) => {
			const approval = activeState?.approval;
			if (activeHost === undefined || approval === undefined || approval === null) return;
			void postApproval({ origin: activeHost.origin, token: activeHost.token, id: approval.id, allow });
		},
		[activeHost, activeState],
	);

	return (
		<div className="rc-shell" data-rc-shell="rail">
			<nav className="rc-rail" aria-label="hosts">
				<HostRail hosts={hosts} states={store} activeId={activeId} onSelect={selectHost} onAdd={handleAdd} onRemove={handleRemove} />
			</nav>
			<div className="rc-main">
				<header className="rc-header" data-rc-region="header">
					<Header state={activeState} preset={appearance.preset} onPreset={handlePreset} />
				</header>
				<main className="rc-transcript" data-rc-region="transcript">
					<TranscriptList entries={activeState?.entries ?? []} slot={activeState?.slot ?? null} toolUpdates={activeState?.toolUpdates} />
				</main>
				<footer className="rc-composer" data-rc-region="composer">
					<ApprovalCard approval={activeState?.approval ?? null} onResolve={resolveApproval} />
					<Composer queue={activeState?.queue ?? null} disabled={activeHost === undefined} onSend={sendPrompt} onAbort={abort} />
				</footer>
			</div>
		</div>
	);
}
