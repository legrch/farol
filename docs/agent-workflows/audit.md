# Workflow acceptance audit

The additional audit starts from published checkpoint
`86c975c8097bddd06e0059118a32715f9db20f40` without changing B0 or branch ownership.
The packet defines seven runtime/source packages; the subsequent acceptance
supplement adds mutation/recovery auditing, not another scheduler or store.

## Reproduced defects and fix

Two regression assertions failed on the checkpoint:

- `TestCaptureCallerPlanAndBudgetBeforeFirstPortCall`: a first-read callback
  changed a later step's ID, operation/dependency and capability map. The report
  used the changed identity and started no original steps.
- `TestComposerCannotMutateCapturedRequiredCapabilities`: Composer changed a
  shared required-capability slice to resume. The service skipped step A and
  started B; the caller's required capability was also changed.

Domain `Capture` now bounds metadata before allocation, clones step/dependency/
capability slices, and validates the detached plan. Every application operation
captures before its first port call. Tick snapshots the five recognized budget
capabilities; Composer receives a separate step clone and fresh dependency map.
An actual Task composition witness mutates caller metadata during the first Read,
then reopens the filesystem journal and aggregates the original A/B outputs.
The caller still synchronizes input during synchronous capture. Durable original
plan retention and owner-atomic mutation remain the same external seams.

## Additional acceptance coverage

| Edge                                | Source witness                                                                                                                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact edge budget and maximal chain | `TestAuditExactDependencyBudget`, `TestAuditMaximalForwardReferenceChain`: valid 1024-edge DAG, 1025-edge refusal, 128-step chain and full-depth closing cycle.                                      |
| Disconnected invalid component      | `TestAuditDisconnectedInvalidComponentsBlockAdmission`: unreachable cycle, missing/empty/non-ASCII/control/overlong dependency; no unrelated root escapes validation.                                |
| Deterministic ready ordering        | `TestAuditReadyOrderIgnoresOutcomeMapInsertion`: 24 insertion permutations, shuffled declaration order and occupied budgets.                                                                         |
| Mutable input across port calls     | Capture/Composer unit regressions, deep-copy domain tests and `TestCompositionCapturedIdentitySurvivesPortYieldAndJournalReopen`.                                                                    |
| Cancellation versus new dispatch    | `TestCompositionAuditStaleCancellationCannotAffectActiveFollowup`: interrupted original delivered, supported epoch2 continuation, stale original cancellation changes neither dispatch nor snapshot. |
| Duplicate acknowledged delivery     | `TestCompositionAuditDuplicateKnownDeliveryACKSendsExactlyOnce`: repeated workflow projection and actual Task operation replay across journal reopen cause one parent Send.                          |
| Partial projection recovery         | `TestCompositionAuditPartialProjectionReopensAcceptedSiblings`: both sibling orders, lost second observation ACK, reopen consumes both retained outputs and aggregates once.                         |
| Concurrent terminal arrivals        | `TestCompositionAuditConcurrentIndependentResultsAggregateOnce`: two actual facade Result calls reach a controlled barrier, both results are retained and one aggregation starts.                    |

The concurrent-arrival provider wrapper synchronizes only synthetic fixture
controls. It does not qualify global workflow admission, owner-atomic production
Cancel/Deliver, Mac ownership or live provider concurrency.

## Validation scope

The failing mutation assertions are retained as original evidence. A separate
race command during concurrent audit development failed to resolve the test's
`time` import; the frozen-source recheck passed. It is not counted as a reproduced
production defect. Independent read-only inspection and targeted race recheck
of the capture fix passed.
The Go naming check also rejected two new test filenames with extra underscores;
they were renamed to joined lowercase names and the check passed.

The final audit delta is checked with workflow race/vet, Go import enforcement,
documentation formatting, complete diff/staged ownership inspection and an
owned-diff secret scan. The unchanged-source aggregate failures and initial
command failures in [verification.md](verification.md) remain failures, not
superseded passes. The final export records exact source/receipt commits and
restoration checks. Formal R3, production wiring, combined integration, LIVE
and MAC remain pending; no new persistence mechanism is introduced.
