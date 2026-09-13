# zcode design language

Hand-derived from the `zcode-dark` theme. Intended to be regenerated through a
design-taste/brandkit pass and re-translated here. Terminal constraints: monospace
grid, 256-color fallback (truecolor when detected), information density over
decoration.

## Palette (zcode-dark)

| Role | Value | Used for |
|---|---|---|
| accent | `#2dd4bf` | streaming state, selection, primary accents |
| cyan | `#5eead4` | accent-context borders, links |
| green | `#b5bd68` | success, diff additions |
| yellow | `#e6c07b` | warnings: budget reminders, rate-limit parking |
| red | `#cc6666` | errors, halted state, diff removals |
| gray / dim | `#808080` / `#666666` | muted metadata, thinking text |

## State hierarchy

1. **streaming** - accent
2. **waiting-for-instance** (colibri queue) - muted text with accent spinner
3. **parked-on-rate-limit** - yellow, persistent until resumed
4. **budget-warning** - yellow, single-line in-band reminder
5. **halted / circuit-open** - red, always with remediation text
6. **success / complete** - green, no banner

## Component rules

- In-band reminders are single lines with a bracket tag: `[Budget]`, `[Loop]`, `[Circuit]`.
- Never decorate streaming model output; decoration belongs to chrome only.
- Post-mortems are data (JSON on disk), never rendered inline in the transcript.
- Every state must survive 256-color and no-color terminals: pair each color with a text tag.
