/**
 * renderer/test/mount: mounts a component into the happy-dom document under React act,
 * returning the container plus re-render and unmount handles.
 */
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

export interface Mounted {
	container: HTMLDivElement;
	render(element: ReactElement): Promise<void>;
	unmount(): Promise<void>;
}

export async function mount(element: ReactElement): Promise<Mounted> {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	const renderIt = async (next: ReactElement): Promise<void> => {
		await act(async () => {
			root.render(next);
		});
	};
	await renderIt(element);
	return {
		container,
		render: async (next: ReactElement) => {
			await renderIt(next);
		},
		unmount: async () => {
			await act(async () => {
				root.unmount();
			});
			container.remove();
		},
	};
}
