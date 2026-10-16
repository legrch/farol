# ADR-0001: Application operations, names and layer roles

Status: Accepted for new code; existing code migrates in bounded waves.
Date: 2026-10-15

## Context

Farol's Go backend grew quickly across four modules (`computer`, `chat`,
`task`, `release`). A read-only audit at `2de5dd27` found:

- No application type uses `Command` or `Query`. Application operations use
  `XRequest -> *XResponse`, generic `Request -> *Result`, positional byte
  arguments or session handles, so a reader cannot tell intent from the
  signature.
- Some application DTOs are aliases of each other (`type ReadRequest =
CheckRequest`), which couples operations that should evolve independently.
- About 250 of 584 production Go files and many packages carry compound names
  (`settingsworkspace`, `interruptedretirement`, `contextcheckpoint`). Several
  hide two responsibilities or a mechanism filed as a use case.
- `app/capabilities/` exists once; reusable policies, leases and gates live
  under `app/services/` and some infrastructure imports service packages for
  their port types.
- Several mutable aggregates expose invariant-bearing fields, and one
  repository re-derives a domain transition to validate it.

The existing architecture guard enforces layer direction, cross-module
contracts, short file names and service-to-service imports, but not package
names, operation shapes, capability direction or aggregate privacy.

## Decision

### Operation types

| Boundary                                    | Input                                                        | Output                                            |
| ------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------- |
| Transport (desktop wire, MCP, HTTP)         | `XRequest`                                                   | `XResponse`                                       |
| Published cross-module contract             | `XRequest`                                                   | `XResponse`                                       |
| Application operation that may change state | `XCommand`                                                   | `XResult`                                         |
| Application operation that only reads       | `XQuery`                                                     | `XResult`                                         |
| Repository                                  | ID or repository-owned `XQuery`, aggregate or explicit input | aggregate, `XView`, `XResult`, scalar or metadata |

- Classify by effect, not by verb. An operation that refreshes, records or
  renews anything is a `Command`, even when it is called "read".
- A `Command` may load state first and may return an ID, version or view in
  its `Result`. No command bus, handler registry or separate read store is
  implied.
- Each pair is its own type. Map explicitly between transport, contract,
  application and repository types. Never alias another operation's or another
  layer's DTO, and never pass an application `Command` or `Query` to a
  repository or outbound port.
- The same word `Query` may appear in an application package and a repository
  package: different packages, different owners, different meaning.
- Exported application operations use
  `func (s *Service) Create(ctx context.Context, cmd CreateCommand) (*CreateResult, error)`
  on one line when it fits.
- Input and output types live directly above their operation in that
  operation's file (`create.go`, `list.go`, `approve.go`).
- Session-style protocols that hand out a handle (for example chat turn
  lifecycle) keep role-style methods; apply this table to their entry
  operations only.

### Names

- A Go package or production file is one lowercase semantic word: `approval/`,
  `checkpoint/`, `create.go`, `policy.go`. Packages are singular.
- Plural names are reserved for organizational directories that contain
  packages: `services/`, `capabilities/`, `contracts/`, `repos/`, `clients/`.
- A compound name is a prompt to re-check ownership, not something to
  concatenate away. Split or move responsibilities before renaming.
- Underscores appear only in `_test.go` and generated files.
- No catch-all names: `util`, `common`, `helper(s)`, `types`, `values`,
  `misc`, `manager`.
- Never rename wire symbols, persisted keys, journal schemas, bundle
  identifiers, pinned evidence paths or externally selected routes for style.
  Those change only with an explicit migration or requalification.

### Services and capabilities

- `app/services/<feature>/` holds one use-case `Service` with one file per
  operation. Services never import other services.
- `app/capabilities/<role>/` holds a reusable application mechanism (policy,
  gate, lease, resolver) with its own dependencies, used by several operations
  or composed at boot. Its root type is named by role (`Guard`, `Policy`,
  `Resolver`) and need not follow the Command/Query table.
- Outbound dependencies are interfaces in `app/port`. Infrastructure imports
  ports, never service packages.
- Private helpers stay inside the operation or service that uses them.

### Domain

- Aggregates whose fields carry invariants keep those fields private, expose
  behaviour methods and provide a validated constructor plus an explicit
  reconstruction function for repositories.
- DTOs, immutable snapshots, views and wire values may export fields; declare
  which kind a type is in its comment. Copy slices and maps when ownership
  changes.
- Transition rules live in the domain once. Repositories call the same domain
  function instead of re-deriving a transition.

### Tests

- Tests sit next to their subject: `create.go` -> `create_test.go`,
  `service.go` -> `service_test.go`.
- Facet suites (`native`, `race`, `fuzz`, `integration`, `composition`) are
  legitimate without a same-named production file.
