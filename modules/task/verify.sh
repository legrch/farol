#!/bin/sh
# Pre-K0 test scaffold only. No repository Go module or production wiring is created.
set -eu
module_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fixture=$(mktemp -d "${TMPDIR:-/tmp}/farol-task-go.XXXXXX")
trap 'rm -rf "$fixture"' EXIT HUP INT TERM
mkdir -p "$fixture/modules"
cp -R "$module_dir" "$fixture/modules/task"
printf '%s\n' 'module github.com/legrch/farol' 'go 1.26.0' > "$fixture/go.mod"
cd "$fixture"
export GOCACHE="$fixture/cache"
GOWORK=off GOPROXY=off GOSUMDB=off go test -race -count=1 ./modules/task/...
GOWORK=off GOPROXY=off GOSUMDB=off go vet ./modules/task/...
