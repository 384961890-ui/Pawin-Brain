#!/bin/sh
set -eu

# Compatibility entry point for source checkouts. The complete installer owns
# hook ordering and stdin fan-out; installing think-detect alone is unsafe.
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
printf '%s\n' 'v3/install-think-loop.sh is deprecated; installing the complete Brain hook set.' >&2
exec "$ROOT/install-hooks.sh" "$@"
