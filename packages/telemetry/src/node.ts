/**
 * Node-only entry point: re-exports the telemetry event sink API, including
 * the JSONL file sink whose fs/path imports must stay out of the browser-pure
 * root barrel.
 */
export {
	emitTelemetryEvent,
	FileTelemetryEventSink,
	type FileTelemetryEventSinkOptions,
	getTelemetryEventSink,
	setTelemetryEventSink,
	TELEMETRY_LOG_MAX_BYTES,
	type TelemetryEventRecord,
	type TelemetryEventSink,
} from "./sink.ts";
