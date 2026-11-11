// hummin remote console entry: mounts the app shell into index.html's #root.
/// <reference lib="dom" />
/// <reference types="vite/client" />
import { Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./index.css";

/** Top-level boundary: a render error shows a recoverable message instead of a blank page. */
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	state = { failed: false };

	static getDerivedStateFromError(): { failed: boolean } {
		return { failed: true };
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		console.error("remote console render error", error, info.componentStack);
	}

	render(): ReactNode {
		if (!this.state.failed) return this.props.children;
		return (
			<div role="alert" data-rc-error-boundary="true" style={{ padding: "2rem", font: "inherit", color: "inherit" }}>
				<p>The console hit an error. Reload to reconnect.</p>
				<button type="button" onClick={() => window.location.reload()}>
					Reload
				</button>
			</div>
		);
	}
}

const rootElement = document.getElementById("root");
if (!rootElement) {
	throw new Error("remote console: index.html is missing the #root element");
}
createRoot(rootElement).render(
	<ErrorBoundary>
		<App />
	</ErrorBoundary>,
);
