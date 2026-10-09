# Farol Cloud continuation inputs

This archival branch carries verified development inputs for the existing Cloud continuation. It is not the product default branch, an accepted macOS release, or a replacement for the Cloud task's current source checkout.

The original 140 branch refs and detached tips are preserved in `history/refs-and-detached.bundle`. Nine historical tip closures are in `history/exact-nine-reachable.pack`. The original snapshot main is `50a14df8`; the 72-commit `history/main-50a14df8-to-3034ed39.bundle` advances an imported history repository to exact H `3034ed3911173a19cf56f4d28d780f42e2c5fcf2` without rewriting identities.

`workfiles/` preserves selected historical working source and fresh source snapshots from the currently registered worktrees, including staged/unstaged patches. These are inputs for analysis, not accepted fixes. Reports retain original failure and preservation limits. Home/temp paths in exported metadata are replaced; source and patch payload bytes are unchanged. Excluded screenshots/logs/native raw records remain on the Mac and are listed by path and hash.

`schemas/codex-0.160.1/` contains all 440 actual offline schemas from the installed CLI executable. The current production inspectors accepted base, handoff, project-task and follow-up schemas. This does not qualify the selected serving instance, account/model entitlement, native Task runtime, published product tools, or live effects.

Read `CONTINUATION.md`, `INPUTS-STATUS.json`, `manifest.json` and `reports/scan-coverage.json` before importing. Verify every payload size/SHA-256 and restore in a new history repository. Preserve the current Cloud source checkout and all its commits. Do not merge or delete historical branches automatically.
