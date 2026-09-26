# Changelog

## [Unreleased]

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
