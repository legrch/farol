# C1–C7 portable acceptance audit

Audited source: `8462ce80cb9d0c17e0409210dc3382d1547ae800`, tree
`f11bc469deb100b5cafefbaf1fd9916595e9792f`. The preceding app source is
`426e4213f2fee2a3ddfb0d6e08c978c54c9848df`; exact aggregate failures at that
revision remain in [handoff.md](handoff.md). The final change touches only import
validation and co-located tests. Unchanged failed broad gates were not repeated.

| Package | Committed acceptance evidence                                                                                                                                                                                                                                                             | External limit                                                                                      |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| C1      | Source map checked against B0; ResultsSource consumes the existing DurableResults read port rather than a replacement database.                                                                                                                                                           | Original immutable prompt/tool adapter and existing owner are required.                             |
| C2      | AllBudgetDimensionsAndReservationsAreEnforced; ActualRequestExactLimitsAndSingleUnitOverflow accepts equality and rejects one byte/code point/estimated token less. IngestionLimitsAreIndependentOfOutboundBudget.                                                                        | Model estimator/reservations require qualified capability evidence.                                 |
| C3      | MalformedHistoryFailsBeforeMaterialization covers duplicate/dangling/cross-turn pairs; IncompleteHistoryReturnsExactUnansweredIdentity preserves PENDING identities. LongConversationMaterializesBoundedCompleteRequest keeps instructions, latest user intent and all UNKNOWN exchanges. | Missing originals remain a refusal, never repaired tool output.                                     |
| C4      | RecoveryRejectsTamperedCheckpointRatherThanRepairingIdentity; ImportedCheckpointCannotAddPermissionFields; RecoveryBoundsTypedObservationBeforeCopyOrHash; DenseUnknownHistoryRecoversWithinExactEncodedBudget.                                                                           | Durable CAS, negative operation observation and native crash behavior belong to the existing store. |
| C5      | SummaryRejectsMalformedUTF8; UntrustedSummaryNeverOverridesInstructionsOrUnknowns; InvalidInterruptedAndLateSummaryKeepSafeOriginals.                                                                                                                                                     | Optional summarizer remains uncomposed and needs its own authorized durable usage.                  |
| C6      | UnknownPublicationNeverReplays (including restarted preparation), PublicationAndRecoveryAreObservationOnly, ConcurrentPublicationUsesOneOriginalOperation, SourceAppendRevocationAndMissingOriginalFailClosed and StoreOwnedReceiptCannotChangeDuringCurrentCheck.                        | Same original lease/source-head enforcement must be implemented by owners.                          |
| C7      | Actual ResultsSource/service/gate/materializer composition with a long transcript; UnknownStatusReachesProviderEvenWithSuccessfulProse; actual emitted JSON budget checks.                                                                                                                | INFERENCE shipping client/boot mapping, live provider and Mac/native qualification remain open.     |

Test names omit their `Test` prefix above; tests are co-located in the two owned
Go packages. Huge indivisible UNKNOWN exchanges cannot be dropped to fit current
intent (`RequiredUnknownExchangeCannotBeDroppedToFitLatestIntent`). Optional
history remains a contiguous suffix, with no backfill across a budget gap.
Prepared capacity refuses without evicting a known plan.

## Demonstrated audit defect and correction

The new `ImportedCheckpointRejectsMalformedUTF8WithoutRepair` regression failed
before the fix: a JSON string containing raw byte `0xff` was accepted and silently
repaired by Go's decoder. DecodeCheckpoint now rejects invalid UTF-8 before JSON
decoding, preserving the rule that malformed original bytes are never normalized
into a different accepted checkpoint. Its original failure is retained in the
task-owned evidence. No storage adapter or persistence owner was changed.

After this fix, targeted domain/app race tests, vet, architecture enforcement,
format and diff checks pass. The exact emitted-budget tests pass equality and
all three single-unit overflows without exposing a request. The earlier
8,192-event / 4,095-UNKNOWN recovery case also remains passing. Independent
inspection is bounded development review, not formal Critic R3/R4 acceptance.

The finite independent queue is complete. Remaining work is the four precise
shared-owner seams in [integration.md](integration.md), aggregate CI diagnosis,
formal review and live/Mac qualification. Source/portable/controlled composition
delivery does not close those gates or authorize unresolved-operation replay.
