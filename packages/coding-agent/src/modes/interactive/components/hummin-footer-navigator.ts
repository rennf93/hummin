import {
	Container,
	type Focusable,
	getKeybindings,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import type { FooterNavItem } from "../../../core/footer-data-provider.ts";
import { getSelectListTheme, theme } from "../theme/theme.ts";
import { keyDisplayText } from "./keybinding-hints.ts";

/**
 * Popup listing actionable footer elements (background tasks, TODOs, agents, fleet).
 * Enter routes to the panel's slash command; Escape cancels.
 */
export class FooterNavigatorComponent extends Container implements Focusable {
	private selectList: SelectList;
	private onSelect: (item: FooterNavItem) => void;
	private onCancel: () => void;
	private rows: Array<{ item: FooterNavItem; select: SelectItem }>;
	private _focused = false;

	constructor(items: FooterNavItem[], onSelect: (item: FooterNavItem) => void, onCancel: () => void) {
		super();
		this.onSelect = onSelect;
		this.onCancel = onCancel;
		this.rows = items.map((item) => ({ item, select: { value: item.id, label: item.label } }));

		this.addChild(new Text(theme.fg("accent", "Footer"), 0, 0));
		this.addChild(
			new Text(
				theme.fg(
					"dim",
					`${keyDisplayText("tui.select.confirm")} open · ${keyDisplayText("tui.select.cancel")} close`,
				),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.selectList = new SelectList(
			this.rows.map((row) => row.select),
			Math.max(1, Math.min(this.rows.length, 10)),
			getSelectListTheme(),
		);
		this.selectList.onSelect = (selected) => {
			const row = this.rows.find((candidate) => candidate.select.value === selected.value);
			if (row) this.onSelect(row.item);
		};
		this.selectList.onCancel = () => this.onCancel();
		this.addChild(this.selectList);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	handleInput(data: string): void {
		if (getKeybindings().matches(data, "tui.select.cancel")) {
			this.onCancel();
			return;
		}
		this.selectList.handleInput(data);
	}

	invalidate(): void {
		super.invalidate();
		this.selectList.invalidate?.();
	}
}
