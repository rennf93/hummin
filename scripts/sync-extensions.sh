#!/usr/bin/env bash
# Sync bundled extensions to the runtime autoload dir. Run from repo root.
# Usage: scripts/sync-extensions.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${HUMMIN_CODING_AGENT_DIR:-$HOME/.hummin/agent}/extensions"
mkdir -p "$DEST/lib"
cp "$ROOT"/packages/coding-agent/extensions/*.ts "$DEST/"
cp -R "$ROOT"/packages/coding-agent/extensions/lib/. "$DEST/lib/"
echo "synced $(ls "$DEST"/*.ts | wc -l | tr -d ' ') extensions + $(find "$DEST/lib" -name '*.ts' | wc -l | tr -d ' ') lib files to $DEST"
