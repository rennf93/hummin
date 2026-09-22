import { type Model, modelsAreEqual } from "@earendil-works/pi-ai";
import {
	Container,
	type Focusable,
	getKeybindings,
	type Input,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { ModelRuntime } from "../../../core/model-runtime.ts";
import { SettingsManager } from "../../../core/settings-manager.ts";
import { refreshModelCatalogs } from "../model-catalog-refresh.ts";
import { getModelSelectorSearchText } from "../model-search.ts";
import { getSettingsListTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyDisplayText } from "./keybinding-hints.ts";
import { type SettingsCategory, SettingsTabBar } from "./settings-selector.ts";

interface ModelItem {
	provider: string;
	id: string;
	model: Model<any> & HumminModelMetadata;
}

interface HumminModelMetadata {
	humminHost?: string;
	humminOffline?: boolean;
}

interface ScopedModelItem {
	model: Model<any>;
	thinkingLevel?: string;
}

interface DefaultModelReference {
	provider: string;
	id: string;
}

type ModelScope = "all" | "scoped";

const SCOPE_TABS: readonly SettingsCategory[] = [
	{ id: "all", label: "All" },
	{ id: "scoped", label: "Scoped" },
];

/** Max width of the model-name column before the value column starts. */
const LABEL_MAX_WIDTH = 46;

/** Result contract for starting an offline fleet server from the picker.
 * Implemented by the hummin-fleet extension (shared fleet-actions lib). */
export interface OfflineFleetStartResult {
	ok: boolean;
	detail: string;
	cancelled?: boolean;
}

export type OfflineFleetStarter = (serverId: string, signal: AbortSignal) => Promise<OfflineFleetStartResult>;

/** Core cannot import extension code (build rootDir), so the hummin-fleet
 * extension hands the picker its start action through this well-known key. */
const OFFLINE_FLEET_STARTER_KEY = "__humminOfflineFleetStarter";

function getOfflineFleetStarter(): OfflineFleetStarter | undefined {
	const value = (globalThis as Record<string, unknown>)[OFFLINE_FLEET_STARTER_KEY];
	return typeof value === "function" ? (value as OfflineFleetStarter) : undefined;
}

/** Resolve the fleet server behind an offline hummin-local model by matching
 * the model endpoint's host/port against the configured fleet.servers. */
function findFleetServerForModel(model: Model<any> & HumminModelMetadata): { id: string; label: string } | undefined {
	if (!model.baseUrl) return undefined;
	try {
		const url = new URL(model.baseUrl);
		const port = Number(url.port);
		if (!port) return undefined;
		const servers = SettingsManager.create(process.cwd()).getFleetServers();
		const match = servers.find((server) => server.hostIp === url.hostname && server.port === port);
		return match ? { id: match.id, label: match.label ?? match.id } : undefined;
	} catch {
		return undefined;
	}
}

function formatContextWindow(ctx: number | undefined): string {
	if (!ctx || ctx <= 0) return "";
	if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	if (ctx >= 1000) return `${Math.round(ctx / 1000)}K`;
	return `${ctx}`;
}

/**
 * Component that renders a model selector in the settings-view style:
 * a scope tab bar, an aligned two-column table with search, a description
 * pane for the selected model, and a hint line.
 */
export class ModelSelectorComponent extends Container implements Focusable {
	// Focusable implementation - propagate to the search input for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		const input = this.settingsList.getSearchInput();
		if (input) input.focused = value;
	}

	private settingsList: SettingsList;
	private tabBar?: SettingsTabBar;
	private statusContainer: Container;
	private allModels: ModelItem[] = [];
	private scopedModelItems: ModelItem[] = [];
	private activeModels: ModelItem[] = [];
	private currentModel?: Model<any>;
	private modelRuntime: ModelRuntime;
	private onSelectCallback: (model: Model<any>) => void;
	private onSelectAsDefaultCallback?: (model: Model<any>) => void;
	private onCancelCallback: () => void;
	private errorMessage?: string;
	private refreshStatusMessage = "Refreshing model catalogs…";
	private refreshStatusSuccess = false;
	private tui: TUI;
	private scopedModels: ReadonlyArray<ScopedModelItem>;
	private defaultModel?: DefaultModelReference;
	private scope: ModelScope = "all";
	private readonly refreshAbortController = new AbortController();
	private refreshTimeout?: ReturnType<typeof setTimeout>;
	private closed = false;
	private startingOfflineServer = false;
	private startAbort?: AbortController;
	/** Extra search text per item id (model id, provider, name, default keyword). */
	private readonly searchTexts = new Map<string, string>();

	constructor(
		tui: TUI,
		currentModel: Model<any> | undefined,
		modelRuntime: ModelRuntime,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		onSelect: (model: Model<any>) => void,
		onCancel: () => void,
		initialSearchInput?: string,
		onSelectAsDefault?: (model: Model<any>) => void,
		defaultModel?: DefaultModelReference,
	) {
		super();

		this.tui = tui;
		this.currentModel = currentModel;
		this.modelRuntime = modelRuntime;
		this.scopedModels = scopedModels;
		this.defaultModel = defaultModel;
		this.scope = scopedModels.length > 0 ? "scoped" : "all";
		this.onSelectCallback = onSelect;
		this.onSelectAsDefaultCallback = onSelectAsDefault;
		this.onCancelCallback = onCancel;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		if (scopedModels.length > 0) {
			this.tabBar = new SettingsTabBar(SCOPE_TABS, this.scope, (id) => {
				if (id === "all" || id === "scoped") this.setScope(id);
			});
			this.addChild(this.tabBar);
		} else {
			const hintText = "Only showing models from configured providers. Use /login to add providers.";
			this.addChild(new Text(theme.fg("warning", `  ${hintText}`), 0, 0));
		}
		this.addChild(new Spacer(1));

		const hintParts = ["Type to search", "Enter to select"];
		if (onSelectAsDefault) hintParts.push(`${keyDisplayText("app.models.save")} to set as default`);
		hintParts.push("Esc to cancel");

		this.settingsList = new SettingsList(
			[],
			10,
			getSettingsListTheme(),
			() => {},
			() => {
				this.dispose();
				this.onCancelCallback();
			},
			{
				enableSearch: true,
				initialSearch: initialSearchInput,
				hint: hintParts.join(" · "),
				emptyMessage: "No models available",
				noMatchMessage: "No matching models",
				maxLabelWidth: LABEL_MAX_WIDTH,
				searchText: (item) => this.searchTexts.get(item.id) ?? item.label,
			},
		);
		this.addChild(this.settingsList);

		this.statusContainer = new Container();
		this.addChild(this.statusContainer);

		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		// Render the current snapshot immediately, then refresh in the background.
		this.loadModelsFromSnapshot();
		this.updateStatus();
		this.tui.requestRender();
		void this.refreshModels();
	}

	private loadModelsFromSnapshot(): void {
		const models = this.modelRuntime.getAvailableSnapshot().map((model: Model<any>) => ({
			provider: model.provider,
			id: model.id,
			model: model as Model<any> & HumminModelMetadata,
		}));
		this.allModels = this.sortModels(models);
		this.scopedModels = this.scopedModels.map((scoped) => {
			const refreshed = this.modelRuntime.getModel(scoped.model.provider, scoped.model.id);
			return refreshed ? { ...scoped, model: refreshed } : scoped;
		});
		this.scopedModelItems = this.scopedModels.map((scoped) => ({
			provider: scoped.model.provider,
			id: scoped.model.id,
			model: scoped.model as Model<any> & HumminModelMetadata,
		}));
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		this.rebuildItems();
	}

	/** Rebuild the settings-list rows from the active model set, keeping the
	 * current model selected when it is present. */
	private rebuildItems(): void {
		this.searchTexts.clear();
		const items: SettingItem[] = this.activeModels.map((item) => {
			const key = `${item.provider}/${item.id}`;
			const isCurrent = modelsAreEqual(this.currentModel, item.model);
			const isDefault = this.isDefaultModel(item.model);
			// Rows show the human name when one exists (the hummin local provider extension
			// puts engine + format there); the id stays in the search text.
			const rowLabel = item.model.name && item.model.name !== item.id ? item.model.name : item.id;
			const marker = isCurrent ? theme.fg("accent", "✓ ") : "";
			const plainWidth = LABEL_MAX_WIDTH - (isCurrent ? 2 : 0);
			const label = `${marker}${truncateToWidth(rowLabel, plainWidth, "")}`;
			const providerName = this.modelRuntime.getProvider(item.provider)?.name ?? item.provider;
			const ctxLabel = formatContextWindow(item.model.contextWindow);
			const valueParts = [ctxLabel, providerName, isDefault ? "default" : undefined];
			this.searchTexts.set(
				key,
				`${getModelSelectorSearchText({ id: item.id, provider: item.provider, name: item.model.name })}${isDefault ? " default" : ""}`,
			);
			return {
				id: key,
				label,
				currentValue: valueParts.filter(Boolean).join(" · "),
				description: this.getModelDescription(item, providerName, isDefault),
				activate: () => this.selectModelByKey(key),
			};
		});
		this.settingsList.setItems(items);
		if (this.currentModel) {
			this.settingsList.selectItem(`${this.currentModel.provider}/${this.currentModel.id}`);
		}
	}

	private getModelDescription(item: ModelItem, providerName: string, isDefault: boolean): string {
		const model = item.model;
		const facts: string[] = [`provider: ${providerName}`];
		const ctx = formatContextWindow(model.contextWindow);
		if (ctx) facts.push(`context: ${ctx}`);
		facts.push(`reasoning: ${model.reasoning ? "yes" : "no"}`);
		const endpoint = model.baseUrl ? model.baseUrl.replace(/^https?:\/\//, "") : undefined;
		if (endpoint) facts.push(`endpoint: ${endpoint}`);
		if (isDefault) facts.push("default");
		if (item.model.humminOffline) facts.push("offline");
		return `${model.name || model.id} — ${facts.join(" · ")}`;
	}

	private updateStatus(): void {
		this.statusContainer.clear();
		if (this.errorMessage) {
			for (const line of this.errorMessage.split("\n")) {
				this.statusContainer.addChild(new Text(theme.fg("error", `  ${line}`), 0, 0));
			}
		} else if (this.refreshStatusMessage) {
			this.statusContainer.addChild(
				new Text(theme.fg(this.refreshStatusSuccess ? "success" : "muted", `  ${this.refreshStatusMessage}`), 0, 0),
			);
		}
	}

	private async refreshModels(): Promise<void> {
		const timeoutMs = 15_000;
		let timedOut = false;
		this.refreshTimeout = setTimeout(() => {
			timedOut = true;
			this.refreshAbortController.abort();
		}, timeoutMs);
		try {
			const result = await refreshModelCatalogs(this.modelRuntime, this.refreshAbortController.signal);
			if (this.closed) return;
			this.refreshStatusMessage = "";
			if (result.aborted && timedOut) {
				this.errorMessage = "Model refresh timed out; showing cached models.";
			} else if (result.errors.size === 1) {
				this.errorMessage = `Could not refresh ${result.errors.keys().next().value}; showing cached models.`;
			} else if (result.errors.size > 1) {
				this.errorMessage = `Could not refresh ${result.errors.size} model catalogs (${[...result.errors.keys()].join(", ")}); showing cached models.`;
			} else {
				this.errorMessage = this.modelRuntime.getError();
				if (!this.errorMessage) {
					this.refreshStatusMessage = "Model catalogs refreshed.";
					this.refreshStatusSuccess = true;
				}
			}
			this.loadModelsFromSnapshot();
			this.updateStatus();
			this.tui.requestRender();
		} catch (error) {
			if (this.closed) return;
			this.refreshStatusMessage = "";
			this.errorMessage = timedOut
				? "Model refresh timed out; showing cached models."
				: `Could not refresh model catalogs: ${error instanceof Error ? error.message : String(error)}`;
			this.updateStatus();
			this.tui.requestRender();
		} finally {
			if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
		}
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
		this.refreshAbortController.abort();
		this.startAbort?.abort();
	}

	private sortModels(models: ModelItem[]): ModelItem[] {
		const curated = (provider: string): boolean =>
			provider === "zai" || provider === "zai-coding-cn" || provider.startsWith("hummin");
		const sorted = [...models];
		// Sort: current model first, default model second, curated providers
		// (zai, hummin) next, then remaining providers alphabetically.
		sorted.sort((a, b) => {
			const aIsCurrent = modelsAreEqual(this.currentModel, a.model);
			const bIsCurrent = modelsAreEqual(this.currentModel, b.model);
			if (aIsCurrent && !bIsCurrent) return -1;
			if (!aIsCurrent && bIsCurrent) return 1;
			const aIsDefault = this.isDefaultModel(a.model);
			const bIsDefault = this.isDefaultModel(b.model);
			if (aIsDefault && !bIsDefault) return -1;
			if (!aIsDefault && bIsDefault) return 1;
			const aCurated = curated(a.provider);
			const bCurated = curated(b.provider);
			if (aCurated && !bCurated) return -1;
			if (!aCurated && bCurated) return 1;
			return a.provider.localeCompare(b.provider);
		});
		return sorted;
	}

	private isDefaultModel(model: Model<any>): boolean {
		return this.defaultModel?.provider === model.provider && this.defaultModel.id === model.id;
	}

	private setScope(scope: ModelScope): void {
		if (this.scope === scope) return;
		this.scope = scope;
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		this.rebuildItems();
		this.tabBar?.setActiveId(scope);
		this.tui.requestRender();
	}

	private selectModelByKey(key: string): void {
		const item = this.activeModels.find((candidate) => `${candidate.provider}/${candidate.id}` === key);
		if (item) this.selectModel(item.model);
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (this.startingOfflineServer) {
			// A fleet server start is in flight; only cancel gets through.
			if (kb.matches(keyData, "tui.select.cancel")) {
				this.dispose();
				this.onCancelCallback();
			}
			return;
		}
		if (kb.matches(keyData, "tui.input.tab")) {
			if (this.scopedModelItems.length > 0) {
				this.setScope(this.scope === "all" ? "scoped" : "all");
			}
			return;
		}
		// Select and save as default
		if (kb.matches(keyData, "app.models.save") && this.onSelectAsDefaultCallback) {
			const selected = this.settingsList.getSelectedItem();
			if (selected) {
				const item = this.activeModels.find((candidate) => `${candidate.provider}/${candidate.id}` === selected.id);
				if (item) {
					this.dispose();
					this.onSelectAsDefaultCallback(item.model);
				}
			}
			return;
		}
		this.settingsList.handleInput(keyData);
	}

	/** Entry point for all selection paths. Offline hummin-local models get a
	 * fleet-server start flow before the selection goes through. */
	private selectModel(model: Model<any>): void {
		const meta = model as Model<any> & HumminModelMetadata;
		if (meta.humminOffline === true) {
			void this.selectOfflineModel(meta);
			return;
		}
		this.handleSelect(model);
	}

	private async selectOfflineModel(model: Model<any> & HumminModelMetadata): Promise<void> {
		const starter = getOfflineFleetStarter();
		const server = findFleetServerForModel(model);
		if (!starter || !server) {
			// No fleet mapping or no start action registered: plain selection.
			this.handleSelect(model);
			return;
		}
		this.startingOfflineServer = true;
		const controller = new AbortController();
		this.startAbort = controller;
		this.refreshStatusMessage = `Starting ${server.label}…`;
		this.updateStatus();
		this.tui.requestRender();
		const result = await starter(server.id, controller.signal);
		this.startingOfflineServer = false;
		this.startAbort = undefined;
		if (this.closed) return;
		if (!result.ok) {
			// The starter already notified; abort the selection.
			this.dispose();
			this.onCancelCallback();
			return;
		}
		this.refreshStatusMessage = "";
		this.handleSelect(model);
	}

	private handleSelect(model: Model<any>): void {
		this.dispose();
		this.onSelectCallback(model);
	}

	getSearchInput(): Input | undefined {
		return this.settingsList.getSearchInput();
	}
}
