#!/bin/sh
set -eu

# Compatibility entry point. A capture-only Stop hook leaves the rest of Brain
# incomplete, so delegate to the complete Claude Code installer.
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
printf '%s\n' 'install-capture-lesson.sh is deprecated; installing the complete Brain hook set.' >&2
exec "$ROOT/install-hooks.sh" "$@"
