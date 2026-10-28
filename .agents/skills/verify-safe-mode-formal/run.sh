#!/bin/sh
set -eu
if ! command -v bun >/dev/null 2>&1; then
  echo "verify-safe-mode-formal needs bun on PATH (the repo's toolchain)." >&2
  exit 2
fi
DIR="$(cd "$(dirname "$0")" && pwd -P)"
exec bun "$DIR/check.ts"
