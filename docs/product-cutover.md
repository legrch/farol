# Closed Farol product cutover

Production is installed as `~/Applications/Farol.app`. Its hidden NEW bundle ID,
owner userData/sessionData, browser partition, Computer authority and settings
remain unchanged. Ordinary `task dev` is a separate Farol Dev environment. Neither
environment copies browser state, credentials or V0 data into the other.

Schema 6 packages use the Farol basename and local lamp resources. The old schema
5 installed updater cannot consume this layout. Do not feed it a renamed archive
or rewrite an immutable GitHub release. This transition is an explicitly selected
local migration; later updates start from the genuine branded install baseline.
It is not evidence of a successful automatic update or full V0 replacement.

## Preconditions and order

1. Accept the complete source change under the applicable risk review. Run its
   required gates and package clean exact committed bytes. Retain exact package,
   archive and source identities. No dirty Dev build is an install candidate.
2. Close every NEW owner process through normal lifecycle. A failed Quit or active
   MCP marker is not idle. For the known connector-only failed shutdown, the
   explicit `task recover:closed-computer -- --apply --operation UUID
--expected-run SHA256 --expected-quit SHA256` preserves the original failure
   before retiring its exact markers. It requires the real promotion/admission/
   lifetime locks, owning journal checks and process absence. `retired_unconfirmed`
   is a maintenance result, never a fabricated successful Quit. A pending task,
   mutation, shell group, unknown process or unsafe file still refuses it.
   Keep every NEW application closed throughout recovery, retirement and
   promotion, until their terminal result and exact readback. This selected
   manual mode does not serialize a concurrent application's startup with final
   marker retirement. The deferred startup-fence risk remains open; neither
   repeated checks nor journal reconciliation make that race safe.
3. Qualify the candidate under unchanged test/owner-guard modes. Save the native
   continuation and exact rollback plan before stopping V0. The owner-selected
   downtime step must stop only identified V0 components and preserve its exact
   bundle and state privately. This code does not stop, modify or archive V0.
4. Ensure `~/Applications/Farol.app` and its new install receipts are absent. Do
   not delete an occupied slot to pass. Preserve that predecessor through the
   separately authorized cutover, with measured identity and restore steps.
5. Run `task retire:preview-install -- --apply --operation HEX32
--expected-preview SHA256 [--closed-recovery UUID]` from the clean qualified
   checkout. When the current Quit was retired by step 2, its exact recovery UUID
   is required. No home, profile, helper, force or source override is supported.
6. After a terminal `retired` result, use normal `task promote -- --apply`. It
   verifies the exact source/package, checks current owning activation obligations,
   holds the real promotion lease, places into an empty slot and writes its genuine
   install receipt. Retirement itself never creates a receipt or accepted baseline.
7. Independently measure installed bytes, config and serving identity. Perform
   allowed production workspace/Computer/shared-Codex and Quit/reopen checks, with
   V0 stopped. Test Dev alongside it. Required live refusals stay non-replayable.
8. Qualify ordinary GitHub N → N+1, Later, Restart & Update, readback and rollback
   from this baseline. A manual migration cannot replace this acceptance.

## What preview retirement preserves

The one-time route requires the old terminal `installed` repair chain, matching
unmodified repair receipt/journal, measured installed and predecessor bundles,
genuine original promotion anchor and original quarantine inode. Pending repair
or update operations refuse it. A remote task/mutation journal requires its owner
to reconcile it; this narrow route does not archive or retry those operations.

It retains the old NEW bundle and its original promotion/repair receipts plus the
global repair journal under `~/Applications/.farol-preview-retirement-HEX32`.
The old inactive `installed-updates` directory moves by inode to
`installed-updates-retired-HEX32` in the same existing NEW profile. Current settings,
browser/session data, original repair predecessor/quarantine and no-replay shell
reservations stay in place. No authentication or profile collection occurs.

An old ready download without its linkage witness is preserved as
`unconfirmed_not_replayed`: the route never reads/extracts/executes its archive,
claims its linkage, installs it or turns the earlier `DOWNLOAD_LINKAGE_UNCONFIRMED`
into PASS. This is retirement of an obsolete inactive consumer, not a retry of the
refused update. Restore/apply/helper intents, unknown top-level update state and
active native processes block retirement.

The descriptor-bound helper holds promotion, Computer admission and MCP lifetime
locks through moves, pins original file/directory identities and fsyncs the plan
before effects. After interruption, continue only the same operation/candidate/
predecessor pair. It measures already moved inodes rather than moving them again.
Keep the exact interruption/result; an unknown outcome never authorizes a new ID.

## Rollback

Before any subsequent branded update changes the active update history, a closed
rollback can restore the exact retired NEW pair with
`task retire:preview-install -- --restore HEX32 --expected-preview SHA256
[--closed-recovery UUID]`. First preserve the branded bundle and its promotion
receipt outside the normal slot through the authorized closed procedure. The
helper requires the new slot/receipts and active update directory to be absent;
it never overwrites a later install or journal. Original old receipts, download
tree and bundle are returned by their recorded inodes, not reconstructed.

V0 restoration is a separate exact plan using its private predecessor and original
unchanged state. Never run the new/old client against the same tunnel at once.
After ordinary branded updates, prefer their own bound predecessor/rollback path;
do not overwrite those journals to use this one-time migration backwards.

Disposable tests cover identities, interruption, refusal, receipt/download custody
and restore. They do not prove native UI, installed operation, provider results,
V0 independence or the GitHub update journey. The owner-selected closed window
retains the deferred stale-build launch guard P1; this procedure is not its PASS.

## Ordinary Dev closed recovery

The same exact-evidence maintenance command accepts `--development` to select
the existing ordinary Farol Dev profile under the genuine owner home. It uses
Task Dev's metadata-only spelling resolver (`Farol Dev` / `Farol DEV`), rejects
distinct or unsafe profiles, and never selects an acceptance profile or production
state. The default remains production. Arbitrary home/profile/helper overrides
are still refused.

For a same-inode case alias, maintenance selects the physical entry spelling
returned by the filesystem. That path must still be exactly one of the two fixed
Dev entries under the genuine owner app-data parent. The recovery core's strict
canonical-path, owner and private-mode checks remain unchanged; no directory is
renamed or merged.
The process-absence check includes both fixed Dev spellings, because an older
child may have recorded the other alias in its command. An unconfirmed check
refuses immediately; the other spelling is not a fallback.

Close both NEW applications normally and resolve a legacy configuration filename
in place before recovery. Supply the exact Dev running/failed-Quit hashes and one
operation UUID. Package/source admission, owning desktop obligations, process
absence, promotion/admission/MCP locks, no-replay journals and retained historical
failure remain the same as production recovery. `retired_unconfirmed` is not a
clean Quit, and the command neither launches Dev nor installs or updates anything.