- Do not add empty test files for symmetry. A test without a same-named subject
  is reviewed, not rejected.
- Composition across services belongs in `boot` or integration tests.

### TypeScript

Go remains the backend authority. TypeScript keeps UI, Electron, preload, IPC
and browser adapters, organized as domain, app, contract, infra and entrypoint
zones with runtime parsing at every boundary. TypeScript must not grow a second
copy of backend policy; existing copies are deleted when their Go route is
accepted. Go file-naming rules do not apply to TypeScript.

## Alternatives considered

- **Keep application `Request/Response`.** Familiar and consistent with
  transport, but intent stays invisible and transport and application types
  look interchangeable, which encouraged aliasing.
- **Full CQRS with buses and separate read models.** Rejected: no scaling or
  audit need justifies the indirection, and it would hide the effect boundary
  this decision wants visible.
- **Rename everything at once.** Rejected: unreviewable, collides with active
  native and release work, and risks wire or persisted-name drift.

## Consequences

- New code follows this record immediately. Existing code migrates
  module by module in behaviour-preserving pull requests.
- The pilot lands with this record: Computer Settings workspace browsing moves
  from `settingsworkspace` to `browse`. The application exposes
  `ListQuery`, `SearchQuery` and `SnapshotQuery`, each returning its own
  `Result`, in `list.go`, `search.go` and `snapshot.go`; List and Snapshot no
  longer share an input type. The published contract exposes independent
  `ListRequest`/`ListResponse`, `SearchRequest`/`SearchResponse` and
  `SnapshotRequest`/`SnapshotResponse`, mapped explicitly. All three are
  Queries by effect. Wire types come from `gen/desktop/v1`, so no wire,
  persisted or pinned name changes; the test inventory is unchanged.
- W0 implements package-name, generic-name, capability-direction, infrastructure-to-service and DTO alias checks in report mode, with exact existing exceptions in `tooling/go-architecture-baseline.json` at source `df8efa37eef45ead673db071c9579a9111b67ac7` and synthetic positive/violation fixtures in `tests/fixtures/go-architecture/cases.json`. Existing blocking rules remain blocking; these new rules become blocking per module only in later migration waves.
- Run `node tooling/check-go-architecture.mjs --json` for blocking violations plus all ADR reports, each marked `existing` or `new`, and stale baseline entries. Run `npm test -- tests/architecture/go-architecture.test.ts`, `npm run docs:check`, and `git diff --check` for verification. The architecture test checks exact baseline coverage; new reports and stale exceptions require explicit review. The executable exits nonzero for existing blocking violations or invalid baseline data; ADR reports alone do not change its exit status. Baseline entries match exact code/path/detail triples, never patterns, and cannot exempt blocking rules; there is no automatic baseline update command.
- `GO_PACKAGE_NAME` uses the explicit lowercase package vocabulary in `tooling/check-go-architecture.mjs`, checking both package-directory leaves and package clauses independently; package and directory names need not match. Unknown words, compounds, plural tokens and non-lowercase tokens are reported unless explicitly admitted to that vocabulary. Organizational directories without Go packages are not checked. The vocabulary is an admission list, not a dictionary or a semantic word splitter; new legitimate package words need deliberate review. Production file semantic word counts and singular meaning remain manual review concerns; the existing lexical file-name guard remains unchanged.
- `GO_CATCH_ALL_NAME` checks exact package/file stems `util`, `utils`, `common`, `helper`, `helpers`, `types`, `values`, `misc`, `manager`. `GO_CAPABILITY_DIRECTION` reports `app/capabilities/**` imports of `app/services/**`; `GO_INFRA_SERVICE` reports infrastructure imports of service packages. Service-to-capability and infrastructure-to-port imports remain allowed within the existing module/layer rules. These checks inspect source paths, including every build variant, rather than proving runtime dependency use.
- `GO_DTO_ALIAS` checks top-level direct named Go type aliases (including grouped declarations, import aliases and generic aliases) whose two names end in `Command`, `Query`, `Request`, `Response`, `Result` or `View`. It reports different operation-name prefixes, different owned package paths (including module/layer boundaries) even with identical prefixes. Defined types and explicit mappings are allowed. Pointer/composite right-hand sides, transitive alias chains, external type ownership, import-name resolution beyond explicit aliases or path leaves, effect classification, DTO placement, repository parameter flow and aggregate privacy remain outside this lexical guard. Comments, literals, function-local types, test bodies and generated schema source are excluded from these reports. Fixtures establish deterministic source inspection only, not compilation, native-host behavior or product acceptance.
- Other projects may keep application `Request/Response` under their own
  decisions; this record governs Farol only.
