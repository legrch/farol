# Workflow integration handoff

Base: `99aca15ffe16b435e59b19c20ff48e06bd56960d`, tree
`92047a064fede82658c37cf0f0a76004f6ce291c`. Branch:
`feature/agent-workflows`. Only `modules/task/domain/workflow`,
`modules/task/app/services/workflow` and `docs/agent-workflows` change.

## Exact owner wiring requests

1. **Boot / immutable plan activation:** retain one validated content-free plan
   and its exact parent/task/operation references through the existing approved
   state/configuration owner. Reconstruct the same plan after restart and start
   with `Reconnect`; activate eligible new steps explicitly. Do not infer a
   dispatch is absent from a summary, missing child, or changed plan. There is no
   new workflow journal implementation or schema change in this branch.
   The consumer's bounded `Capture` isolates one call before external ports;
   synchronize caller input during that capture. It does not persist or approve
   a new plan and cannot recover the owner's original plan by itself.
2. **Boot / Task DTO adapter:** map the workflow `Tasks` consumer to the SAME
   selected `task.Service.NewOwned`, `control.New`, and selected `Owner/Route`
   already used by admission and observation. One existing Task owner per
   TaskID/profile lifetime must remain exclusive. `Read` calls `Operation`, maps
   only classified `TASK_NOT_FOUND` to known absence, and preserves uncertainty,
   exact operation/task/action/reference and retained original-dispatch result.
   `Observe` delegates to `Result`; `Create`, `Cancel`, `ContinueExact` and
   `ResumeExact` retain the published control semantics. Keep original read
   routes for old admission epochs and newer selected routes for follow-up
   mutations/reads, all from the SAME Task owner. `Follow` refuses an already
   recorded request instead of validating new message content against a receipt;
   `ReadFollowup` is the content-free reconnect path. Never instantiate a
   second provider loop or reinterpret the selected model from a catalogue.
3. **Exact control and parent delivery seam:** the current control facade publishes no `Deliver`.
   `workflow.Tasks.Cancel` and `Deliver` require `Target.ExpectedDispatchID` and
   `Target.Reference` checked atomically inside Task's existing mutation owner.
   Add narrow owner `CancelExact`/`DeliverExact` entrypoints with those fields,
   checked in the same snapshot/CAS that records the intent; reject a changed
   dispatch before provider or parent IO. Preserve the guard in the durable
   intention fingerprint and all replay comparisons, as `ContinueExact` does.
   Current `Cancel`/`Deliver` cannot implement that atomic guarantee. The
   composition witness uses an exclusive controlled adapter that compares the
   same journal snapshot before existing service delegation; this is not
   production concurrency qualification. A private root adapter or published
   facade needs the owner's exact methods before activation. Add loss-of-ACK,
   stale-dispatch and concurrent-followup tests without resending unknown work. No
   delivery operation ID is derived from `Status.DeliveryDispatchID`; only the
   original explicit delivery operation receipt proves acknowledgement.
4. **Runtime admission / global capacity:** supply `Admission.Do` with the
   existing trusted parent recheck and serialized resource reservation at the
   actual launch boundary. It must invoke the callback at most once, enforce
   capacity across simultaneous callers/workflows, reject paused/closed parents,
   and retain unknown occupancy until supported original-operation
   reconciliation. A pure scheduling budget is not a grant. Controlled admission
   fixtures do not qualify production arbitration. Fresh selected follow-up
   routes remain the admission owner's responsibility.
5. **Future Activity/Chat:** consume `Report` as a content-free projection.
   Completion, output acceptance, cancellation requested and parent delivery
   states remain separate. This branch edits no renderer, shared schema,
   generated binding or shipping capability advertisement.

There is no dependency on a new MODELS or CONTEXT seam. The composer selects
existing Task selection values; Task resolves its approved binding. Any future
catalogue/context integration must leave already recorded Task identity and
unknown-operation fences unchanged.

## Evidence and remaining gates

Targeted domain/application race tests and actual Task composition are the
portable gate. Provider/authority/admission fixtures are synthetic. Linux
filesystem tests do not qualify Mac process ownership or installed Farol.
Shipping adapter/plan activation, global admission arbitration, independent
formal review, combined cross-lane checks, native Mac and one-shot live-provider
acceptance remain separate. This branch does not merge main, tag or release.

The offline example and exact test receipt are included with the source slice.
The final handoff/export manifest records exact commit and tree identifiers,
original failures and push/PR results.
