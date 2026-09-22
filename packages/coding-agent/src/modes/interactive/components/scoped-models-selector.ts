import type { Model } from "@earendil-works/pi-ai";
import {
	Container,
	type Focusable,
	getKeybindings,
	type Input,
	Key,
	matchesKey,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import { getModelSearchText } from "../model-search.ts";
import { getSettingsListTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyDisplayText } from "./keybinding-hints.ts";

// EnabledIds: null = all enabled (no filter), string[] = explicit ordered list
type EnabledIds = string[] | null;

function isEnabled(enabledIds: EnabledIds, id: string): boolean {
	return enabledIds === null || enabledIds.includes(id);
}

/** Collapse an explicit list back to null (= all enabled) when it covers every available model. */
function normalizeEnabled(result: string[], allIds: string[]): EnabledIds {
	return result.length === allIds.length && result.every((id) => allIds.includes(id)) ? null : result;
}

function toggle(enabledIds: EnabledIds, allIds: string[], id: string): EnabledIds {
	if (enabledIds === null) return allIds.filter((modelId) => modelId !== id);
	const index = enabledIds.indexOf(id);
	if (index >= 0) return [...enabledIds.slice(0, index), ...enabledIds.slice(index + 1)];
	return normalizeEnabled([...enabledIds, id], allIds);
}

function enableAll(enabledIds: EnabledIds, allIds: string[], targetIds?: string[]): EnabledIds {
	if (enabledIds === null) return null; // Already all enabled
	const targets = targetIds ?? allIds;
	const result = [...enabledIds];
	for (const id of targets) {
		if (!result.includes(id)) result.push(id);
	}
	return normalizeEnabled(result, allIds);
}

function clearAll(enabledIds: EnabledIds, allIds: string[], targetIds?: string[]): EnabledIds {
	if (enabledIds === null) {
		return targetIds ? allIds.filter((id) => !targetIds.includes(id)) : [];
	}
	const targets = new Set(targetIds ?? enabledIds);
	return enabledIds.filter((id) => !targets.has(id));
}

function move(enabledIds: EnabledIds, id: string, delta: number): EnabledIds {
	if (enabledIds === null) return null;
	const list = [...enabledIds];
	const index = list.indexOf(id);
	if (index < 0) return list;
	const newIndex = index + delta;
	if (newIndex < 0 || newIndex >= list.length) return list;
	const result = [...list];
	[result[index], result[newIndex]] = [result[newIndex], result[index]];
	return result;
}

function getSortedIds(enabledIds: EnabledIds, allIds: string[]): string[] {
	if (enabledIds === null) return allIds;
	const enabledSet = new Set(enabledIds);
	return [...enabledIds, ...allIds.filter((id) => !enabledSet.has(id))];
}

interface ModelItem {
	fullId: string;
	model: Model<any> | undefined;
	enabled: boolean;
}

export interface ModelsConfig {
	allModels: Model<any>[];
	enabledModelIds: string[] | null;
	refreshStatus?: string;
}

export interface ModelsCallbacks {
	/** Called whenever the enabled model set or order changes (session-only, no persist) */
	onChange: (enabledModelIds: string[] | null) => void | Promise<void>;
	/** Called when user wants to persist current selection to settings */
	onPersist: (enabledModelIds: string[] | null) => void | Promise<void>;
	onCancel: () => void;
}

/**
 * Component for enabling/disabling models for Ctrl+P cycling, rendered in the
 * settings-view style (search, aligned table, description pane, mouse support).
 * Changes are session-only until explicitly persisted with Ctrl+S.
 */
export class ScopedModelsSelectorComponent extends Container implements Focusable {
	private modelsById: Map<string, Model<any>> = new Map();
	private allIds: string[] = [];
	private enabledIds: EnabledIds = null;
	private filteredItems: ModelItem[] = [];

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
	private footerText: Text;
	private statusText?: Text;
	private callbacks: ModelsCallbacks;
	private isDirty = false;
	/** Extra search text per item id (model id, provider, name). */
	private readonly searchTexts = new Map<string, string>();

	constructor(config: ModelsConfig, callbacks: ModelsCallbacks) {
		super();
		this.callbacks = callbacks;

		for (const model of config.allModels) {
			const fullId = `${model.provider}/${model.id}`;
			this.modelsById.set(fullId, model);
			this.allIds.push(fullId);
		}

		this.enabledIds = config.enabledModelIds === null ? null : [...config.enabledModelIds];
		this.filteredItems = this.buildItems();

		// Header
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Model Configuration")), 0, 0));
		this.addChild(
			new Text(theme.fg("muted", `  Session-only. ${keyDisplayText("app.models.save")} to save to settings.`), 0, 0),
		);
		this.addChild(new Spacer(1));

		const hintParts = [
			`${keyDisplayText("tui.select.confirm")} toggle`,
			`${keyDisplayText("app.models.enableAll")} all`,
			`${keyDisplayText("app.models.clearAll")} clear`,
			`${keyDisplayText("app.models.toggleProvider")} provider`,
			`${keyDisplayText("app.models.reorderUp")}/${keyDisplayText("app.models.reorderDown")} reorder`,
			`${keyDisplayText("app.models.save")} save`,
		];

		this.settingsList = new SettingsList(
			[],
			8,
			getSettingsListTheme(),
			() => {},
			() => this.callbacks.onCancel(),
			{
				enableSearch: true,
				hint: hintParts.join(" · "),
				emptyMessage: "No models available",
				noMatchMessage: "No matching models",
				maxLabelWidth: 46,
				searchText: (item) => this.searchTexts.get(item.id) ?? item.label,
			},
		);
		this.addChild(this.settingsList);

		// Footer counts + dirty marker (dynamic part of the old footer line)
		this.footerText = new Text("", 0, 0);
		this.addChild(this.footerText);

		if (config.refreshStatus) {
			this.statusText = new Text(theme.fg("muted", `  ${config.refreshStatus}`), 0, 0);
			this.addChild(this.statusText);
		}

		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.rebuildItems();
		this.footerText.setText(this.getFooterText());
	}

	updateModels(models: readonly Model<any>[], enabledModelIds?: string[] | null): void {
		if (enabledModelIds !== undefined) this.enabledIds = enabledModelIds === null ? null : [...enabledModelIds];
		this.modelsById.clear();
		this.allIds = [];
		for (const model of models) {
			const fullId = `${model.provider}/${model.id}`;
			this.modelsById.set(fullId, model);
			this.allIds.push(fullId);
		}
		this.refresh();
	}

	setRefreshStatus(message: string, kind: "muted" | "success" | "warning"): void {
		this.statusText?.setText(theme.fg(kind, `  ${message}`));
	}

	private buildItems(): ModelItem[] {
		return getSortedIds(this.enabledIds, this.allIds).map((id) => ({
			fullId: id,
			model: this.modelsById.get(id),
			enabled: isEnabled(this.enabledIds, id),
		}));
	}

	private getFooterText(): string {
		const enabledCount = this.enabledIds?.filter((id) => this.modelsById.has(id)).length ?? this.allIds.length;
		const unavailableCount = this.enabledIds?.filter((id) => !this.modelsById.has(id)).length ?? 0;
		const allEnabled = this.enabledIds === null;
		const countText = allEnabled
			? "all enabled"
			: `${enabledCount}/${this.allIds.length} enabled${unavailableCount ? ` · ${unavailableCount} unavailable` : ""}`;
		const text = theme.fg("dim", `  ${countText}`);
		return this.isDirty ? `${text} ${theme.fg("warning", "(unsaved)")}` : text;
	}

	private refresh(): void {
		// Capture the highlighted row position before the item list is rebuilt.
		const selectedId = this.settingsList?.getSelectedItem()?.id;
		const selectedIndex = selectedId ? this.filteredItems.findIndex((item) => item.fullId === selectedId) : -1;
		this.filteredItems = this.buildItems();
		this.rebuildItems(selectedIndex);
		this.footerText.setText(this.getFooterText());
	}

	/** Rebuild the settings-list rows; keep the highlighted row position when known. */
	private rebuildItems(prevIndex?: number): void {
		this.searchTexts.clear();
		const items: SettingItem[] = this.filteredItems.map((item) => {
			const id = item.model?.id ?? item.fullId;
			const label = item.model ? id : theme.strikethrough(id);
			const provider = item.model ? item.model.provider : "unavailable";
			if (item.model) {
				this.searchTexts.set(
					item.fullId,
					getModelSearchText({ id: item.model.id, provider: item.model.provider, name: item.model.name }),
				);
			}
			return {
				id: item.fullId,
				label,
				currentValue: `${item.enabled ? "on" : "off"} · ${provider}`,
				description: item.model ? item.model.name || item.model.id : "Model unavailable",
				activate: () => this.toggleItem(item.fullId),
			};
		});
		this.settingsList.setItems(items);
		if (prevIndex !== undefined && prevIndex >= 0) this.settingsList.selectIndex(prevIndex);
	}

	private notifyChange(): void {
		this.callbacks.onChange(this.enabledIds === null ? null : [...this.enabledIds]);
	}

	private toggleItem(fullId: string): void {
		this.enabledIds = toggle(this.enabledIds, this.allIds, fullId);
		this.isDirty = true;
		this.refresh();
		this.notifyChange();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		// Reorder enabled models
		const reorderUp = kb.matches(data, "app.models.reorderUp");
		const reorderDown = kb.matches(data, "app.models.reorderDown");
		if (reorderUp || reorderDown) {
			if (this.enabledIds === null) return;
			const item = this.settingsList.getSelectedItem();
			if (item && isEnabled(this.enabledIds, item.id)) {
				const delta = reorderUp ? -1 : 1;
				const currentIndex = this.enabledIds.indexOf(item.id);
				const newIndex = currentIndex + delta;
				// Only move if within bounds
				if (newIndex >= 0 && newIndex < this.enabledIds.length) {
					this.enabledIds = move(this.enabledIds, item.id, delta);
					this.isDirty = true;
					this.refresh();
					// Follow the moved row within the (re-filtered) list.
					this.settingsList.selectItem(item.id);
					this.notifyChange();
				}
			}
			return;
		}

		// Enable all (filtered if search active, otherwise all)
		if (kb.matches(data, "app.models.enableAll")) {
			const targetIds = this.settingsList.getSearchInput()?.getValue()
				? this.filteredItems.map((i) => i.fullId)
				: undefined;
			this.enabledIds = enableAll(this.enabledIds, this.allIds, targetIds);
			this.isDirty = true;
			this.refresh();
			this.notifyChange();
			return;
		}

		// Clear all (filtered if search active, otherwise all)
		if (kb.matches(data, "app.models.clearAll")) {
			const targetIds = this.settingsList.getSearchInput()?.getValue()
				? this.filteredItems.map((i) => i.fullId)
				: undefined;
			this.enabledIds = clearAll(this.enabledIds, this.allIds, targetIds);
			this.isDirty = true;
			this.refresh();
			this.notifyChange();
			return;
		}

		// Toggle provider of current item
		if (kb.matches(data, "app.models.toggleProvider")) {
			const item = this.filteredItems.find(
				(candidate) => candidate.fullId === this.settingsList.getSelectedItem()?.id,
			);
			if (item?.model) {
				const provider = item.model.provider;
				const providerIds = this.allIds.filter((id) => this.modelsById.get(id)!.provider === provider);
				const allEnabled = providerIds.every((id) => isEnabled(this.enabledIds, id));
				this.enabledIds = allEnabled
					? clearAll(this.enabledIds, this.allIds, providerIds)
					: enableAll(this.enabledIds, this.allIds, providerIds);
				this.isDirty = true;
				this.refresh();
				this.notifyChange();
			}
			return;
		}

		// Save/persist to settings
		if (kb.matches(data, "app.models.save")) {
			this.callbacks.onPersist(this.enabledIds === null ? null : [...this.enabledIds]);
			this.isDirty = false;
			this.footerText.setText(this.getFooterText());
			return;
		}

		// Ctrl+C - clear search or cancel if empty
		if (matchesKey(data, Key.ctrl("c"))) {
			const input = this.settingsList.getSearchInput();
			if (input?.getValue()) {
				input.setValue("");
				this.refresh();
			} else {
				this.callbacks.onCancel();
			}
			return;
		}

		this.settingsList.handleInput(data);
	}

	getSearchInput(): Input | undefined {
		return this.settingsList.getSearchInput();
	}
}
