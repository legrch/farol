# Owner-preview integration sequence

Date: 2026-09-28. Status: reviewed implementation plan, not a gate waiver or release authority.
This plan reconciles existing candidates. It creates no second Lead, executor,
permission system, task registry, model catalogue authority or global recipient.
The owner knowledge vault holds operational status; Git commits hold the code.

## 1. Exact inputs and evidence boundaries

- Accepted canonical and actual private remote main: `3de61e796f5033bb5ffb36a5d60a97ff248c22e4`.
- Existing Lead writer: `codex/task-needs-input`, `d03d272cb15389ba5478c57fbdee98d0f7da993b`.
  Four unintegrated commits retain consent isolation, proxy cleanup refusal,
  read-admission lifetime and watchdog cleanup refusal. They require the existing
  mandatory gate; this document does not authorize repeating its denied execution.
- Config/model discovery: `codex/coordinator-model-discovery`, `742487499577cf522cdc9279b7bceab51f8bf2da`, based on canonical main.
  This is the independently reviewed snapshot, not an accepted package. Final
  readback found its clean successor `4f44f05c52efb09b95fcfed11795cb20658642c0`.
  That three-file delta uses the current Settings snapshot for display and checks
  legacy config presence without opening a possible FIFO. Its source diff was
  read; the independent review remains pinned to 7424874. It does not resolve the
  read-context/capability and Lead-safety integration requirements below.
- Owner-message prototype: `codex/owner-session-message-prototype`, `f6efaba3bed7da6d26a6c1b7234872398e5f02e4`, same base.
- Prototype correction: `1e7757e4a1e3d790df5fd67d09de8a7fda58e1fb`, based on the preceding prototype.
  It closes unsafe deadline values and ambiguous concurrent claim failures.
- Verification execution RFC: `codex/coordinator-execution-lanes-proposal`, `ce91353d5d1c7f114ca9f276cdd44cdfa86d2f08`.
  Documentation only, not an implemented or automatically accepted runner.
- `feat/loopback-ci-gate` currently points to the same `3de61e7` as main.
  There is no separate unmerged fix at that ref. Do not start a duplicate lane
  project based merely on its name or interfere with the unrelated Taplex task.

No source candidate above changes the fact that real NEW connector identity,
owner Computer trial, native shared task control and detached cleanup remain
unqualified. Package, fixture, source and installed evidence remain separate.

## 2. Decisions that fit the product

### Configuration and model discovery: retain, then integrate on the corrected base

Keep one `config.json` in the existing isolated state root. Keep
`tasks.defaultHarness`, `tasks.harnesses.<harness>.defaultModel` and
`models.<alias>.model/defaultEffort`. Do not add role profiles, a models.json file,
a second settings store or a service that automatically upgrades aliases.

The configured strings are user intent. `model/list` describes the selected
serving runtime's advertised catalogue, not entitlement, billing or a completed
inference. Exact-match Model.model, preserve missing/unknown distinction, use the
same connection and read all bounded pages. UI cache is at most 60 seconds;
create/continue must not admit from it. Existing operations retain original
model/effort bindings; read-only replay must not require current availability.
A new missing effort can resolve the advertised default once and pin it.

Config rename is explicit and non-destructive. An old filename produces actionable
CONFIG_RENAME_REQUIRED, not an empty install, dual-source merge or overwritten
settings. The first owner trial can still use the accepted older candidate and
its old filename. Do not rename live state while that candidate is running or
mix its rollback instructions with the new candidate. Internal class renaming is
not a prerequisite; user-facing names and the actual file must agree.

Independent review of the candidate found integration requirements, not a reason
to start over. The consent and cleanup findings already have fixes in the Lead's
saved branch; carry them forward once its integration is allowed. The new catalogue
read itself needs the Lead's cancellation/deadline/read-admission propagation.
Model.list protocol shape also needs the existing host-contract capability check.
A missing model capability disables dependent task operations, not Computer.

Seven overlapping paths require semantic integration, not an automatic overwrite:

- `docs/persistent-chat-handoff-parity.md`
- `src/modules/chat/app/service/persistent-codex-handoff.ts`
- `src/modules/chat/contract/codex-task-route.ts`
- `src/modules/chat/infra/native/admitted-codex-task-route.ts`
- `src/modules/chat/infra/native/shared-codex-proxy-host.ts`
- `src/modules/computer/infra/mcp/create-readonly-computer-mcp.ts`
- `tests/integration/task-model-binding.test.ts`

