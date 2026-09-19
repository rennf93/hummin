#!/usr/bin/env bash
# Sync bundled extensions to the runtime autoload dir. Run from repo root.
# Usage: scripts/sync-extensions.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${HUMMIN_CODING_AGENT_DIR:-$HOME/.hummin/agent}/extensions"
mkdir -p "$DEST/lib"
cp "$ROOT"/packages/coding-agent/extensions/*.ts "$DEST/"
cp "$ROOT"/packages/coding-agent/extensions/lib/*.ts "$DEST/lib/"
echo "synced $(ls "$DEST"/*.ts | wc -l | tr -d ' ') extensions + $(ls "$DEST"/lib/*.ts | wc -l | tr -d ' ') lib files to $DEST"
