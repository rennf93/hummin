/**
 * App: the console shell. One SSE connection per registered host folds its
 * frames into the per-host store; the active host's slices drive the header,
 * transcript (renderer's TranscriptList, including the live slot and tool
 * cards), the approval cards, and the composer. The host registry and
 * appearance prefs live browser-side (localStorage); the appearance panel
 * edits the same prefs live (applied to the document root and persisted on
 * every change). Adding a cross-origin host registers this page's origin on
 * it (POST /settings/console-origins) so fleet aggregation passes CSP; a
 * failed registration surfaces as a non-fatal hint on that host's rail row.
 * Connections rebuild only when a host's identity (origin or token) changes,
 * never on label edits.
 */
/// <reference lib="dom" />
import { useCallback, useEffect, useReducer, useState } from "react";
import {
	connectSse,
	parseProtocolEvent,
	postAbort,
	postApproval,
	postConsoleOrigin,
	postPrompt,
} from "./connection.ts";
import { ApprovalCard } from "./components/ApprovalCard.tsx";
import { AppearancePanel } from "./components/AppearancePanel.tsx";
import { Composer } from "./components/Composer.tsx";
import { Header } from "./components/Header.tsx";
import { HostRail, type AddHostInput } from "./components/HostRail.tsx";
import type { Appearance, HostEntry } from "./hosts.ts";
import {
	addHost,
	adoptLocalHost,
	applyAppearance,
	listHosts,
	loadAppearance,
	removeHost,
	saveAppearance,
} from "./hosts.ts";
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
	const [hosts, setHosts] = useState<readonly HostEntry[]>(() => {
		// One-click enrollment: a /remote-control URL carries the current bearer
		// token for its own origin in the fragment; adopt it before reading the
		// registry so opening the URL connects immediately. When the registry
		// write failed (private mode, full quota), the adopted entry still
		// connects: it is kept in memory for this session.
		const adopted = adoptLocalHost(window.location.hash, window.location, window.history);
		const list = listHosts();
		if (adopted !== null && !list.some((host) => host.id === adopted.id)) return [adopted, ...list];
		return list;
	});
	const [activeId, setActiveId] = useState<string | null>(null);
	const [appearance, setAppearance] = useState<Appearance>(loadAppearance);
	const [panelOpen, setPanelOpen] = useState(false);
	/** Per-host console-origin registration failure detail; a successful
	 * registration stays silent. */
	const [originWarnings, setOriginWarnings] = useState<Record<string, string>>({});
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

	const handleAdd = useCallback(
		(input: AddHostInput) => {
			const entry = addHost(input);
			setHosts(listHosts());
			if (entry.origin === window.location.origin) return;
			// Fleet enrollment: the host must allow this console page's origin in
			// its CORS registry or every cross-origin request fails CSP. Best
			// effort: failure is a rail hint, never a broken add.
			void postConsoleOrigin({ origin: entry.origin, token: entry.token, consoleOrigin: window.location.origin }).then(
				(result) => {
					if (result.ok) return;
					setOriginWarnings((current) => ({
						...current,
						[entry.id]: result.status === 0 ? "network error" : `status ${result.status}`,
					}));
				},
			);
		},
		[setHosts],
	);

	const handleRemove = useCallback(
		(hostId: string) => {
			removeHost(hostId);
			setOriginWarnings((current) => {
				if (!(hostId in current)) return current;
				const next = { ...current };
				delete next[hostId];
				return next;
			});
			setHosts(listHosts());
		},
		[setHosts],
	);

	const handlePreset = useCallback((preset: Appearance["preset"]) => {
		setAppearance((current) => ({ ...current, preset }));
	}, [setAppearance]);

	// Panel edits apply through the same appearance effect as the quick-switch.
	const handleAppearance = useCallback((patch: Partial<Appearance>) => {
		setAppearance((current) => ({ ...current, ...patch }));
	}, [setAppearance]);

	const openAppearance = useCallback(() => setPanelOpen(true), [setPanelOpen]);
	const closeAppearance = useCallback(() => setPanelOpen(false), [setPanelOpen]);

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
		(id: string, allow: boolean) => {
			if (activeHost === undefined) return;
			void postApproval({ origin: activeHost.origin, token: activeHost.token, id, allow });
		},
		[activeHost],
	);

	return (
			<div className="rc-shell" data-rc-shell="rail">
				<nav className="rc-rail" aria-label="hosts">
					<HostRail
						hosts={hosts}
						states={store}
						activeId={activeId}
						originWarnings={originWarnings}
						onSelect={selectHost}
						onAdd={handleAdd}
						onRemove={handleRemove}
					/>
				</nav>
				<div className="rc-main">
					<header className="rc-header" data-rc-region="header">
						<Header state={activeState} preset={appearance.preset} onPreset={handlePreset} onOpenAppearance={openAppearance} />
					</header>
					<main className="rc-transcript" data-rc-region="transcript">
						<TranscriptList entries={activeState?.entries ?? []} slot={activeState?.slot ?? null} toolUpdates={activeState?.toolUpdates} />
					</main>
					<footer className="rc-composer" data-rc-region="composer">
						<ApprovalCard holds={activeState?.holds ?? []} onResolve={resolveApproval} />
						<Composer queue={activeState?.queue ?? null} disabled={activeHost === undefined} onSend={sendPrompt} onAbort={abort} />
					</footer>
				</div>
				{panelOpen && <AppearancePanel appearance={appearance} onChange={handleAppearance} onClose={closeAppearance} />}
			</div>
	);
}