The Lead should own these intersections. A helper can work on pure reader/schema
fixtures but must not edit all seven concurrently with the Lead. Verify the final
combined behavior: a catalogue await cannot extend authority, a cancelled read
cannot disclose metadata, unowned consent gets no reply, and failed cleanup cannot
be converted into success by model-refresh completion.

### Conversation-selected messages: retain the model, stage the integration

The current conversation chooses the recipient and exact action. No repository,
profile or role record identifies a globally preferred Lead. Reuse existing
scoped discovery/observation to mint an opaque, short-lived selection bound to the
caller, exact thread, saved project, physical cwd/common Git and serving generation.
Do not pass caller assertions off as authority. Do not reclassify an adopted
read-only task as Farol-created merely to reuse its message method.

Keep two actions: exact-turn steer and native queue. No automatic choice inside
Farol, hidden steer-to-continue, polling scheduler or second App Server. Start with
steer once the actual serving contract supports it; retain queue code and tests
but expose it only after the corresponding native capability is qualified.
Queue add/list must land together for useful diagnostics. Exact pending-item
cancel is the next bounded follow-up, not cancellation of an inferred running turn.

Queue semantics are intentionally different from a Farol-created continuation.
A queued native instruction executes under the native task's then-applicable
model/effort/permissions. Do not apply Farol defaults to an owner-created thread.
Do not promise the next turn, frozen future cwd or atomic predecessor binding.
An idle thread may execute before the enqueue acknowledgement; an unloaded one
may retain its pending item without being resumed. Grant expiry after acceptance
is not a queue-delete request. An approval is never answered by sending a message.

The prototype needs production access, durable operation journal, composition and
native qualification. Adapt the existing private journal's publication primitives;
use a new per-operation namespace, not another journal framework or the old
one-message-per-dispatch slot. Persist no plaintext prompts. Retain one logical
key, exact-target digest and immutable outcome. A journal exception may hide a
concurrent successful claimant: unknown is not not-submitted. The correction
commit demonstrates this with two controlled concurrent callers, without timing
sleeps or actual provider work. Do not permanently block unrelated new instructions
at this layer; existing wider execution fences still apply.

### Execution-lane RFC: accept a small clarity increment, not the whole mechanism

Useful now: a repository-local requirements inventory for known checks, preflight
explanations, and an honest distinction among source, native fixture, package and
owner/live evidence. Reuse `Taskfile.yml`, existing evidence-attempt/cases and the
current Computer shell. Do not infer permissions from a command string or add a
per-command allowlist. Unknown requirements cannot authorize a probe that was denied.

Do not reimplement the Lead's completed source corrections for unowned consent,
read lifetime, one-shot proxy cleanup or watchdog error retention. They are inputs.
Do not interpret a scoped success as the full required gate.

Next, separately: read-only lookup of an existing shell operation and a durable
terminal/cleanup receipt published by its actual owner. No new start, queue,
supervisor or log-retention system is needed. Preserve the difference between
same-process reconnect, restart after completion, and restart while work is running.
A report writable by workspace code cannot authorize replay or release a barrier.

Owner-guard completeness is a distinct safety improvement, not a cure for the
recorded refusal. Unreadable protected observations are not proof of no change.
Quiet windows and Next-only locks cannot attribute external V0 writes. Do not
remove watched paths, substitute HOME, stop V0, raise grants or retry the original
CI operation under a new name or actor. A scoped native approval offered by the
actual denying host remains the only possible remedy for that operation.

## 3. Python independence is a release-closure problem, not a product rewrite

The checked standalone tree has four tracked Python files:

1. `resources/native/safe_open.py`: packaged as `computer-safe-open.py`. Runtime
   filesystem read/list/search/window/write/edit and workspace-snapshot behavior.
   The manifest pins 133097 bytes and SHA-256; `native-readonly-workspace.ts`
   attests Apple's developer Python via xcrun and executes isolated source with
   the JSON request on fd 3. This is a real runtime dependency, not only tooling.
2. `tooling/promotion-apply.py`: invoked by `promotion-apply.mjs` using
   `/usr/bin/python3 -I -S -B -`. It performs descriptor-relative installation
   mutations and verified private cleanup. It is a local promotion dependency.
3. `scripts/assert-owner-untouched.py`: used by Taskfile CI/dev/run/package/
   promotion/E2E. It is a development/owner-launch guard, not containment.
