# Changelog

## [1.2.2] - 2026-09-26

## [1.2.1] - 2026-09-26

## [1.2.0] - 2026-09-25

### Breaking Changes

- Reordered Storage scan arguments so the limit precedes the cursor.
- Added the required conversation-visible `Storage.entry(conversationId, id, context)` overload.
- Split `Tx.createConversation()` from `Tx.forkConversation()`, replaced raw conversation-record input, and require explicit ownerless or task ownership.
- Replaced untyped numeric record IDs and the `TaskRef` wrapper with erased branded numeric ID types, including result-typed `TaskId<R>`, separately branded commit sequences, and generic `Storage.mintId()`.
- Made task conversation membership immutable after task creation.
- Added `ConversationQuery` to Storage and transaction conversation scans.

### Added

- Added transactional Sessions with typed durable documents, task creation, snapshots, retirement, and commit publications.
- Added document checkpoint selection, lazy version migration, and `Session.snapshotAsOf()` for rewindable conversation documents.
- Added policy-driven backend-side conversation document copying when creating forks.
- Added indexed conversation ownership queries and guaranteed no-effect Storage rejection handling.

## [1.1.3] - 2026-09-22

## [0.87.1] - 2026-09-22

### Added

- Added a portable SQLite storage backend for the durable runtime with a Node adapter, versioned migrations, storage conformance coverage, and benchmarks.
- Added versioned document storage: atomic document bases, deltas, historical reads, reincarnation, reclamation, and indexed memory queries with strict input and passive-write submissions.

## [0.87.0] - 2026-09-21

## [1.1.1] - 2026-09-21

## [0.86.1] - 2026-09-20

## [0.86.0] - 2026-09-19

### Added

- Added the initial Pico durable record contracts and detached in-memory storage implementation.
