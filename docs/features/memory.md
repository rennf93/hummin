# Memory

hummin learns from your sessions instead of forgetting them. Two layers, both off-disk and yours.

## Lesson mode

One distillation per session: a compact **Problem / Approach / Gotcha** note (120 words max), mirrored per project. Atomic locks and idempotent writes keep it sane across parallel sessions.

## Vault mode

A self-curating, git-backed, Obsidian-compatible entity graph:

- Entities live as markdown: `entities/<type>/<slug>.md`, connected with wikilinks, plus a `graph.canvas`.
- Lessons auto-fold into the vault (inbox folds at 3+).
- A machine-managed contract `AGENTS.md` keeps the vault structured without you policing it.

## Recall

- **BM25-ranked retrieval** (k1=1.5, b=0.75) plus phrase and recency bonuses.
- At most 3 lessons / 2000 characters injected once per session - context stays lean.
- **Quick capture**: type `# some insight` to drop a note into the vault inbox without spending a turn.

## Commands

| Command | Purpose |
|---|---|
| `/memory` | Memory status and control |
| `/vault-fold` | Fold inbox lessons into the vault |
| `/vault-recall` | Search the vault |
| `/vault-canvas` | Open the graph canvas |

## Configuration

Settings keys: `memoryEnabled`, `memoryMode` (lessons/vault), `memoryVaultDir`, `memoryProvider`, `memoryModelId`. Environment (`HUMMIN_MEMORY*`) beats settings throughout, and spawned subagents get `HUMMIN_MEMORY=0` so children never recurse into your memory pipeline.
