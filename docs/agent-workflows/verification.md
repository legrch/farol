# Workflow source verification

Implementation commit: `9743acee307396febb7594fb28b379db69317e29`.
Implementation tree: `755b639d4a5355d971de51429a1b3362b8d4a675`.
Base commit: `99aca15ffe16b435e59b19c20ff48e06bd56960d`.
Base tree: `92047a064fede82658c37cf0f0a76004f6ce291c`.
Branch: `feature/agent-workflows`. This receipt is a documentation-only follow-up
to the tested implementation; its final commit is recorded by the export manifest.

## Package coverage

| Package                | Implemented behavior and evidence                                                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1 finite plan         | Bounded IDs, unique operations, acyclic dependencies, capability/output expectations; pure validation tests.                                                                       |
| W2 policy              | Caller budget, declaration-order fairness, pause/closed parent, unknown occupancy, independent progress around blocked input/provider; pure scheduling tests.                      |
| W3 durable dispatch    | Original-operation reads before Create, controlled runtime admission, existing Task intention-before-effect; real service composition and lost-ACK witnesses.                      |
| W4 result and delivery | Exact retained dispatch/reference correlation, bounded accepted dependency output, independent parent ACK receipt; real filesystem/reconstructed-service tests.                    |
| W5 cancellation/resume | Request versus terminal observation, unknown cancellation ACK fence, explicit exact Continue/Claude Resume with fresh upstream route; actual Task composition tests.               |
| W6 composed acceptance | Existing filesystem repository, selected Owner/Route, NewOwned Task service and control DTO facade; controlled provider/authority/admission, corruption/restart and failure cases. |
| W7 projection          | Content-free completion/output/cancellation/delivery states, documented offline plan executed by the real composition fixture; no shipping UI registration.                        |

## Portable verification

On Linux with Go 1.26.2, Node 24.20.0 and npm 11.19.0:

- `go test -race ./modules/task/domain/workflow ./modules/task/app/services/workflow -count=1`: PASS.
- `go vet ./modules/task/domain/workflow ./modules/task/app/services/workflow`: PASS.
- `node tooling/check-go-architecture.mjs`: PASS (433 production files,
  375 named test files).
- `node tooling/generate-desktop-wire.mjs --check`: PASS, unchanged
  `farol-wire/2`, digest
  `f4e830e1e8c1ac12473c55e905b1dda43046d541de05169886942d39560809ea`.
- Locked `npm ci --ignore-scripts --no-audit --no-fund`: PASS; dependency
  manifests unchanged.
- Owned documentation formatting, staged ownership audit, complete diff
  whitespace check and gitleaks scan of the owned diff: PASS.

The first portable baseline Task race command failed because the default Go
build cache was read-only. Using an explicit writable workspace cache passed.
The first generated check could not find gofmt; after selecting Go, Node's
default sandbox child pipe stalled. That exact process was terminated, and a
small diagnostic retained its timeout. The same generated check under the
supported network-enabled command sandbox passed with no generated changes.
These command failures are retained; no provider effect was retried.

The frozen implementation's aggregate gates did **not** pass:

- `task ci:fast`: task exit 201 (underlying CI exit 1). Toolchain, typecheck,
  lint, formatting and TypeScript architecture passed. The TypeScript coverage
  run reported 45 failed / 451 passed / 7 skipped files; 471 failed / 11,198
  passed / 305 skipped / 2 todo tests. Failures include missing `/usr/bin/xcrun`,
  missing `/private/tmp`, `PROMOTION_LEASE_PLATFORM_UNSUPPORTED`,
  `DARWIN_PROFILE_TEST_REQUIRED`, and other native/refusal assertions outside
  this slice. No separate B0 aggregate run establishes causality for every
  failure. Renderer coverage, Hunt, build/output and final scan stages were not
  reached by this command.
- `task test:core`: task exit 201 (underlying root Go race exit 1).
  `TestRepositoryConfigNativeOrdinaryReadCreateEdit` failed with
  `WORKSPACE_PATH_REFUSED (native-workspace)` in Computer filesystem.
  `TestNativeMutationPublicationSerializesSoleStoreWithdrawal` failed in all
  eight settings/connector subcases with `publication was not entered` in
  Computer access. Workflow and existing Task packages passed in that same
  root race run. The generator/import checks passed before it. No shared-owner
  source was changed to suppress these failures.

Checks skipped by those early exits were run separately: root `go vet ./...`,
nested `resources/native/go` race/vet, the desktop-wire and Go-architecture
contract suites (169 tests), and strict desktop-core TypeScript compilation all
passed. The already-passed general TypeScript compilation was not repeated.
The aggregate failures remain open despite these independent passes.

## Review and integration limits

Self-review and bounded independent source inspection found and corrected
stale-dispatch control/delivery attribution, follow-up receipt attribution, and
failed-terminal delivery gating. The independent targeted recheck passed;
regression tests cover these cases. This is source specialist inspection,
not a completed formal Critic acceptance ladder. Formal R3 review remains pending
for this durable-operation orchestration range.

SOURCE, PORTABLE, controlled COMPOSED, and exact source PUSHED are separate
claims. Production composition still requires the narrow owner seams in
[integration.md](integration.md): immutable plan activation, the SAME selected
Task DTO adapter, atomic `CancelExact`/`DeliverExact`, and serialized global
admission. The fixture's sequential exact guards do not qualify concurrent
production mutation. No Task journal, authority issuer, provider loop or Chat
scheduler is introduced.

Combined integration, formal review, Mac/native ownership and one-shot live
provider acceptance remain open. There is no main merge, tag, package or release
qualification. Persistent Goal and native peer messaging were unavailable;
this finite source queue creates no autonomous wakeup or background guarantee.
