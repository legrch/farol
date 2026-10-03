# Historical preview cutover and closed maintenance

**Scope:** controlled migration from schema 5 `Farol Next Preview.app` to schema 6
`Farol.app`, plus exact-evidence closed Computer reconciliation. This is a maintenance
reference, not the ordinary [installation/update guide](installation.md).

The current fixed install slot is `$HOME/Applications/Farol.app`. Hidden bundle,
profile, partitions, Computer authority, and settings retain compatibility identities.
Farol Dev stays separate. No operation copies credentials, browser state, or another
product's data between them.

## Why a separate migration exists

The old schema 5 updater cannot consume the branded schema 6 layout. Renaming an
archive, rewriting an immutable release, or editing a receipt cannot create a valid
new baseline. The retained closed-repair apply tool owns schema 5 only.

This migration retires the exact old installation/receipts while preserving custody,
then normal non-overwriting promotion establishes the new slot and genuine receipt.
It does not qualify an automatic GitHub upgrade or complete replacement of an older
product.

## Required maintenance window

Keep every app using the product profile closed from confirmed Quit through terminal
maintenance result and readback. Pending work, unknown mutation/shell/helper state,
unsafe files, held leases, or unobservable processes refuse the operation.

The tools reconcile existing obligations and hold promotion/Computer/MCP leases, but
**do not fence a concurrent startup by an older bundle**. This remains an unqualified
race. Repeated marker checks are not that fence. An exclusive closed window is part
of the selected procedure, not proof that concurrent launch is safe.

## Cutover order

1. Verify and review exact clean committed source, package, archive, and rollback plan.
   Preserve the predecessor's measured bundle and state before selecting downtime.
2. Quit all processes using the product profile normally. If an eligible connector-only
   failed shutdown needs closed reconciliation, use the exact operation described
   below and retain its original failure.
3. Verify the old promotion/repair chain, both physical bundles, receipts/journals,
   and original quarantine identity. Pending task/update obligations must be resolved
   by their owning routes, not this migration.
4. Ensure the new `Farol.app` slot and new receipt are absent. An occupied slot must
   be separately preserved/reconciled; it is never removed just to pass admission.
5. Apply `task retire:preview-install` with its exact operation ID, expected old
   package SHA-256, and matching closed-recovery ID when required.
6. After terminal `retired` readback, use [normal promotion](installation.md#establish-an-updater-managed-installation)
   to install the new candidate into its empty slot and create genuine evidence.
7. Independently verify installed bytes, configuration, serving identity, normal
   Quit/reopen, and allowed Computer/task flows. Verify Dev coexistence separately.
8. Qualify ordinary GitHub upgrade, Later, Restart & Update, readback, reconnect,
   and rollback from that baseline. Manual migration cannot substitute for them.

Another legacy product's shutdown/preservation/restoration is a separate selected
operation. These tools do not stop, mutate, or archive that product.

## Retirement contract

The command fields are `--apply`, `--operation` (32 lowercase hex), and
`--expected-preview` (measured 64-hex digest), with optional `--closed-recovery`
(exact prior UUID). There is no home/profile/helper/force/source override.

The descriptor-bound helper holds leases, pins directory/inode identities, and syncs
its plan before effects. It retains the old bundle, original promotion/repair receipts,
and repair journal in the operation-owned retirement directory beneath Applications.
The old inactive update tree moves by inode into a retained directory in the same
profile. Current configuration/browser state and original repair predecessor remain.

An old download without its linkage witness is retained as `unconfirmed_not_replayed`.
Retirement does not read/extract/execute its archive, claim linkage, or turn an old
unknown download into PASS. Active/unknown update or native work blocks retirement.

After interruption, continue only the same operation/candidate/predecessor pair.
Readback measures already-moved identities; it does not repeat moves under a new ID.
Unknown is a retained obligation.

## Restore

Before a later branded update changes active history, closed restore can return the
exact retired pair using `task retire:preview-install` with `--restore` (the same
32-hex operation) and `--expected-preview`, plus matching closed-recovery when needed.
First preserve the new bundle/receipt through the authorized closed procedure.
Restore requires the normal slot/new receipt and active update directory absent;
it never overwrites a later install or journal. Original objects return by recorded
identity, not reconstructed evidence.

After normal branded updates, use their own bound predecessor/recovery path. Restoring
an unrelated legacy product remains a separate exact plan.

## Closed Computer reconciliation

`task recover:closed-computer` requires explicit `--apply`, one UUID operation,
`--expected-run` and `--expected-quit` measured SHA-256 values. It checks source/package
admission, actual process absence, current Desktop obligations, promotion/admission/
MCP leases, and no-replay journals. It preserves the original failed shutdown before
retiring eligible exact markers.

`retired_unconfirmed` is a maintenance result, **not a successful historical Quit**.
Unresolved task/mutation/shell work, unsafe paths, or unknown processes refuse it.
The application must stay closed through terminal result/readback.

`--development` selects only ordinary Farol Dev under the OS-account home, using the
metadata-only `Farol Dev` / `Farol DEV` resolver. It cannot select an acceptance
profile or production state. Same-inode spelling uses its physical entry without
copy/rename; distinct profiles refuse. Process-absence checks include both fixed
spellings. Existing config-filename obligations must be reconciled while closed.

For a legacy failed Quit without current MCP-stop admission, the operation can retain
its failure and establish a new maintenance stop intent through normal lifecycle.
That is not a retroactive historical acknowledgment or a clean Quit receipt.

## Source and evidence

[Preview retirement](../tooling/retire-preview-install.mjs),
[closed Computer recovery](../tooling/recover-closed-computer.mjs), and
[historical repair](../tooling/closed-preview-repair.mjs) have disposable identity,
interruption, refusal, custody, and restore fixtures. They do not prove installed UI,
live provider behavior, independent legacy operation, or the GitHub update journey.

---

[Documentation index](README.md) · [Project overview](../README.md)
