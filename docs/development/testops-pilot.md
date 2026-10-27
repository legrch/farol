# TestOps planning and measurement pilot

This first adoption slice adds read-only inventory and deterministic iteration
planning. It is experimental and needs independent review before integration.
Existing source, native, package and release gates remain authoritative.

## Commands

`task test:inventory` lists observed command declarations and test files with
source hashes. Static declaration discovery does not establish runtime effects,
platform support or complete CI coverage. Run
`node tooling/testops/catalog.mjs .` for the data-only Task include, namespace,
alias and dependency catalog. It uses the already locked Prettier YAML parser;
it never evaluates Task variables or shell expressions. Unresolved declarations
remain explicit gaps.

`task test:affected -- --base main --explain` includes committed changes from the
explicit merge base, staged, unstaged, untracked and physical source differences.
Reasons accompany selection. Unknown mappings broaden selection and return
NEEDS_REVIEW; source redirects and hidden index state refuse admission. This is
PLAN_ONLY and never executes tests or replaces final acceptance. Compiler-derived
metadata is an optional advanced input whose producer is not part of this slice;
without it the conservative source planner remains usable.

`python3 -B tooling/testops/testops.py dag --manifest PLAN.json --jobs 2` simulates
declared dependencies and exclusive resources. Simulation timings are estimates,
not measured CI speed or execution authority. The actual CI scheduler is a later
independently qualified adoption slice.

`python3 -B tooling/testops/measure.py --help` describes the opt-in bounded timing
experiment. It executes only its three fixed documentation/import-boundary
checks against authenticated tools and source. Capture a complete baseline before
comparison; preserve failures, tool identities, setup limits and source hashes.
This experiment is not a full project CI benchmark.

## Verification and remaining delivery

Run `python3 -B -m unittest discover -s tooling/testops -p test_testops.py` and
`node --test --test-concurrency=1 tooling/testops/catalog.test.mjs` using the
declared toolchain. They use disposable fixtures. Run `node
tooling/testops/registry.mjs` to observe existing source registrations; this
adapter does not alter their membership or execute a suite.

This slice retains all existing public commands and CI ordering. It does not
introduce a new green partial root test aggregate, promote Linux skips to native PASS,
or implement deployed DEV/PROD commands. E2E describes behavioral scope; deployed
DEV/PROD verification, controlled-write QA and local product fixtures remain
separate adoption obligations. Private cross-project inventories and raw test
evidence remain outside source history.

## Compiler-derived affected plans

`node tooling/testops/languagegraph.mjs` emits a source-bound TypeScript graph
using the locked compiler and parser. Save it under ignored output, then pass its
path to the existing affected command with `--compiler-metadata`. The graph and
selected plan remain data only: neither permits executing the selected product
tests. Every input source hash must still match. Unsupported import/dynamic-load
behavior broadens selection rather than silently omitting a consumer.

Go collection is opt-in and requires all of `--go`, `--go-sha256` and `--cache`.
It invokes only metadata collection with an explicit executable pin and private
cache. The default graph covers the declared Darwin/Linux arm64 contexts with
CGO disabled; this does not qualify either operating system or native behavior.
The optional `--go-runtime linux-arm64-race` context remains explicit and must not
be inferred for other hosts. No automatic toolchain or dependency acquisition is
part of graph collection.

The focused Go accounting adapter retains exact package, top-level test and
observed subtest membership, requiring original run and terminal events. Its
fixed four-package policy is a bounded prerequisite for a later opt-in Linux
executor, not general Go execution authority. Existing core race/vet and native
gates remain required. Unknown packages, changed membership and incomplete event
streams are refused; no recorded green result can authorize a replay.

Run the two additional existing controls with `node --test --test-concurrency=1
tooling/testops/languagegraph.test.mjs
tooling/testops/iteration-witness.test.mjs`. The iteration witness executes only
fresh synthetic fixture tests, comparing full and selected case membership;
it does not execute selected Farol tests. Actual resource-safe CI and the
host/container affected executor remain separate qualified adoption work.

