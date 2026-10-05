# Approved Computer workspace context

The model-visible Computer MCP includes `computer_workspace_catalogue`,
`computer_workspace_bootstrap`,
`computer_guidance_search` and `computer_guidance_fetch`. These read-only routes
do not enable Model or Product Agent and do not depend on a browser login.

Call `computer_workspace_catalogue` without arguments before selecting a folder.
It returns exact workspace IDs and task scope roots from the selected participant's
materialized grant, including delegated narrowing. Owner-approved folders outside
that task are not candidates. Every candidate passes the existing authority-bound
native context operation, then all contexts are checked again before disclosure.
A refusal, expiry, revocation or changed root discards the entire collected catalogue.
The catalogue never reads file contents, lists filenames in its response, grants
permissions or invents aliases. Exact-file-only scopes cannot browse a directory and
are omitted. This is a bounded twice-checked observation of at most 32 roots, not an
atomic filesystem snapshot. A previously attached client may need its normal tool
metadata refresh to discover this additive tool.

Bootstrap accepts a selected `workspaceId` and canonical `relativeDirectory`
(`.` for the task scope root). It verifies that directory through the existing
native descriptor-bound list operation, then reads `AGENTS.md` at the task root
and each directory on the path. The result distinguishes the task's `root` from
the broader `approvedRoot` path/device/inode identity. A selected linked worktree
uses its own physical root and files; bootstrap never substitutes a primary
checkout. Ancestors outside the task scope and unrelated descendant directories
are not inspected. Exact-file-only grants cannot bootstrap a directory.

Instruction entries are `read`, `not_found` or `unavailable` with a classified
code. Exclusions, unsafe symlinks, non-text/oversized files and the aggregate
64 KiB response budget never become an absence claim or truncated instruction.
`complete` is false for any unavailable entry. The directory chain is limited to
32 nested components. Apply root rules first, followed by more specific rules;
instruction text cannot expand the Computer grant.

Each native operation rechecks authority and approval after reading, before
disclosing output. Bootstrap reads the chain twice and refuses a changed result,
then rechecks the selected directory/root context. Revocation, expired approval,
root rebinding, cancellation and contract-correlation failures discard collected
text. This is a twice-read bounded observation, not an atomic filesystem snapshot
or a promise that a file cannot change after return. Bootstrap runs under the
same lifecycle/admission fence as other Computer tools.

Guidance is a product-owned JSON manifest embedded in the attested Computer MCP
build (`src/modules/computer/infra/mcp/computer-guidance.json`). Search ranks
published title/summary/keyword matches and reports `resultLimited`. Fetch
accepts a published ID; it never reads a supplied file path. Every reference must
name another manifest entry. Invalid, duplicate or dangling entries make the
catalogue explicitly unavailable. Workspace instructions and private owner
knowledge are excluded from this product guidance bundle.

Filename/include discovery uses ordinary approved shell where recursive results
are needed, for example `rg --files --glob '*.ts' --glob '!_output/**'`. Report
its actual exit and ignore/include coverage. Directory list is bounded and
nonrecursive; text search exposes its separate scan/result limits. These routes
do not pretend to provide a complete physical filename inventory. Standard Git
continues through the same approved sandboxed shell, with explicit linked-worktree
metadata and permitted ordinary global configuration.

Qualification remains layered: public in-memory MCP calls with the real safe-open
helper prove local instruction/authority behavior; the packaged stdio fixture
proves the sealed new Computer entry and embedded guidance. Neither establishes
that an already-attached ChatGPT connector has refreshed its schema or that the
owner's live workspace/task/account was exercised. Old receipts remain bound to
their original artifacts.

## TaskGrant renewal and execution leases

Production desktop launch contracts seal an `owner-settings/v1` approval source.
The Computer MCP reads the existing private `config.json` from that exact source
for new admission, using the same approval producer as desktop launch. Persistent
owner folder/capability consent is not a temporary TaskGrant. A new tool request,
including a later ChatGPT turn or connector reconnect, derives a bounded grant
against current owner policy through the existing `deriveTaskGrant` rules. An
expired startup template is a scope ceiling, not evidence of current consent.
Legacy fixture contracts without this source retain their original expiry.

Renewal preserves the startup task identity, generation, roles, exclusions, roots,
capabilities and physical root identities. Changed Computer/connector generations,
revocation, replaced roots, changed policy or an unavailable/untrusted settings
source refuse admission. A desktop atomic settings save that replaces the opened
inode discards that snapshot and reads current policy again, at most three times.
Trust checks run for every snapshot; sustained instability still refuses, and no
operation is dispatched again. Additional owner permissions do not widen an existing
runtime ceiling. A genuinely temporary approval's own expiry still limits and
can refuse reissue. Separately sealed Codex/Claude task admissions are not renewed.

Each admitted Computer execution receives a fixed lease in its own async context:
15 seconds for native file operations, 120 seconds for composite Git verification
(the native sub-step budgets plus preparation/cleanup), and at most 10 minutes for
shell authority. The shell command's own timeout and any explicit caller deadline
also bind.
Outer grant renewal cannot extend or replace this snapshot. Reads recheck current
owner policy before disclosure; mutation handoff rechecks it after durable admission.
Running shell watchdogs retain their original deadlines, check current policy and
stop on revocation. Cancel and confirmed cleanup remain available after revocation.

Reissue never redispatches an effect. Mutation records, shell intent tombstones,
operation IDs, lifecycle digests and cleanup fences remain intact across renewal
and reconnect. Unknown outcomes remain unknown; a fresh grant is no proof that an
old mutation or process did not execute. If current policy cannot be read after
durable mutation admission, the terminal refusal uses the existing
`AUTHORITY_COMPUTER_MISMATCH` / `computer-policy` journal vocabulary. The store
schema remains byte-identical to base `1eb30bd`, preserving predecessor update
drain and restart reads; pre-admission store errors remain separately classified.

Clock-controlled regressions use disposable owner settings and real in-memory MCP
framing; workspace ports in those tests are fixtures. The native shell regressions
use disposable process groups. After `task ci:fast`, run
`node tests/e2e/computer-task-grant-renewal.e2e.mjs` against built bytes for the
expired-launch, native-read, same-connection, reconnect and generation-revocation
witness. That runner changes no host clock, owner approval or installed runtime.
These checks do not establish live ChatGPT acceptance. Live qualification must
record the candidate identity and Brain/code successes in the same ChatGPT chat
before and after normal turn renewal and reconnect; installation/restart remains
Lead-owned and requires supported reconciliation of existing unknown updater work.

## Agent directories

See [Agent store workspace access](agent-store-access.md) for the ordinary
read/write and shell grant policy for `.codex` and `.claude`.
