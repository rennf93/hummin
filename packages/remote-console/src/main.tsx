// hummin remote console entry: mounts the app shell into index.html's #root.
/// <reference lib="dom" />
/// <reference types="vite/client" />
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./index.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
	throw new Error("remote console: index.html is missing the #root element");
}
createRoot(rootElement).render(<App />);