## Batched source attestation

The source snapshot reads explicitly requested committed Git blobs through the
system Git batch protocol, with length-framed binary parsing and bounded replies.
It still compares every regular working file, retains independent expected-byte
buffers per path, and rejects dirty state, hidden index flags and unreadable
inputs. No cache crosses snapshots. Invalid or failed batch responses refuse;
they never trigger a fallback. Oversized individual blobs use the original
bounded reader, selected before execution.

This changes shared source attestation and needs independent review and exact
candidate checks. A matched comparison must retain the same commit, complete
identity/reasons and all entry data, modes and object IDs. Report wall time, CPU
and peak memory separately. A faster snapshot does not by itself qualify an
entire CI gate, package, native route or installed application. Existing compiler
refusals, output-preservation checks and their time limits remain unchanged.

## Bounded Linux execution and complete CI composition

`task ci` now composes every leaf of the previous complete `ci:fast` gate,
including source coverage, Hunt/build evidence, full core race/vet and protocol
checks, output checks and secret scanning, plus `test:tooling`. `ci:fast` is a
compatibility alias. `ci:cloud` retains every previous portable obligation and
adds tooling controls; native/resource/mixed and package acceptance remain
separate. No native test is removed or reclassified by this adoption packet.

`task test:tooling` runs the toolchain check, all discovered Python controls and
the three adopted Node control files. The observer and public task must register
the same actual files. Experimental native obligation admission remains in its
separate retained packet; this source increment does not implement or accept the
all-local-family root union.

The optional `tooling/testops/docker_gate.py` runner executes the fixed portable
source, full core, tooling and secret-scan branches with one or two jobs. Each
job has an owned network-disabled container, read-only source/dependency/SDK
inputs, private output and cache, two CPUs, 3 GiB memory and 256 PIDs. Admission
binds exact clean source, locked dependency content, tools and original command
receipts. Source changes, incomplete reports, OOM, cancellation and unknown
retirement cannot become PASS. It requires explicitly prepared owned volumes
and dependency evidence; it does not pull images or acquire dependencies.

This local Docker adapter is qualified only for host UID 501 and the declared
Linux arm64 tool/image/input set. Its paths and prepared volumes are explicit
inputs, not a portable installation standard. Ordinary `task ci:cloud` remains
the source entrypoint for a separately provisioned Linux runner. Container
qualification alone does not prove a hosted CI workflow or native Mac coverage.

`tooling/testops/affected_host.py` is a separate opt-in controlled iteration
runner. It authenticates a clean source and dependency binding, collects fresh
compiler metadata in an owned container, and validates original selected-file
and case receipts. Unknown mappings widen or refuse. The focused Go route is
limited to its fixed four-package policy. `task test:affected` remains PLAN_ONLY;
neither affected mode replaces the complete source, native or release gates.

The extracted core command plan retains all nine original commands, flags,
ordering and nested-module contexts. Its final marker records only completion
of that command chain; it does not invent Go case counts or general descendant
containment. A fixed contract test retains the original command array.

## Owned Docker volume lifecycle

The gate runners only consume volumes; they never create or remove them, and
`docker_gate.py` removes only its own per-run `docker-client-*` config, even on
failure. Hand-created `farol-testops-*` volumes are not allowed: they have no
lease and leak. Use `python3 -B tooling/testops/testops.py volumes ACTION
--docker /ABS/docker [--socket SOCK]`:

- `prepare --scope farol-testops-XXXXXXXX --volume NAME... [--retain run|cache
--cache-key KEY] [--label farol.testops.source=HEAD] [--owner-pid PID]`
  registers the lease `_output/testops/scopes/<scope>.json` (exact names, owner
  pid and `ps` start time) before creating any volume, then creates them with
  the `farol.testops.task`, `created` and `retain` labels. The owner defaults to
  the calling process's parent: the long-lived runner that prepares, runs the
  gate and releases. A failed prepare leaves the lease, so cleanup still sees
  every requested name.
