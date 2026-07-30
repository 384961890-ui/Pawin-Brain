#!/bin/sh
# Claude Code installer wrapper. Runtime source stays in this repository; mutable
# Brain data lives in CLAUDE_BRAIN_DIR (default: ~/.claude-brain).

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NODE_BIN=${CLAUDE_BRAIN_NODE:-node}

exec "$NODE_BIN" "$SCRIPT_DIR/install-claude-hooks.js" "$@"
