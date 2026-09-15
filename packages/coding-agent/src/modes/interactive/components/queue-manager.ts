import {
	Container,
	type Focusable,
	getKeybindings,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import { getSelectListTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyDisplayText } from "./keybinding-hints.ts";

export type QueueKind = "steering" | "followUp";

export interface QueuedMessageEntry {
	kind: QueueKind;
	index: number;
	text: string;
}

export type QueueAction = "restore" | "delete";

interface QueueRow {
	entry: QueuedMessageEntry;
	item: SelectItem;
}

function entryItem(entry: QueuedMessageEntry): SelectItem {
	const preview = entry.text.length > 80 ? `${entry.text.slice(0, 77)}...` : entry.text;
	return {
		value: `${entry.kind}:${entry.index}`,
		label: `${entry.kind === "steering" ? "steer" : "follow-up"}: ${preview}`,
	};
}

/**
 * Interactive manager for queued steering / follow-up messages.
 * Enter restores the selected message into the editor, `d` deletes it.
 */
export class QueueManagerComponent extends Container implements Focusable {
	private rows: QueueRow[];
	private selectList: SelectList;
	private onAction: (action: QueueAction, entry: QueuedMessageEntry) => void;
	private onCancel: () => void;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	constructor(
		entries: QueuedMessageEntry[],
		onAction: (action: QueueAction, entry: QueuedMessageEntry) => void,
		onCancel: () => void,
	) {
		super();
		this.onAction = onAction;
		this.onCancel = onCancel;
		this.rows = entries.map((entry) => ({ entry, item: entryItem(entry) }));

		this.addChild(new Text(theme.fg("accent", "Queued messages"), 0, 0));
		this.addChild(
			new Text(
				theme.fg(
					"dim",
					`${keyDisplayText("tui.select.confirm")} restore to editor · ${keyDisplayText("tui.select.delete")} delete · ${keyDisplayText("tui.select.cancel")} close`,
				),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.selectList = new SelectList(
			this.rows.map((row) => row.item),
			Math.max(1, Math.min(this.rows.length, 10)),
			getSelectListTheme(),
		);
		this.selectList.onSelect = (item) => this.emit(item, "restore");
		this.selectList.onCancel = () => this.onCancel();
		this.addChild(this.selectList);
		this.addChild(new DynamicBorder());
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.delete")) {
			const selected = this.selectList.getSelectedItem();
			this.emit(selected ?? undefined, "delete");
			return;
		}
		this.selectList.handleInput(data);
	}

	private emit(item: SelectItem | undefined, action: QueueAction): void {
		if (!item) return;
		const entry = this.rows.find((row) => row.item.value === item.value)?.entry;
		if (entry) this.onAction(action, entry);
	}

	invalidate(): void {
		super.invalidate();
		this.selectList.invalidate?.();
	}
}
