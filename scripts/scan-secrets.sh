#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
command -v gitleaks >/dev/null 2>&1 || { echo "gitleaks is required" >&2; exit 2; }
gitleaks git --config config/gitleaks.toml --redact=100 --log-opts=--all
/usr/bin/python3 -I scripts/scan-working-tree.py
