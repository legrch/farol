#!/bin/sh
# Root-module Tasks policy checks only; no provider/native acceptance is claimed.
set -eu
module_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH= cd -- "$module_dir/../.." && pwd)
cd "$repository_root"
if [ ! -f go.mod ]; then
  echo "Tasks verification requires the accepted root Go module." >&2
  exit 1
fi
GOWORK=off GOPROXY=off GOSUMDB=off go test -race -count=1 ./modules/task/...
GOWORK=off GOPROXY=off GOSUMDB=off go vet ./modules/task/...
