import {
	type Component,
	Container,
	Input,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { getSettingsListTheme, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

/**
 * Free-text submenu: input pre-filled with the current value.
 * Enter saves, Esc cancels. An optional validator keeps the submenu open with an
 * inline error when the value is not saveable.
 */
export class TextInputSubmenu extends Container {
	private input: Input;
	private error: string | undefined;

	constructor(
		title: string,
		description: string,
		initialValue: string,
		placeholder: string,
		onSave: (value: string) => void,
		onCancel: () => void,
		validate?: (value: string) => string | undefined,
	) {
		super();
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}
		this.addChild(new Spacer(1));
		this.input = new Input({ prompt: "> ", placeholder });
		this.input.setValue(initialValue);
		this.input.onSubmit = (value) => {
			const trimmed = value.trim();
			const problem = validate?.(trimmed);
			if (problem) {
				this.error = problem;
				return;
			}
			this.error = undefined;
			onSave(trimmed);
		};
		this.input.onEscape = () => onCancel();
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to save · Esc to cancel"), 0, 0));
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (this.error) lines.splice(lines.length - 1, 0, theme.fg("error", `  ${this.error}`));
		return lines;
	}
}

/** A right-size model profile: identity plus optional review metadata. */
export interface RightSizeProfile extends Record<string, unknown> {
	provider: string;
	modelId: string;
	description?: string;
	speed?: string;
	thinkingLevels?: string[];
	cost?: { input?: number; output?: number };
}

const RIGHT_SIZE_SPEED_VALUES = ["—", "fast", "normal", "slow"];
const RIGHT_SIZE_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Parse and shape-check the stored profiles JSON. Throws with a user-facing message. */
export function parseRightSizeProfiles(json: string): RightSizeProfile[] {
	const parsed: unknown = JSON.parse(json);
	if (!Array.isArray(parsed)) throw new Error("profiles must be a JSON array");
	return parsed.map((entry) => {
		const profile = entry as RightSizeProfile;
		if (
			typeof profile?.provider !== "string" ||
			!profile.provider.trim() ||
			typeof profile?.modelId !== "string" ||
			!profile.modelId.trim()
		) {
			throw new Error("each profile needs non-empty provider and modelId strings");
		}
		return profile;
	});
}

/** Field editor for one profile: named rows, text or toggle, delete action. */
class ProfileFieldsSubmenu extends Container {
	private settingsList!: SettingsList;
	private readonly profile: RightSizeProfile;
	private readonly onChanged: () => void;
	private readonly onDelete: () => void;
	private readonly onBack: () => void;

	constructor(profile: RightSizeProfile, onChanged: () => void, onDelete: () => void, onBack: () => void) {
		super();
		this.profile = profile;
		this.onChanged = onChanged;
		this.onDelete = onDelete;
		this.onBack = onBack;
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new Text(theme.bold(theme.fg("accent", `${this.profile.provider}/${this.profile.modelId}`)), 0, 0));
		this.addChild(new Spacer(1));
		const profile = this.profile;
		const required = (value: string) => (value.trim() ? undefined : "required");
		const nonNegativeNumber = (value: string) =>
			value === "" || (Number.isFinite(Number(value)) && Number(value) >= 0) ? undefined : "non-negative number";
		const textField = (
			id: string,
			label: string,
			current: string,
			validate: ((value: string) => string | undefined) | undefined,
			save: (value: string) => void,
		): SettingItem => ({
			id,
			label,
			currentValue: current,
			submenu: (_current: string, done: (selectedValue?: string) => void) =>
				new TextInputSubmenu(
					label,
					"",
					current,
					"",
					(value) => {
						save(value);
						this.onChanged();
						done(value);
					},
					() => done(),
					validate,
				),
		});
		const setCost = (key: "input" | "output", value: string): void => {
			profile.cost ??= {};
			if (value === "") delete profile.cost[key];
			else profile.cost[key] = Number(value);
			if (profile.cost.input === undefined && profile.cost.output === undefined) delete profile.cost;
		};
		const items: SettingItem[] = [
			textField("provider", "Provider", profile.provider, required, (value) => {
				profile.provider = value;
			}),
			textField("modelId", "Model id", profile.modelId, required, (value) => {
				profile.modelId = value;
			}),
			textField("description", "Description", profile.description ?? "", undefined, (value) => {
				if (value) profile.description = value;
				else delete profile.description;
			}),
			{
				id: "speed",
				label: "Speed",
				description: "Serving-latency hint for the review (how fast the model answers), not thinking depth",
				currentValue: profile.speed ?? "—",
				values: RIGHT_SIZE_SPEED_VALUES,
			},
		];
		items.push({ id: "thinking-heading", label: "Thinking levels", heading: true, currentValue: "" });
		for (const level of RIGHT_SIZE_THINKING_LEVELS) {
			items.push({
				id: `thinking-${level}`,
				label: level,
				description: "Whether the review may recommend this thinking depth for this model",
				currentValue: Array.isArray(profile.thinkingLevels) && profile.thinkingLevels.includes(level) ? "on" : "—",
				values: ["—", "on"],
			});
		}
		items.push({ id: "cost-heading", label: "Cost ($/M)", heading: true, currentValue: "" });
		items.push(
			textField("cost-input", "Cost input", profile.cost?.input?.toString() ?? "", nonNegativeNumber, (value) => {
				setCost("input", value);
			}),
			textField("cost-output", "Cost output", profile.cost?.output?.toString() ?? "", nonNegativeNumber, (value) => {
				setCost("output", value);
			}),
			{
				id: "delete",
				label: "Delete this profile",
				description: "Remove it immediately and return to the profile list",
				currentValue: "",
				activate: () => this.onDelete(),
			},
		);
		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id, newValue) => {
				if (id === "speed") {
					if (newValue === "—") delete profile.speed;
					else profile.speed = newValue;
					this.onChanged();
					return;
				}
				if (id.startsWith("thinking-")) {
					const level = id.slice("thinking-".length);
					const levels = Array.isArray(profile.thinkingLevels)
						? new Set(profile.thinkingLevels)
						: new Set<string>();
					if (newValue === "on") levels.add(level);
					else levels.delete(level);
					if (levels.size === 0) delete profile.thinkingLevels;
					else profile.thinkingLevels = RIGHT_SIZE_THINKING_LEVELS.filter((entry) => levels.has(entry));
					this.onChanged();
				}
			},
			this.onBack,
		);
		this.addChild(this.settingsList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter edit · Esc back"), 0, 0));
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

/** Profiles screen: one row per profile plus an add action; Esc returns. */
export class RightSizeProfilesSubmenu extends Container {
	private settingsList!: SettingsList;
	private readonly profiles: RightSizeProfile[];
	private readonly persist: (profiles: RightSizeProfile[]) => void;
	private readonly onCancel: () => void;

	constructor(profiles: RightSizeProfile[], persist: (profiles: RightSizeProfile[]) => void, onCancel: () => void) {
		super();
		this.profiles = profiles;
		this.persist = persist;
		this.onCancel = onCancel;
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new Text(theme.bold(theme.fg("accent", "Right-size model profiles")), 0, 0));
		this.addChild(new Text(theme.fg("muted", "What the right-size review knows about each model"), 0, 0));
		this.addChild(new Spacer(1));
		const items: SettingItem[] = this.profiles.map((profile) => ({
			id: `profile-${profile.provider}/${profile.modelId}`,
			label: `${profile.provider}/${profile.modelId}`,
			description: typeof profile.description === "string" ? profile.description : undefined,
			currentValue: typeof profile.speed === "string" ? profile.speed : "",
			submenu: (_current: string, done: (selectedValue?: string) => void) =>
				new ProfileFieldsSubmenu(
					profile,
					() => this.persist(this.profiles),
					() => {
						const index = this.profiles.indexOf(profile);
						if (index !== -1) this.profiles.splice(index, 1);
						this.persist(this.profiles);
						done();
						this.rebuild();
					},
					() => done(),
				),
		}));
		items.push({
			id: "add-profile",
			label: "Add profile",
			description: "Append a placeholder profile, then edit its fields",
			currentValue: "",
			activate: () => {
				this.profiles.push({ provider: "provider", modelId: "model-id" });
				this.persist(this.profiles);
				this.rebuild();
			},
		});
		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			() => {},
			this.onCancel,
		);
		this.addChild(this.settingsList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter edit · Esc back"), 0, 0));
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

export interface SettingsCategory {
	id: string;
	label: string;
}

interface TabRect {
	id: string;
	row: number;
	start: number;
	end: number;
}

/** Category tab bar row above the settings list. Click a tab to switch. */
export class SettingsTabBar implements Component {
	private readonly tabs: readonly SettingsCategory[];
	private activeId: string;
	private readonly onSelect: (id: string) => void;
	private rects: TabRect[] = [];

	invalidate(): void {
		// No cached state to invalidate
	}

	constructor(tabs: readonly SettingsCategory[], activeId: string, onSelect: (id: string) => void) {
		this.tabs = tabs;
		this.activeId = activeId;
		this.onSelect = onSelect;
	}

	setActiveId(id: string): void {
		this.activeId = id;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const rects: TabRect[] = [];
		const gap = 2;
		let rowText = "  ";
		let x = 2;
		let row = 0;

		for (const tab of this.tabs) {
			const labelWidth = visibleWidth(tab.label);
			if (x + labelWidth > width && x > 2) {
				lines.push(truncateToWidth(rowText, width));
				row += 1;
				rowText = "  ";
				x = 2;
			}
			rects.push({ id: tab.id, row, start: x, end: x + labelWidth });
			rowText += this.activeId === tab.id ? theme.bold(theme.fg("accent", tab.label)) : theme.fg("muted", tab.label);
			rowText += " ".repeat(gap);
			x += labelWidth + gap;
		}

		if (rowText.length > 2) {
			const hint = ` · ${keyText("tui.input.tab")} to switch`;
			if (visibleWidth(rowText) + visibleWidth(hint) <= width) {
				rowText += hint;
			}
		}

		lines.push(truncateToWidth(rowText, width));
		this.rects = rects;
		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
		const rect = this.rects.find((r) => r.row === event.y && event.x >= r.start && event.x < r.end);
		if (!rect || rect.id === this.activeId) return undefined;
		this.onSelect(rect.id);
		return { handled: true };
	}
}
