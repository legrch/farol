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
