import type { Component } from "@earendil-works/pi-tui";
import { buildFooterNavigatorRows, type ReadonlyFooterDataProvider } from "../../core/footer-data-provider.ts";
import { FooterNavigatorComponent } from "./components/hummin-footer-navigator.ts";

export interface FooterActionsDeps {
	footerDataProvider: ReadonlyFooterDataProvider;
	isExtensionCommand: (text: string) => boolean;
	prompt: (text: string) => Promise<void>;
	showStatus: (message: string) => void;
	requestRender: () => void;
	showSelector: (
		create: (done: () => void) => { component: Component; focus: Component; dispose?: () => void },
	) => void;
}

/** Open the background panel by running the /background extension command. */
export async function showBackgroundPanel(deps: FooterActionsDeps): Promise<void> {
	if (!deps.isExtensionCommand("/background")) {
		deps.showStatus("No background command registered (hummin-subagents extension missing)");
		return;
	}
	await deps.prompt("/background");
}

/** Open the footer navigator popup listing actionable footer segments. */
export function showFooterNavigator(deps: FooterActionsDeps): void {
	const items = buildFooterNavigatorRows({
		backgroundStatus: deps.footerDataProvider.getExtensionStatuses().get("bg"),
		todoSummary: deps.footerDataProvider.getTodoSummary(),
		agentsAvailable: deps.isExtensionCommand("/agents"),
		fleetAvailable: deps.isExtensionCommand("/fleet"),
	});

	deps.showSelector((done) => {
		const navigator = new FooterNavigatorComponent(
			items,
			(item) => {
				done();
				if (deps.isExtensionCommand(item.command)) {
					void deps.prompt(item.command);
				} else {
					deps.showStatus(`${item.command} is not available`);
				}
			},
			() => {
				done();
				deps.requestRender();
			},
		);
		return { component: navigator, focus: navigator };
	});
}