- `release --scope ...` needs this checkout's lease for the scope, made on the
  same Docker endpoint; otherwise nothing is touched. It acts only on volumes that currently carry this
  checkout's and scope's labels. It force-removes the scope-named containers
  that mount those run volumes, then removes the volumes by exact name and
  verifies absence. Cache volumes are left to prune. The lease is deleted only
  after verified absence.
- `prune` considers only volumes with the `farol.testops.task` label and this
  checkout's `farol.testops.checkout` label (a random identity minted once in
  `_output/testops/checkout.id`): leases are per checkout, Docker is shared, so
  another checkout's volume is reported `unknown`, never removed. It keeps
  volumes of a live lease (same pid and start time), volumes referenced by any
  container including stopped ones, and the two newest unreferenced cache
  volumes per `farol.testops.cache-key`. A volume whose name or scope appears on a live process's command line
  (a gate that outlived its runner) is kept as active. It removes the rest by exact name.
- `status` prints JSON with each labelled volume, its size when Docker reports
  one, and `active`, `removable`, `protected` or `unknown`.

A short exclusive flock on the permanent `_output/testops/volumes.lock` covers
lease registration with creation, release and prune's check-and-remove. It is not
held while tests run. Any rm error, remaining volume or unreadable lease/engine
state reports `INCOMPLETE` with a non-zero exit, never PASS, and keeps the volume.

## Process log budgets

Each generic container job shares a 32 MiB retained stdout/stderr budget across
its commands. Both original pipes are drained; truncation or log I/O failure
prevents success or a successor, including an original zero exit. Original
terminal/EOF and namespace retirement remain required. Each measurement probe
retains at most 1 MiB across both streams, with direct-child termination on
excess output and failure even after exit zero. Its interruption still does not
prove descendant cleanup. Arbitrary generated artifacts and caches on the
writable output bind have no disk quota and require operator storage admission.

## Original execution evidence

Pipe-derived digests and byte counts remain immutable. The observer checks
every retained stream before consuming reports or issuing a successor and
again after namespace retirement; the host independently checks those original
digests, counts, EOF and I/O facts. An unexpected adopted child, including an
already-reaped zero-exit child, prevents PASS. A successful retirement record
contains no descendant PIDs, reaped terminals, signals or errors.

Host report and nested cloud JSON reads are limited to 16 MiB each, and each
log read to the shared 32 MiB output ceiling. Both the initial file size and a
bounded read detect excess or file growth. Arbitrary artifact and cache writes
still have no disk quota and require operator storage admission.

Cleanup and retirement require the admitted Docker engine identity before and
after inspection, and before and after a stop. A changed or unreadable engine
cannot prove retirement or authorize another stop; the original handle remains
in custody. These checks observe the selected endpoint; they are not an atomic
daemon transaction.

## Final retained-log integrity

Final log validation uses the same bounded, non-following physical reader as
ordinary evidence validation. A sparse oversized log, path replacement or I/O
failure records failure without an unrestricted final read or replacing original
pipe/write digests. Capture records per-sink write order as well as per-stream
observations, including merged measurement logs. Affected failure finalization
retains the lease and persists its nonpassing report after log rejection;
generated compiler/cloud JSON uses the same bounded evidence path. These unit
and protocol guarantees do not supply native or current Linux execution evidence.

## Go test source consumers

Reverse Go package selection is narrow only when every discovered test belongs
to the Go package graph. Any non-Go test can inspect Go source, including a
configured TypeScript consumer whose file reads are absent from import metadata.
Such changes broaden to the complete inventory with
`GO_SOURCE_CONSUMER_OWNERSHIP_UNAUDITED` and `NEEDS_REVIEW`; both affected execution
routes refuse before selected tests. This currently disables narrow Go iteration
in this mixed repository until cross-language source ownership is qualified.
Pure Go test inventories retain reverse-package planning. Complete CI and all
native, package and release gates remain unchanged.
