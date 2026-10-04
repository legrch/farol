# Local unaccepted checkpoints

Coherent checkpoint commits use complete self-review, relevant targeted tests,
type/import checks and a diff check. Full `task ci:fast` is not a per-commit gate.
The complete stable integrated range still needs its required aggregate CI and
risk-proportional independent review before it becomes an accepted baseline.

Keep original current-task terminal receipts, actual argv/cwd, terminal exit/signal,
logs/reports, tested source, runtime/dependency evidence and verification limits.
Audit coverage for the exact staged subset before each commit. Do not fabricate
outcomes, defer known failures, or present unrelated green tests as slice evidence.
Reuse unchanged evidence only where its exact source and dependencies remain
applicable. Ordinary deterministic checks do not require a model reviewer.

## Optional receipt consistency checker

`task checkpoint` is an additional consistency check. Its source-review acceptance
is tracked separately from this targeted-checkpoint policy. It does not turn a
checkpoint into a ready slice, accepted product, package, install or live proof.
It does not adopt the separate suite registry/runner migration.

To use it, stage the coherent owned subset, inspect the diff, and capture
`task checkpoint -- --snapshot` outside the repository. Keep the writer frozen
while collecting relevant existing tests and type/import checks. Compare the
snapshot after the checks. The implementing Lead must audit original terminal,
source, dependency and staged-coverage evidence before declaring the result.
Missing, conflicting or unknown provenance refuses this evidence route; a
caller-written PASS or nonempty hashed log is not sufficient.

Write a version-1 JSON receipt outside the repository with:

- `intent: "local-unaccepted-checkpoint"`, `source`: the exact snapshot object,
  `paths`: the original nonempty tested owned scope (within snapshot `changed`),
  `selfReview`: substantive diff review. Preserve this source and the original checks.
- `mapping: {current, paths, rationale}`: a fresh current snapshot, exactly its
  nonempty staged subset of the original tested paths, and the explicit coherence/
  dependency argument. This is a new mapping alongside unchanged receipts, not a
  rewrite of their historical HEAD/index or terminal outcome.
- `checks`: nonempty records with unique `id`, `kind` (`test`, `type`, `import`),
  actual nonempty `argv`, `cwd`, `rationale` explaining dependency/coverage mapping,
  nonempty `covers` containing original tested paths, `terminal: true`, `exitCode: 0`,
  `signal: null`, and `log: {path, sha256}` for a retained nonempty terminal log.
  The union of covers must include every current staged path, and all three kinds are required.
- Test records additionally require `format` (`vitest-json` or `go-json`),
  `report: {path, sha256}`, and nonempty unique `inputs`: exact report test filenames
  for Vitest or package import paths for Go. Reports must contain passing tests for
  every requested input and no failed, skipped, todo, missing or extra results.

After that audit, add `provenanceReview` with `role: "implementing-lead"`, actual
`lead` and current `task` identifiers, `decision: "audited-original-current-task-receipts"`,
nonempty `dependencyEvidence` identifying the inspected evidence, and `receipts`:
exactly one `{checkId, toolReceipt}` reference to the original current-task terminal
receipt per check. Set `evidenceSHA256` to `provenanceDigest(evidence)` exported by
`tooling/checkpoint.mjs`; it binds source, paths, current mapping, checks and self-review.
The digest only binds the declaration; computing it does not perform the audit.
Missing declarations or inconsistent bindings refuse. Every new checkpoint mapping
requires a renewed Lead audit/declaration, while original checks/outcomes stay intact.

Run `task checkpoint -- --evidence /absolute/receipt.json`. Success is only
`LOCAL_CHECKPOINT_ONLY`, never acceptance. The checker executes Git reads/diff
checks, not submitted commands; it does not stage, commit or publish. Revalidate
immediately before committing without further index/source changes. Retain the
receipt, source snapshot and resulting commit identity for the Lead's range review.
HEAD/index movement from earlier coherent checkpoints does not require rerunning
checks when the entire working source digest, writer/root and Node remain identical.
Reuse also requires the implementing Lead's pre-commit audit of unchanged
runtime/dependency/build inputs from the retained check provenance. Source equivalence alone cannot establish that fact;
missing dependency provenance refuses reuse before the checkpoint. The checker
binds dependency declarations, not the installed dependency trees or host tools.
The checker requires an exact current mapping and forward ancestry from tested HEAD;
only the staged owned subset may be committed. Any source or executable-mode change
invalidates equivalence. No empty docs-only exception exists.

The snapshot binds HEAD, named writer, full index, executable modes and all regular
workspace source, including ignored source outside the explicit root exclusions
`.git`, `node_modules`, `_output`, `dist`, `coverage`, `artifacts`. It rejects index
flags/conflicts, tracked excluded paths and symlinks; rename sides are both in scope.
Deleted source is bound by the index and missing workspace entry. Excluded directories
must be real directories. These exclusions are not dependency/generated-output
attestation. Existing compiler/dependency integrity and clean build/package gates
remain binding, including build-attested Markdown and resources.

This is an operator-evidence consistency check, not an authenticated receipt producer
or process sandbox. It cannot prove that imported terminal metadata is truthful or
that selected tests are sufficient. The implementing Lead must verify provenance and
coverage BEFORE each checkpoint; later independent range review is additional and
cannot substitute for that pre-commit audit. The declaration remains operator
consistency evidence, not authenticated security proof. It cannot convert a refused, unfinished or unknown
child into a terminal PASS. Type/import commands that are normally silent still need
a retained terminal transcript containing the command and observed exit, not an empty
stdout file. Do not fabricate logs or normalize failures into success.

Before accepted-main advancement: freeze the final committed integrated range, run
complete `task ci:fast` (including Core/Hunt/type/import/race/discovery/security),
applicable cross-module/native gates and independent risk-proportional review under
the selected shared Critic policy. `task package` remains the sole candidate producer
from clean committed bytes with compiler/dependency/source/resource/package
attestation. Applicable release/install/update/recovery/live obligations remain.
Neither a checkpoint nor a source-only test substitutes for these gates.

Dependencies: this checker uses Node built-ins and system Git only. Its focused tests
use the existing Vitest dependency; no package/lock, hooks, aggregate, package command,
shared Critic configuration or test-discovery migration is required by this patch.

## Handoff and acceptance

Preserve each coherent checkpoint and its exact applicable checks and limits.
Uncommitted source seals remain historical evidence; source commits extend them
without inventing completed CI or review. Keep the current full-range review status
explicit. A source handoff may remain unaccepted while the next integrator completes
its aggregate and independent acceptance gates.

The earlier clean-Hunt/pre-commit-CI ordering cycle no longer blocks checkpoint
commits. Required aggregate, compiler/dependency/source/resource/package attestation,
native, release/update/recovery and live gates remain separate obligations. Build
candidates only through `task package` from clean committed bytes.
