# ADR-0002: Uniform names, tests, composition and shared code

Status: Accepted. Wave 0 lands this record and the checker; existing code
migrates module by module behind a per-rule enforcement switch.
Date: 2026-11-13
Partly supersedes: [ADR-0001](0001-application-operations.md) (see
[Relation to ADR-0001](#relation-to-adr-0001)).

## Context

ADR-0001 fixed application operation shapes and one-word package names, but
left file names, tests and the composition root to review. On `main` at
`9de07bcfed6d67b74dc90ea0b7d3ba69ad0fa181` the checker in this record measures
591 production files outside the word vocabulary, 235 tests without a
same-named source, 238 files with behavior but no test, 195 test files plus
`testdata/` and 162 files outside the target file set in `boot/`, and 347
logic findings (per kind and file) inside `boot/`. The
underscore ban made Go's own platform suffixes impossible, so platform words
were glued into stems (`anchordarwin.go`). Any module import of a new
`pkg/<word>` was refused, so stateless helpers (bounded reads, digest and
descriptor predicates) were copied into 24 packages. ADR-0001's exact-row report
baseline (117 rows) cannot carry the roughly 2,000 findings the rules below
produce.

The owner decided the rules below on 2026-11-13. The design inputs are the
private refactoring audit of that date (conventions N/L/O/B/T and K1-K6, the
kernel and `pkg` design, and the chat/task, computer/release and boot
inventories).

## Decision

### 1. Names

- A Go package directory, its `package` clause and a Go file stem are each
  **one word from one admitted vocabulary**: the `words` set in
  [`tooling/check-go-architecture.mjs`](../../tooling/check-go-architecture.mjs).
  The vocabulary is an admission list reviewed word by word, not a dictionary.
- The `package` clause equals the directory name (`main` under `cmd/`).
- A two-word name is a rare exception: an explicit row in
  [`tooling/go-architecture-enforcement.json`](../../tooling/go-architecture-enforcement.json)
  with a `reason` and a `removal` condition. It signals a decomposition problem;
  the target count is zero. Never admit a compound into the vocabulary.
- `_` appears only in `_test` and in suffixes the Go toolchain itself
  interprets: `x_<GOOS>.go`, `x_<GOARCH>.go`, `x_<GOOS>_<GOARCH>.go` and their
  `_test` forms, using the toolchain's known lists. `unix` is a build tag, not a
  file-name suffix (`x_unix.go` would build on every platform), so a Unix-only
  file uses `//go:build unix`. Protoc-generated `*.pb.go` under `gen/` keeps
  its existing exception.
- Catch-all stems stay banned and gain `info`, `record`, `base` and `impl`.
- Plural names remain reserved for grouping directories without Go files
  (`services/`, `capabilities/`, `contracts/`, `repos/`, `clients/`).

### 2. Tests

- `x.go` has at most one test file, `x_test.go`; `x_darwin.go` pairs with
  `x_darwin_test.go`. A test file must have its source file. The one unpaired
  test is `<package>_test.go` for package-level tests. Facet suites
  (`*native_test.go`, `*race_test.go`, journeys) fold into their subject's test
  or move under `tests/`.
- Every production file **with behavior** has its test. A
  **declaration-only** file needs none. Mechanically, a file is declaration-only
  when it contains no function literal outside function bodies and every
  top-level function or method either has no body or is trivial. A trivial
  function is a constructor named `New` or `New<Upper>…`, or a `String`,
  `Error`, `GoString` or `Unwrap` method, whose body is exactly one `return`
  statement containing no function literal. Interfaces, error values,
  constants, plain value types and `doc.go` are therefore declaration-only;
  any other method body (`Valid`, `Retry`, `init`) is behavior.
- The rule applies outside `boot/` (which has no tests), `cmd/` (thin entry
  points) and generated `gen/` code. Do not add empty test files for
  declaration-only files.

### 3. Composition root

- `boot/` is pure composition: `boot.go` plus one file per module
  (`computer.go`, `task.go`, `chat.go`, `release.go`), no subpackages, no
  `_test.go` files and no `testdata/`. Whole-graph tests live under `tests/`.
- No logic: no `switch`, `for`, `select` or `go` statement; `if` only as
  `if err != nil` (including `if err := f(); err != nil`); at most one
  top-level type per file (the module namespace type); at most 400 lines per
  file.
- Reusable mechanisms live in `pkg`; decisions live in modules.

### 4. Operations

- Application services take a `Command` or `Query` and return a `Result`:
  `func (s *Service) Create(ctx context.Context, cmd CreateCommand) (*CreateResult, error)`.
  The input type is named after the method (`<Method>Command` or
  `<Method>Query`); the result is `*<Method>Result`.
- `Request`/`Response` are used at published contracts and the desktop wire,
  never as application types; contracts never declare `Command`/`Query` types.
- This is a recorded deviation from the owner's sc-platform project, which uses
  `Request`/`Response` in every layer. ADR-0001 rejected application
  `Request`/`Response` because intent stays invisible and invited aliasing.
- ADR-0001's session-protocol exemption stays. Exempt packages must be listed
  by exact path in the checker's `sessionPackages` set; none is listed until
  the owner names them.

### 5. Desktop adapters live in modules

Each module owns one inbound desktop adapter directory,
`modules/<module>/desktop/<feature>/`. It maps `desktop.Request` to its own
module's contracts or application services and back. It may import its own
module's `contracts`, `app` and `domain`, kernel domain/app, kits, `pkg/ipc`,
`gen/desktop/v1` and the shared `transport/desktop` server. It never imports
its own infrastructure, another module (`GO_CROSS_MODULE`), kernel
infrastructure or `boot`. Only `boot` imports it; `transport/desktop` remains
the shared server and imports no module adapter.

### 6. Shared code

```text
pkg/
  kernel/domain/<word>/      values and classifications; importable by every
                             layer; imports only the pure stdlib allowlist and
                             kernel domain
  kernel/app/port/<topic>/   shared peer ports; importable by module app,
                             infra, contracts, adapters and boot
  kernel/infra/peer/         package peer: one shared peer implementation,
                             built by boot only
  <kit>/                     flat one-word infrastructure kit
```

- Kernel admits only those three shapes (`GO_KERNEL_LAYOUT`).
- A kit (`pkg/<word>`, an admitted non-catch-all word, flat) is importable by
  module `infra`, desktop adapters, `transport/desktop`, other kits and `boot`;
  never by module `domain`, `app` or `contracts`, kernel or `pkg/ipc`. A kit
  imports only the standard library, external modules, kernel domain/app,
  other kits and `pkg/ipc`; never a module, `boot`, `transport`, `cmd`, `gen`
  or kernel infrastructure (`GO_KIT_DEPENDENCY`).
- A shared peer is admitted only when at least two consumer modules need an
  identical shape and identical failure mapping; its owner contract is listed
  in `kernelPeerContracts` in the same pull request as the first adapter.
- Every shared package needs at least two real consumers with identical
  semantics and contains no business type. Shared implementations own no
  mutable cross-consumer singleton state.

This replaces the rule under which the checker refused any module import of a
new `pkg/<word>`.

### 7. TypeScript

TypeScript mirrors the same tree and module names (`agent` becomes `task`),
uses one-word file names and co-located tests. New tests that slice code out of
source text are banned.

### 8. Backend policy

Backend policy lives in Go modules: not in `boot`, not in Electron.

## Relation to ADR-0001

| ADR-0001 statement                                                                                                                                              | ADR-0002                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Operation types table, effect classification, explicit mapping, no DTO aliases, operation files, services versus capabilities, domain privacy, wire-name freeze | Kept.                                                                     |
| "Underscores appear only in `_test.go` and generated files."                                                                                                    | Superseded: also Go toolchain `_GOOS`/`_GOARCH` suffixes.                 |
| "package and directory names need not match"                                                                                                                    | Superseded: the clause equals the directory.                              |
| "Production file semantic word counts … remain manual review concerns; the existing lexical file-name guard remains unchanged."                                 | Superseded: file stems are checked against the package vocabulary.        |
| Catch-all list `util` … `manager`                                                                                                                               | Extended with `info`, `record`, `base`, `impl`.                           |
| "Facet suites (`native`, `race`, `fuzz`, `integration`, `composition`) are legitimate without a same-named production file."                                    | Superseded: no unpaired tests except `<package>_test.go`.                 |
| "A test without a same-named subject is reviewed, not rejected."                                                                                                | Superseded: rejected.                                                     |
| "Composition across services belongs in `boot` or integration tests."                                                                                           | Superseded: integration tests under `tests/`; `boot` has none.            |
| "Tests sit next to their subject" and "Do not add empty test files for symmetry."                                                                               | Kept; every file with behavior now has its test.                          |
| "Go file-naming rules do not apply to TypeScript."                                                                                                              | Superseded by decision 7.                                                 |
| W0 report baseline `tooling/go-architecture-baseline.json` (exact rows; reports never change the exit status; no update command)                                | Superseded by the enforcement switch below; the baseline file is removed. |
| Session-style protocols keep role-style methods.                                                                                                                | Kept; exempt packages are listed by path.                                 |

## Admitted words

ADR-0001's 60 words stay. This record admits the words the inventories
request, each for the package or file that needs it:

| Word                                         | Needed by                                                                                                                                      |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `budget`                                     | `chat/domain/budget`, `task/app/capabilities/budget`                                                                                           |
| `credential`                                 | `chat/app/services/credential`                                                                                                                 |
| `history`                                    | `chat/app/services/history`                                                                                                                    |
| `model`                                      | `chat/app/services/model`, `chat/domain/model`, `task/app/services/model`, `task/contracts/model`, `task/infra/model`                          |
| `openai`                                     | `chat/infra/clients/openai`                                                                                                                    |
| `peer`                                       | `chat/infra/peer`, `computer/infra/peer`, `task/infra/peer`, `pkg/kernel/infra/peer`                                                           |
| `plan`                                       | `chat/infra/plan`                                                                                                                              |
| `progress`                                   | `task/infra/progress`                                                                                                                          |
| `recovery`                                   | `chat/domain/recovery`, `chat/app/services/recovery`, `release/app/services/recovery`                                                          |
| `settings`                                   | `task/app/services/settings`, `task/contracts/settings`, `task/infra/settings`, `computer/app/services/settings`, `computer/app/port/settings` |
| `sse`                                        | `chat/infra/sse`                                                                                                                               |
| `thread`                                     | `task/contracts/thread`                                                                                                                        |
| `audit`                                      | `computer/domain/audit`                                                                                                                        |
| `channel`                                    | `release/infra/native/channel`                                                                                                                 |
| `check`                                      | `computer/app/services/check`, `computer/infra/repos/check`                                                                                    |
| `clone`                                      | `release/infra/native/clone`                                                                                                                   |
| `connection`                                 | `computer/domain/connection`                                                                                                                   |
| `dev`                                        | `cmd/dev` (replaces `cmd/faroldevcontrol`)                                                                                                     |
| `document`                                   | `release/infra/document`                                                                                                                       |
| `identity`                                   | `release/infra/native/identity`                                                                                                                |
| `input`                                      | `release/app/services/input`, `release/infra/native/input`                                                                                     |
| `inspect`                                    | `pkg/inspect`                                                                                                                                  |
| `lock`                                       | `release/infra/native/lock`                                                                                                                    |
| `machine`                                    | `computer/infra/machine`                                                                                                                       |
| `move`                                       | `release/infra/native/move`                                                                                                                    |
| `probe`                                      | `release/infra/native/probe`                                                                                                                   |
| `protocol`                                   | `release/app/services/protocol`, `release/infra/native/protocol`                                                                               |
| `route`                                      | `release/infra/native/route`, `computer/app/capabilities/route`                                                                                |
| `scratch`                                    | `computer/app/services/scratch`, `computer/domain/scratch`, `task/infra/scratch`                                                               |
| `slot`                                       | `release/app/services/slot`, `release/infra/native/slot`                                                                                       |
| `stop`                                       | `computer/app/services/stop`, `computer/infra/repos/stop`                                                                                      |
| `tree`                                       | `release/infra/native/tree`                                                                                                                    |
| `wait`                                       | `release/app/services/wait`                                                                                                                    |
| `activation`                                 | `computer/app/capabilities/activation`                                                                                                         |
| `chat`, `computer`                           | `boot/chat.go`, `boot/computer.go` (decision 3)                                                                                                |
| `cli`                                        | `transport/cli`                                                                                                                                |
| `delegation`                                 | `task/app/services/delegation`                                                                                                                 |
| `install`                                    | `release/infra/native/install`                                                                                                                 |
| `ledger`                                     | `computer/app/capabilities/ledger`                                                                                                             |
| `publication`                                | `computer/app/services/publication`, `computer/contracts/publication`                                                                          |
| `read`                                       | `task/app/services/read`                                                                                                                       |
| `relay`                                      | `chat/app/services/relay`                                                                                                                      |
| `retirement`                                 | `chat/app/services/retirement`                                                                                                                 |
| `session`                                    | `chat/app/services/session`                                                                                                                    |
| `descriptor`, `exchange`, `limit`, `profile` | kits `pkg/descriptor`, `pkg/exchange`, `pkg/limit`, `pkg/profile`                                                                              |
| `digest`, `failure`, `fence`, `root`         | `pkg/kernel/domain/{digest,failure,fence,root}`                                                                                                |
| `fake`                                       | `pkg/fake` (test doubles)                                                                                                                      |
| `contract`, `service`, `server`, `doc`       | `contract.go`, `service.go`, a desktop adapter's `server.go` and `doc.go` (role files of this record and ADR-0001)                             |
| `unsupported`                                | `unsupported.go`, the single `//go:build !darwin` fallback per package (Go has no "not darwin" suffix)                                         |

Not admitted: `helper` (catch-all stem; pick `agent`, `relay` or `updater` for
the release update agent), `selftest` (a compound: rename the concept, for
example `trial` or `probe`, or record an exception row), and `errors` (plural;
name an error-value file by its concept). File stems the target trees need
beyond this list are admitted in the migration pull request that introduces
them.

## Enforcement

[`tooling/check-go-architecture.mjs`](../../tooling/check-go-architecture.mjs)
implements every mechanical rule. Blocking rules fail the executable (and
`task test:core`) everywhere:

| Code                                                                           | Rule                                                                                       |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `GO_SHORT_NAME` (changed)                                                      | One lowercase stem plus only `_test` and toolchain `_GOOS`/`_GOARCH` suffixes.             |
| `GO_GENERIC_NAME` (changed)                                                    | The generic stems are refused with any suffix.                                             |
| `GO_KERNEL_LAYOUT` (new)                                                       | Kernel admits only `domain/<word>`, `app/port/<topic>` and `infra/peer`.                   |
| `GO_KIT_DEPENDENCY` (new)                                                      | Kit import directions (decision 6).                                                        |
| `GO_DESKTOP_DEPENDENCY` (new)                                                  | Module desktop adapter import directions (decision 5).                                     |
| `GO_LAYER_DIRECTION`, `GO_CONTRACT_LEAK`, `GO_TRANSPORT_DEPENDENCY` (extended) | Kits for module infra and transport; no kit in pure layers; no import of a module adapter. |
| `GO_EXCEPTION_STALE` (new)                                                     | An exception row that matches no finding or sits in an unmigrated scope.                   |
| `GO_REPORT_CEILING` (new)                                                      | A report count above its declared ceiling.                                                 |

These new blocking rules have no finding on `main`; several replace the former
blanket refusal of any unknown `pkg` path, which was also blocking. Migration
rules report everywhere and block only where a scope is migrated:

| Code                      | Rule                                                                        |
| ------------------------- | --------------------------------------------------------------------------- |
| `GO_PACKAGE_NAME`         | Package directory or clause outside the vocabulary.                         |
| `GO_PACKAGE_DIR`          | `package` clause differs from the directory (`main` under `cmd/`).          |
| `GO_FILE_WORD`            | File stem outside the vocabulary.                                           |
| `GO_CATCH_ALL_NAME`       | Catch-all package or file stem.                                             |
| `GO_TEST_ORPHAN`          | Test without its same-named source (except `<package>_test.go`).            |
| `GO_TEST_MISSING`         | File with behavior without its test (outside `boot`, `cmd`, `gen`).         |
| `GO_BOOT_TEST`            | Test file or `testdata/` under `boot/`.                                     |
| `GO_BOOT_FILE`            | `boot/` file other than `boot.go` and one per module, or a boot subpackage. |
| `GO_BOOT_LOGIC`           | Logic in `boot/` (decision 3), counted per kind and file.                   |
| `GO_OPERATION_SHAPE`      | Service method, application type or contract type shape (decision 4).       |
| `GO_CAPABILITY_DIRECTION` | Capability imports a service (ADR-0001).                                    |
| `GO_INFRA_SERVICE`        | Infrastructure imports a service (ADR-0001).                                |
| `GO_DTO_ALIAS`            | DTO alias across operations or owners (ADR-0001).                           |

A finding's scope is its module (`computer`, `task`, `chat`, `release`) or its
top-level directory (`boot`, `cmd`, `gen`, `pkg`, `transport`). The
enforcement file holds:

- `migrated`: per rule, the scopes where it is blocking. A scope is added only
  when its count reaches zero. The list only grows: the architecture test pins
  a floor (`migratedFloor` in
  [`tests/architecture/go-architecture.test.ts`](../../tests/architecture/go-architecture.test.ts)),
  so removing a migrated scope fails the test.
- `ceilings`: per rule and unmigrated scope, the highest allowed report count.
  Growth fails `GO_REPORT_CEILING`; lower a ceiling whenever a count falls.
- `exceptions`: exact `code`/`file`/`detail` rows with `reason` and `removal`,
  effective only in a migrated scope. Blocking rules cannot be excepted.

At Wave 0 every scope is in report mode for every migration rule and the
ceilings equal the counts on `main`, so the gate stays green with no production
change.

### Migrating a module

1. Run `node tooling/check-go-architecture.mjs --scope <module>` for that
   module's report lines and the per-rule, per-scope count table (`--json` for
   the machine form).
2. Fix the findings in behaviour-preserving pull requests. Renames never change
   wire symbols, persisted keys, journal schemas or error code strings.
3. In the pull request that brings a rule to zero for the module, add the
   module to that rule's `migrated` list, delete its ceiling and add the scope
   to `migratedFloor`. A remaining two-word name needs an exception row the
   owner has reviewed.
4. Run `npm run test:architecture` and `task test:core`.

## Alternatives considered

- **Keep the exact-row baseline.** About 2,000 rows would churn with every
  rename and drown real additions; per-scope switches plus count ceilings keep
  growth visible at a reviewable size.
- **Make every new rule blocking at once.** Impossible without one
  unreviewable rewrite of every module.
- **A dictionary or word splitter for names.** Rejected as in ADR-0001: an
  explicit admission list keeps every new word a deliberate review decision.
- **A shared `transport/desktop` holding every handler.** Rejected by decision
  5: handlers would need a published contract per call and grow one package
  past any reviewable size; the module owns its adapter.
- **Application `Request`/`Response` as in sc-platform.** Rejected, see
  decision 4.

## Consequences

- No production Go or TypeScript changes, renames or moves land with this
  record. Later waves rename and move per module and flip the switch.
- `tooling/go-architecture-baseline.json` is replaced by
  `tooling/go-architecture-enforcement.json` (source
  `9de07bcfed6d67b74dc90ea0b7d3ba69ad0fa181`).
- Run `node tooling/check-go-architecture.mjs` for blocking violations, report
  lines and the count table; `npm run test:architecture` and `task test:core`
  run the same checker and its fixtures.

### Limits of the mechanical checks

- All shape checks are lexical over a token stream with Go's semicolon
  insertion, not a Go parser or type checker; Go compilation still owns syntax
  and types.
- Declaration-only: a function type immediately followed by a composite literal
  on the same line (`map[string]func(){…}`) reads as a function literal, which
  errs towards requiring a test. A test file's existence is checked, not what
  it covers.
- Boot logic: closures, methods implementing ports and logic hidden in calls
  are review concerns; the check counts statements, conditions, types and
  lines.
- Operation shape: only exported methods on `Service` in `app/services` are
  checked. Whether an operation is a `Command` or a `Query` by effect, a
  non-nil result on success and DTO placement stay review concerns. The
  session list is empty until the owner names it.
- Shared code: the two-consumer test, identical shape and failure mapping, the
  no-business-type rule and singleton state are review concerns; only
  `kernelPeerContracts` is mechanical. The checker does not scan test imports,
  so test-only use of `pkg/fake` is not enforced, and boot-only kits are not
  modelled until the owner admits one.
- TypeScript (decision 7) and backend policy in Electron (decision 8) are not
  mechanised by this record; the TypeScript gate is unchanged.
- `cmd/` is outside the test-pairing rule; its development tool keeps untested
  logic until it moves into a kit.
