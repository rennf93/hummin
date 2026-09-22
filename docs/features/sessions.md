# Sessions

Everything about a hummin session is inspectable, restorable and shareable.

## Anatomy

Sessions are a JSONL tree on disk. Each exchange is a node, so branching is native: **fork**, **clone**, and branch summaries all operate on real history, not a flattened log.

## Working with history

| Command | Purpose |
|---|---|
| `/session` | Session picker and info |
| `/name` | Name the session (findable in the picker) |
| `/fork`, `/clone` | Branch off the current point |
| `/resume` | Pick up a past session |
| `/export` | Export as markdown, HTML or JSONL |
| `/share` | Share as a gist |
| `/rewind` | Restore files and/or conversation to an earlier prompt |

## Compaction

Long sessions compress instead of dying:

- **Auto-compaction** when the context fills, **manual** on demand, with **per-model overrides**.
- `/context` shows the token breakdown and compaction state, including the cache-hit ratio so you can tell whether your server's prefix cache is earning its keep.

## Queuing

Type while the model streams: your message becomes a **steering** or **follow-up** message instead of being lost.

- `/queue` - inspect and reorder the queue.
- Enter-while-streaming behavior is a setting.

## Visibility

- Uniform collapsed tool rows with labels and durations - the transcript reads like a log, not a firehose.
- Markdown + mermaid rendering, inline images, thinking blocks.
- Fullscreen transcript search; `/hotkeys` for everything.

## Editor

- Autocomplete for commands, templates, skills and `@files`, with grouped category headers.
- Optional **vim mode** (`editorMode`): motions plus `x/d/c/y/p/u`, INSERT/NORMAL indicator, kill-ring, undo.
- External editor, image paste, `!`/`!!` shell escapes, `#` quick-capture to the vault, mouse support, 500-entry per-project history.

## Statusline

Two-row statusline by default, or define your own with `statusline.left/right` segment tokens: `dir`, `repo`, `branch`, `model`, `provider`, `ctx`, `tokens`, `cost`, `queue`, `background`, `sandbox`, `mcp`, `git`, `diff`. Extensions can add their own segments.
