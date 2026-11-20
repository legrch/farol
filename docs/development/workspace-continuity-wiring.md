# Workspace continuity: production wiring plan

Status: working plan for `feat/workspace-continuity-heal` (stacked on
`fix/workspace-root-drift-heal`, legrch/farol#176). It wires the accepted
designs; it does not change them:

- [Workspace continuity decision](workspace-continuity-decision.md) (scope and
  trust: current internal startup Data filesystem, enrolled evidence only).
- [Workspace transition decision](workspace-transition-decision.md) (Go-owned
  write-ahead journal, cross-owner protocol, terminal certificate).

## Why

A Mac reboot can renumber the startup Data volume (observed 2026-11-20:
16777231 → 16777233). The saved `(device, inode)` binding then refuses every
call. Stage 1 (#176) makes that state honest and stops the connector from
resuming; the owner still has to remove and re-add the folder. This plan makes
an enrolled folder survive the reboot without any owner action, and gives a
one-time explicit enrollment for folders saved before continuity existed.

## What already exists (unwired)

| Piece                                                                                                                              | Where                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Read-only observation (volume UUID, file ID, birth time)                                                                           | `modules/computer/infra/observation`                                                                  |
| Trusted startup-Data anchor (C1)                                                                                                   | `modules/computer/infra/lease`                                                                        |
| Boot UUID reader                                                                                                                   | `modules/computer/infra/boot`                                                                         |
| Held candidate chain (C3)                                                                                                          | `observation.Holder`                                                                                  |
| Transition WAL, stage, certify, current qualification                                                                              | `modules/computer/infra/repos/access`                                                                 |
| Transition owner (Begin, Confirm, WithdrawOnce, Record, Finish)                                                                    | `modules/computer/app/services/migration/owner.go`                                                    |
| Boot-only withdraw effect                                                                                                          | `boot/computercontinuitywithdraw.go`                                                                  |
| Diagnostic status RPC (`computer.continuity.status`)                                                                               | `boot/computercontinuitystatus.go`                                                                    |
| Stop prerequisite with child kinds `computer.confirm-workspace` (legacy-confirm) and `computer.rebind-workspace` (enrolled-rebind) | `modules/computer/domain/journal/prerequisite.go`                                                     |
| Settings continuity reader and writer                                                                                              | `src/pkg/product-settings/workspace-continuity.ts`, `src/apps/desktop/workspace-continuity-writer.ts` |
| Desktop sequence driver                                                                                                            | `src/apps/desktop/workspace-continuity-sequence.ts`                                                   |

## Slices

Each slice: targeted tests that fail on the old code, `task test:core`,
checkpoint commit. Formal Critic (Eco preset, Codex reserve) only at the PR
candidate, R4.

1. **Go composition and RPC.** Build `migration.Owner` in `boot` with the real
   boot reader, anchor acquirer, holder, gate, digester and an
   `OriginalParent` that resolves the completed stop prerequisite whose child
   ID and mode match. Register owner-only desktop methods for begin, confirm,
   refuse-before-withdraw, plan, record, withdraw, stage, finish and qualify;
   add their schema to `api/desktop/v1/schema.json` and regenerate.
2. **Desktop ports.** Implement `ContinuitySequencePorts` in the host: the stop
   and stopped-record come from the existing workspace configuration drain with
   the confirm/rebind command kinds; Settings goes through
   `nextContinuitySettings`; every Go call maps to the RPCs of slice 1. No
   renderer supplies a receipt, picker result or predicate.
3. **Legacy enrollment (explicit).** A "Turn on automatic recovery" action for
   a bound folder without continuity, while the connector runs. The original
   Stop and legacy-confirm sequence require the native picker to return the
   same fixed root. Run Verify after current qualification.
4. **Launch self-heal (automatic).** Keep qualified, enrolled device-renumbering
   candidates out of the stage-1 withdrawal. Let the regular connector resume
   complete first because the original Stop requires a running connector. Run
   enrolled-rebind sequentially, Verify each qualified folder, and restore the
   connector once after the drain when needed. On failure, withdraw stale
   checks when the protected owners permit a Settings write. For restricted
   outcomes, withhold the checks in the UI and retain the original custody.
5. **Qualification.** The decision's oracle list as tests (replacement, clone
   with different filesystem instance, symlink/ancestor race, unknown at every
   boundary, Quit, restart); a native Dev run; a real reboot on an installed
   build. Production activation requires a qualified current Settings reader
   and qualification of retained continuity before the initial Go authority
   publication. The desktop must keep continuity writes closed until both are
   available.

## Out of scope

External disks, disk images and network volumes stay device-pinned and manual.
No inode-only or path-only fallback, no rebind from a plain Verify.