4. `scripts/scan-working-tree.py`: development secret-scan support, not the
   installed application's Computer runtime.

The package already contains Electron and embedded Node. Do not rewrite the
TypeScript modules, Browser, MCP or task service in Go/Rust. Do not switch to Tauri
or build an auxiliary backend merely to remove a small set of helper dependencies.

The preferred release direction is one narrowly scoped bundled native helper,
initially replacing safe_open, then promotion if its contract fits. A helper is
not a new authority broker: the existing application validates grants and the
helper enforces exactly the supplied bounded operation under OS constraints.
No user installation of Python, Node, a compiler or Command Line Tools should be
needed for the application's own filesystem operations. Codex/Claude and Git are
separate explicitly supported external developer tools, not hidden Python fixes.

Provisional language preference: Rust for the descriptor/atomic-filesystem helper,
not a decision to rewrite Farol. Go remains viable and may have a lower maintenance
cost for the owner. Resolve this with one bounded implementation spike over the
same protocol/race tests, not two production backends. No language migration or
new runtime dependency is implemented by this plan.

The hard part is compatibility and safety, not parsing JSON. Preserve descriptor
root pinning, no-follow/type/ownership/hardlink policy, root replacement detection,
expected digest, atomic no-replace/exchange semantics, interrupted mutation
uncertainty, fd 3 request bounds, response framing, cleanup and limits. Darwin
rename/clone/filesystem behavior requires explicit platform tests. Unicode
normalization/case folding and regex grammar cannot silently change when moving
from Python to Go/Rust. Go os.Root is useful but permits internal symlinks and
has documented filesystem/device/hardlink limits; it is not a drop-in replacement
for all current policies. Use a patched supported toolchain and current advisory
checks, not the assumption that a memory-safe language proves containment.

Spike acceptance: implement read and bounded read-window plus one safe staged
mutation in a private fixture. Replay existing root-replacement, symlink, hardlink,
FIFO/device, exact-hash mismatch and interrupted-publication cases against both
implementations on disposable state. Do not invoke old denied native checks or
inspect the live owner profile. Before an actual release switch, all dispatched
operations, snapshot paths and response/exit mappings must be covered; shipping
only read while edit silently falls back to Python is not independence.

Delivery order: protocol/race contract -> one helper implementation -> all-operation
parity -> app adapter and artifact digests/modes -> clean package -> normal-user
launch on a clean machine/account without Python/CLT -> separate signing/notary
qualification. Build-time CI scripts may remain temporarily, explicitly labelled;
removing them is not a dependency of the first Computer owner preview. They must
not be used to claim the repository contains no Python.

## 4. Concrete execution packets and dependencies

P0 OWNER TRIAL: preserve accepted canonical candidate and V0 fallback. One owner
packet for NEW connector, serving build/catalogue and disposable workspace.
This is blocked on the existing specific owner/runtime action, not on any proposal
in this document. Use the already accepted candidate, not a dirty new merge.

P1 BASE SAFETY: retain d03d272; only the supported mandatory-gate remedy enables
its integration/package. Record original refusal separately. A new source plan
cannot restore an unknown process or authorize replay. Do not poll the same
blocked state repeatedly or pretend old PASS covers new bytes.

P2 MODEL DISCOVERY (approximately 2-4 hours of bounded engineering, not an ETA):
finish read context propagation and host-model schema tests in the model writer,
then integrate semantically on the accepted safety base. Tests: same-name/different
ID, hidden entry, invalid/partial/cyclic catalogue, cache invalidation on session
change, cancelled/expired read at every await, no model/effort fallback, original
binding continuation, runtime-default race, old-config conflict and Settings
staleness. Runtime catalogue output is not account identity. Source can be prepared
while live trial waits; accepted integration remains gated.

P3 OWNER MESSAGING (approximately 3-5 hours for a first source/fixture slice):
consume f6efaba plus correction; implement one production access adapter using
current read/observation authority and one private per-operation ledger. Add restart,
publication failure, concurrent process ownership and new-selection replay tests.
Compose steer only after serving admission is implemented; do not require queue
or a global task registry for that slice. Then queue add/list qualification,
including idle/unloaded/approval-pending distinctions, when the selected host
actually supports it. No real message to the working Lead is a smoke test.

P4 EXECUTION CLARITY (approximately 1-3 hours source preparation): declare actual
known gate requirements with exact subject/selector, environment/resource needs,
limits and evidence type. Add completeness checks and readable preflight outcomes.
No automatic execution or fallback. Audit existing coverage before proposing a
split; full gate remains unchanged. Recovery lookup is a later source slice after
lifecycle ownership is settled, not a competing watchdog.

