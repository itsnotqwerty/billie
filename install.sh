#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v typst >/dev/null 2>&1; then
	echo "Typst is required for PDF export. Install Typst and ensure it is on PATH." >&2
	exit 1
fi

deno task build

prefix="${BILLIE_INSTALL_DIR:-$HOME/.local/bin}"
install -Dm755 dist/billie "$prefix/billie"

echo "Installed billie to $prefix/billie"
