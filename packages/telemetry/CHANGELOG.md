# Changelog

## [1.9.0] - 2026-10-22

## [1.8.0] - 2026-10-22


### Breaking Changes

- Adapters trust typed instrumentation inputs; behavior for malformed values is unspecified. Carrier extraction checks required string identities, without validating their format.
- Adapters must implement `TelemetrySpan.addLink()`. Normalized span snapshots include carrier-shaped context and parent identities and ordered links.
- Adapters with optional metric or propagation capabilities must carry them through `TelemetryContext.metrics` and `TelemetryContext.propagation` on roots, spans, and extracted parents.

### Added

- Opaque string-map carriers and optional `TelemetryPropagation` injection/extraction, with passive root fallback for absent or invalid carriers and shared `NOOP_TELEMETRY_PROPAGATION`.
- Initial `SpanOptions.links` and late `span.addLink()` with context targets and optional attributes, including settled target spans and extracted remote parents.
- Optional `TelemetryMetrics` counters, up-down counters, and histograms with boundary hints and exemplar contexts, plus shared `NOOP_TELEMETRY_METRICS` instruments.
- Optional context capability members, populated by the no-op and in-memory adapters and checked by adapter conformance.
- `NOOP_TELEMETRY_CONTEXT` is typed as `TelemetrySpan`, matching the shared inert span it provides.
- Metric schema definitions and `createTypedMetrics()` with exact instrument names, kinds, and required/optional low-cardinality attributes.
- In-memory propagation across processes, link and measurement snapshots, and adapter conformance cases for propagation, links, and optional metrics.
- `StoredSpan`, `StoredTrace`, and `TelemetryStore` define backend-independent trace discovery, trace retrieval, and metric queries. `@earendil-works/pi-telemetry/render` exports `renderTrace()` for plain-text span trees with attributes, durations, errors, events, and cross-trace links; merged spans are deduplicated by ID and links are never followed.

## [1.7.0] - 2026-10-21

### Breaking Changes

- Adapters trust typed instrumentation inputs; behavior for malformed values is unspecified. Carrier extraction checks required string identities, without validating their format.
- Adapters must implement `TelemetrySpan.addLink()`. Normalized span snapshots include carrier-shaped context and parent identities and ordered links.
- Adapters with optional metric or propagation capabilities must carry them through `TelemetryContext.metrics` and `TelemetryContext.propagation` on roots, spans, and extracted parents.

### Added

- Opaque string-map carriers and optional `TelemetryPropagation` injection/extraction, with passive root fallback for absent or invalid carriers and shared `NOOP_TELEMETRY_PROPAGATION`.
- Initial `SpanOptions.links` and late `span.addLink()` with context targets and optional attributes, including settled target spans and extracted remote parents.
- Optional `TelemetryMetrics` counters, up-down counters, and histograms with boundary hints and exemplar contexts, plus shared `NOOP_TELEMETRY_METRICS` instruments.
- Optional context capability members, populated by the no-op and in-memory adapters and checked by adapter conformance.
- `NOOP_TELEMETRY_CONTEXT` is typed as `TelemetrySpan`, matching the shared inert span it provides.
- Metric schema definitions and `createTypedMetrics()` with exact instrument names, kinds, and required/optional low-cardinality attributes.
- In-memory propagation across processes, link and measurement snapshots, and adapter conformance cases for propagation, links, and optional metrics.
- `StoredSpan`, `StoredTrace`, and `TelemetryStore` define backend-independent trace discovery, trace retrieval, and metric queries. `@earendil-works/pi-telemetry/render` exports `renderTrace()` for plain-text span trees with attributes, durations, errors, events, and cross-trace links; merged spans are deduplicated by ID and links are never followed.

## [1.6.4] - 2026-10-18

## [1.6.3] - 2026-10-17

## [1.6.2] - 2026-10-17

## [1.6.1] - 2026-10-17

## [1.6.0] - 2026-10-16

## [1.5.0] - 2026-10-14

## [1.4.0] - 2026-10-05

## [1.3.1] - 2026-10-04

## [1.3.0] - 2026-10-04

## [1.2.10] - 2026-09-28

## [1.2.9] - 2026-09-28

## [1.2.8] - 2026-09-28

## [1.2.7] - 2026-09-28

## [1.2.6] - 2026-09-27

## [1.2.5] - 2026-09-27

## [1.2.4] - 2026-09-27

## [1.2.3] - 2026-09-26

## [1.2.2] - 2026-09-26

### Added

- Added a process-wide telemetry event sink registry (`setTelemetryEventSink`, `emitTelemetryEvent`) and a fail-open JSONL `FileTelemetryEventSink` with lazy directory creation and oldest-file rotation under a total size cap. Node-only: exported from the new `./node` entry so the browser-pure root barrel is unchanged.

## [1.2.1] - 2026-09-26

## [1.2.0] - 2026-09-25

## [1.1.3] - 2026-09-22

## [0.87.1] - 2026-09-22

## [0.87.0] - 2026-09-21

## [1.1.0] - 2026-09-19

## [1.0.3] - 2026-09-17

## [1.0.2] - 2026-09-17

## [0.86.1] - 2026-09-20

## [0.86.0] - 2026-09-19

## [0.85.1] - 2026-09-05

## [0.85.0] - 2026-09-04

## [0.84.4] - 2026-08-28

## [0.84.3] - 2026-08-24

## [0.84.2] - 2026-08-14

## [0.84.1] - 2026-08-07

## [0.84.0] - 2026-08-06

### Added

- Added the callback-based telemetry context contract, shared no-op context, deterministic in-memory reference adapter, reusable adapter conformance suite, typed serializable schema utilities, and multi-schema typed span starters with explicit child propagation.
