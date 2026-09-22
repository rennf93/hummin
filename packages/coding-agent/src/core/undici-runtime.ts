import { EventEmitter } from "node:events";
import * as undici from "undici";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS, parseHttpIdleTimeoutMs } from "./http-dispatcher.ts";

// This module owns the only runtime `undici` import for the HTTP dispatcher.
// Importing undici has a module-init side effect: undici's lib/global.js
// installs a default global dispatcher when the registry is unset. Keeping
// that import out of http-dispatcher.ts (which is on the SDK import graph via
// settings-manager) prevents a bare SDK import from capturing the global
// dispatcher with a version-skewed undici Agent. Callers that deliberately
// configure the dispatcher import this module.

// Node's 250ms default can terminate valid connection attempts on high-latency routes.
const DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;

const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch: typeof globalThis.fetch | undefined;

const ignoreUndiciDispatcherError = (_error: unknown): void => {};

// Undici can emit an internal Client "error" while terminating a mid-stream
// fetch body. The body stream still rejects through reader.read(); this listener
// only prevents EventEmitter's unhandled "error" special case from crashing pi.
function withUndiciErrorListener<T extends undici.Dispatcher>(dispatcher: T): T {
	if (dispatcher instanceof EventEmitter) {
		EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
	}
	return dispatcher;
}

function createUndiciClient(origin: string | URL, options: object): undici.Dispatcher {
	return withUndiciErrorListener(new undici.Client(origin, options as undici.Client.Options));
}

function createUndiciOriginDispatcher(origin: string | URL, options: object): undici.Dispatcher {
	const dispatcherOptions = options as undici.Pool.Options;
	if (dispatcherOptions.connections === 1) {
		return createUndiciClient(origin, dispatcherOptions);
	}
	return withUndiciErrorListener(
		new undici.Pool(origin, {
			...dispatcherOptions,
			factory: createUndiciClient,
		}),
	);
}

export function configureHttpDispatcher(timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS): void {
	const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
	if (normalizedTimeoutMs === undefined) {
		throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
	}
	const dispatcher = withUndiciErrorListener(
		new undici.EnvHttpProxyAgent({
			allowH2: false,
			// Keep HTTP origins on CONNECT tunnels as they were before Undici 8.7.
			proxyTunnel: true,
			bodyTimeout: normalizedTimeoutMs,
			connect: {
				autoSelectFamilyAttemptTimeout: DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
			},
			headersTimeout: normalizedTimeoutMs,
			clientFactory: createUndiciClient,
			factory: createUndiciOriginDispatcher,
		}),
	);
	undici.setGlobalDispatcher(dispatcher);
	// Keep fetch and the dispatcher on the same undici implementation. Node 26.0's
	// bundled fetch can otherwise consume compressed responses through npm undici's
	// dispatcher without decompressing them, causing response.json() failures.
	// If a caller replaced fetch after module load, preserve that deliberate override.
	const shouldInstallGlobals =
		installedGlobalFetch === undefined
			? globalThis.fetch === originalGlobalFetch
			: globalThis.fetch === installedGlobalFetch;
	if (shouldInstallGlobals) {
		undici.install?.();
		installedGlobalFetch = globalThis.fetch;
	}
}