P5 PYTHON/INSTALLATION (approximately 2-4 hours for contract + one spike, not port
completion): freeze protocol/operation matrix, inventory packaged dependencies,
select one native language, implement a fixture-only spike and report mismatches.
In parallel prepare the clean-machine launch/reinstall/rollback checklist. No
signing credentials, publishing, installation, V0 switch or private profile edits.
Package closure work starts now, not after Model becomes perfect.

P6 NEXT FEATURES: only after a frozen useful candidate, or when all remaining
minimum steps are truly external, continue existing Agent start/rejoin/cancel/
recovery and Model streaming/compaction test packets. Do not restart the completed
competitor research or fold these into the minimum acceptance contract.

The estimates describe independent task sizes, not guaranteed cumulative speed.
This queue exceeds one 8-10 hour night; prioritize P0/P1/P2 and one independent P3
or P5 slice, rather than promising all capabilities the next morning.

## 5. Work ownership and stopping rules

One existing Lead owns the integration branch, shared composition files and final
acceptance. Prefer at most three internal workers: model pure tests, owner-message
journal fixtures, and Python/installation contract. Do not run two writers over
main.ts, shared-codex-proxy-host, the giant MCP composition or watchdog files.
Use existing/new named isolated worktrees and return base/commit/tests/limits.
Only Lead updates the canonical release candidate. Never push without its current
authorization. Preserve unrelated changes and all old receipts.

Publish coherent source checkpoints after safe targeted checks, clearly labelled
unaccepted, then use the repository's supported full-gate/review integration path.
This owner-requested handoff does not weaken required acceptance. No finished
source stays only dirty. Brain stores decisions/status, not backup copies of diff.

At the beginning of the work period, record which packets are executable with
current capabilities. If the exact gate/live action remains blocked, take a
specified independent source/test/doc packet that has not been refused; do not
repeat the blocked operation through it. Report one precise missing owner action.
When all such work or quota/context is exhausted, preserve terminal outcomes and
stop honestly. A /goal cannot guarantee unattended progress or override refusal.
No new fixed-time automation or background monitoring is created by this document.

Next-day success means one actual NEW Computer workflow or an exact unresolved
owner action, plus committed candidate deltas and their checks. It does not mean
counting open agent sessions, documents, lines or synthetic PASS as delivered features.

## Verification of this follow-up

Two bounded independent Luna reviews inspected the pinned model candidate and
owner-message prototype. Their requests changed no source or runtime. The model
review requests changes at the integration boundaries described above. The owner
review found invalid finite deadlines; production journal/capability wiring remains
an explicit missing qualification rather than an existing-runtime regression.

The follow-up author additionally identified the concurrent-claim uncertainty
problem. Before the source correction, six assertions failed (102 passed); after
correction all 108 tests in owner-task-messages.test.ts passed without skips.
This is an in-memory application/RPC fixture in a threads pool, not cross-process
fsync, native queue delivery or recovery of the earlier fork cleanup failure.
Typecheck, lint (263 production files), architecture (zero violations), exact-file
format, whitespace and scoped diff secret scan passed. Source is committed at
1e7757e. No full CI, native/package/live qualification or independent post-fix
ACCEPT is claimed. Original prototype, model candidate, Lead and main are unchanged.

The code correction is a source preservation checkpoint, not permission to merge.
It does not add a journal implementation, expose a new MCP route, change grants,
reply to consent, enable a queue or send anything to an owner-created task.

## Primary references checked 2026-09-28

- https://developers.openai.com/codex/app-server (selected runtime protocol and approvals).
- https://github.com/openai/codex/blob/c0d26949be4144c751894ae96e28d3db2208b764/codex-rs/app-server/src/request_processors/thread_queue_processor.rs (add/list and queue receipt; source is not serving proof).
- https://go.dev/blog/osroot and https://go.dev/src/os/root.go (traversal-resistant root API and limits).
- https://pkg.go.dev/vuln/GO-2026-4970 (current os.Root trailing-slash advisory; version qualification is required if used).
- https://doc.rust-lang.org/rustc/platform-support/apple-darwin.html (Darwin targets/build prerequisites).
- https://www.electronjs.org/docs/latest/tutorial/code-signing (signing/notarization are separate distribution steps).
