# Verification execution: preflight, truthful outcomes and recovery

Status: **PROPOSAL FOR DISCUSSION. NOT IMPLEMENTED, NOT ACCEPTED, NOT AN ACCESS GRANT.**
Date: 2026-09-28. Revision: 1.
Inspected source baseline: `3de61e796f5033bb5ffb36a5d60a97ff248c22e4`.

This document proposes a small extension to the existing Computer and evidence
mechanisms. It changes no product source, command policy, gate, hook, grant,
installation, active task or runtime. It is not an instruction to retry any
previously refused or outcome-unknown operation. The existing Lead must compare it
with current unintegrated work before accepting an implementation slice.

## Recommendation and limits

Keep an ordinary sandboxed terminal and standard Git. Add useful information at
three existing boundaries: known verification requirements before execution,
classified evidence after execution, and read-only recovery of an existing
operation. Reuse owner-controlled grants and request-correlated host approvals.
Do not build a second orchestrator, general command allowlist, permission system,
process supervisor, Git API or task board.

The goal is fewer avoidable failed launches and repeated approval questions, not
zero refusals. Authorized work should continue without repeated owner input;
missing authority, a real prohibition or an unobservable prior effect must remain
visible. This proposal cannot unblock an earlier terminal refusal by selecting a
new wrapper, worktree, tool, agent, provider or operation ID.

## 1. What the inspected source establishes

These references are relative to the repository root and describe the pinned
baseline, not the currently installed connector or later branch commits.

1. `Taskfile.yml`, `package.json` and `vitest.config.ts`: `ci:fast` includes the
   owner-guarded CI command, output checks and secret scanning. CI runs coverage
   over `tests/**/*.test.{ts,mjs}`. No-native-UI is not equivalent to no native
   requirements. Test directory names are insufficient to choose an executor.
2. `tests/integration/evidence-observe.test.mjs` and
   `tooling/evidence-observe.mjs`: some integration cases spawn real children and
   observe the process table through `/bin/ps`. `docs/testing.md` records that the
   restricted execution environment cannot supply all of this evidence.
3. `src/modules/computer/infra/native/sandboxed-workspace-shell.ts`: shell has
   stable operation IDs, private fsynced reservations, live handles, bounded
   stdout/stderr reads and owned cancellation. Input timeout is at most 600,000 ms.
   `docs/computer-parity.md` records the 4 MiB output boundary and the limitations
   after MCP process replacement.
4. `tooling/evidence-attempt.mjs`: native/evidence lanes already preserve separate
   started, terminal and exit receipts. `tooling/evidence-eligibility.mjs` and
   `tooling/evidence-cases.mjs` bind acceptance to the declared lane, exact subject,
   cases and evidence. Reuse these concepts; do not replace them with one Boolean.
5. `scripts/assert-owner-untouched.py`: a before/after fingerprint detects changes;
   it is not containment or attribution. `_digest()` can return `unreadable:errno`;
   directory traversal has no completeness result. Equal observations alone do
   not establish that inaccessible data was unchanged. This is a static review
   finding, not a reproduced owner-state exploit or a proven cause of an incident.
6. `AGENTS.md` asks for `ci:fast` before committing, while
   `tooling/hunt-report.mjs` requires exact committed build/test identities. The
   intended checkpoint versus acceptance ordering needs an explicit decision,
   not an undocumented bypass of Hunt or Git hooks.
7. `.github/workflows/standalone-ci.yml` is manual-dispatch source verification on
   macOS, not an automatically triggered release or installation workflow. An
   absent hosted run is not an instruction to create one.
8. `src/modules/computer/infra/mcp/computer-guidance.json` already describes shell
   ownership, revocation and unknown outcomes. Extend this catalogue rather than
   introducing an unrelated product guidance package.
9. `src/modules/computer/infra/native/home-secret-stores.ts` treats the whole
   provider home directory as protected. The desired ordinary managed-worktree
   workflow and the current policy are not identical. Any future support must
   admit only explicitly selected ordinary source and required Git metadata,
   without granting sibling authentication or session stores. Do not move an
   already refused operation elsewhere to claim it has been repaired.

The private incident history belongs in the owner knowledge vault, not a portable
source RFC. It records installed-launcher refusals, an unobservable synchronous
CI timeout, nested sandbox failure, cleanup refusal and owner-state changes with
unestablished causality. None is re-executed by this proposal.

## 2. Separate three questions

### Evidence subject

What claim is being tested: source behavior, a disposable native fixture, a sealed
artifact, an installed application, or a live provider/owner journey? A packaged
fixture is not installed acceptance. A synthetic provider cannot qualify a real
account. A source assertion failing with EPERM is not automatically infrastructure.

### Execution capabilities

What does the workload require: approved source/temp writes, Git metadata and
normal user settings, process creation/observation/control, local IPC, loopback,
native helper execution, nested sandbox application, UI/focus, or a live service?
Capabilities belong to a particular verified execution context. A native Codex
host may itself be restricted; its name is not a permission grant.

Loopback TCP, Unix-domain sockets and Internet egress are different requirements.
Do not request general network permission when only a disposable local listener
is needed. Ordinary hooks, toolchain dependencies and temporary directories are
part of a command's transitive requirements, not invisible implementation detail.

### Authority

Does the current owner-selected grant actually admit the required resources and
effects? Does it remain valid for this task, physical workspace and generation?
Read access, source-write access, Git metadata access, UI focus and release effects
must not be conflated. Already approved ordinary development operations should
not trigger a new custom consent prompt for every command.

### Practical lane grouping

- **Source-compatible**: inspected pure policy/type/lint/format/architecture and
  bounded local fixtures whose actual requirements fit the selected sandbox.
- **Native fixture / package verification**: disposable OS/socket/process/Seatbelt
  and Electron evidence, including exact packaged bytes when required, in an
  independently authorized suitable host environment.
- **Owner / installed / live**: serving identity, real connector/account/profile
  and separately authorized installation or activation. This is not a default
  dependency of every source edit.

These groups are planning labels, not security levels. Keep evidence subject,
capabilities and grants separate in the implementation.

## 3. Minimal preflight for known checks

Start with a small repository-owned declaration beside existing tooling, covering
known gates and their native-dependent subchecks. Do not classify arbitrary shell
programs by parsing command strings, and do not make this declaration an allowlist
for the general Computer terminal.

For each registered check, identify its command/selector and contract revision,
subject requirements, required capabilities, output/time bounds, conflicting
resources and acceptance conditions. A later implementation may store this in
`tooling/verification-requirements.mjs`; that name is a proposal, not an existing
command or API.

The planner compares requirements with the existing verified authority and executor
snapshot. It should explain one of: ready, missing supported approval, unsupported
in this environment, prohibited, or waiting for a conflicting owned resource.
Unknown capability is not ready. Do not launch dummy writes, protected reads,
process kills or a forbidden native probe to discover permission.

Preflight cannot prove all effects of arbitrary code. The actual sandbox remains
the authority. Revalidate subject, physical target, expiry and generation immediately
before the effect; preserve any actual refusal that occurs despite a ready plan.
No cached approval or capability label can override the enforcing layer.

A modified test or script can change its requirements. Pin the declaration and
executed subject together. Add a deterministic completeness check so every gate
entry is covered and no required native test disappears during an eventual split.
Initially keep the existing full gate intact; publish the compatible subset as
partial evidence. Do not merge coverage percentages from different suites or
transfer receipts between commits. Any later gate split must preserve the required
case set, source identity and unchanged coverage thresholds.

Use existing resource ownership where available. Serialize only checks that really
conflict: one full native/package/owner-guard workload on shared resources, and no
second run over an unresolved original workload. A lock between Next tests does not
control independent owner/V0 activity. Do not stop the owner's other applications
to manufacture a quiet window.

## 4. Truthful results, without an enum migration project

Normalize existing result codes at the orchestration/UX boundary. Keep raw error
codes and first-failure evidence; do not replace stable wire schemas unnecessarily.
A conceptual observation needs separate dimensions:

- execution: not-started, running, terminal, or outcome-unknown;
- check result: not-evaluated, passed, failed, blocked, or incomplete;
- reason: assertion, policy refusal, capability unavailable, configuration,
  dependency/startup, transport, deadline, cleanup, or safety observation;
- observed refusal layer: established layer or unknown;
- cleanup: pending, confirmed within the declared boundary, or unverified;
- identity: exact attempt/operation, executor generation, subject and contract.

Avoid unsupported diagnoses. EPERM/EACCES alone does not name Seatbelt or prove a
product defect. Expected refusal can be a passing negative test. A product that
violates its promised authorized behavior can genuinely fail with EPERM. Test
assertions, runner exit, guard result, evidence completeness and independent review
are separate facts. A successful root exit with unverified required cleanup is not
an accepted lane.

A tool's wait timeout and the command's own deadline are different. The former
changes observation state, not the execution result. The latter may be a test or
infrastructure failure depending on the declared contract and actual evidence.
Activity should show what is known, the last observation time and the next lawful
step, not an invented progress percentage or a permanent 'thinking' label.

Owner-state mutation remains a failing safety gate even when product assertions
pass. A before/after difference does not establish who caused it. In a separate
reviewed safety slice, add observation completeness; denied traversal, unreadable
required data or missing observations must not become an 'untouched' PASS. Do not
remove watched paths, add incident-specific exemptions, substitute a fake HOME, or
weaken that guard as part of CI routing. Hermetic source fixtures may use their
explicit disposable homes; that is a different claim from owner protection.

## 5. Timeout recovery: inspect, never reproduce

Reuse `computer_shell_start/read/cancel` and the existing evidence receipts. Prefer
an additive lookup to the current shell interface over a new CI execution service.
Any proposed new operation below remains unimplemented until reviewed.

Before starting a known long check, retain a caller-known operation ID and its
exact subject/workload identity. Check the executor's actual deadline/output limits
and current authority lifetime. A 20-minute workload does not fit a 10-minute
executor merely because a handle is returned. Prefer an already supported long-run
host lane selected before launch; raising limits or replacing the backend is a
separate decision, not an automatic workaround.

After start, retain the existing owned handle and read stdout/stderr by independent
byte offsets. A failed wait causes observation of that same operation. If the
start acknowledgement is lost, a scoped read-only lookup by operation ID should
return the existing handle/terminal receipt or an honest unknown state. It must
never internally call start. Not-found after retention, restart or failed indexing
is not proof of non-execution. Retain enough non-replay tombstone information for
the existing identity contract; do not trade bounded storage for silent replays.

Distinguish three recovery guarantees:

1. Reconnect to the same MCP process: existing live handle and output may survive.
2. MCP replacement after completion: a durable terminal/cleanup receipt may prove
   the result if the trusted owner published it.
3. MCP replacement while running: current behavior cancels/drains the owned group
   and may leave an unknown outcome. Resuming that process or preserving unlimited
   output is not promised by this proposal.

The existing watchdog/owner should publish a bounded, versioned, content-free
terminal record before its completion acknowledgement, with root exit/signal,
termination reason and independently qualified cleanup. Persisting a record alone
does not ensure it will be written after every crash. Missing publication stays
unknown. Full stdout persistence is optional later work with explicit retention,
access and redaction; it is not necessary for the first recovery increment.

Runtime authority and operation lifecycle belong in the existing private trusted
store. Workspace-writable logs and test-generated JSON are useful evidence, but
must not authorize replay, release a safety barrier or grant acceptance by themselves.
Reject malformed, mismatched or conflicting receipts. Scope status reads to the
original task and operation; an ID is not a bearer permission. Revocation may deny
output even while separately authorized content-free cleanup observation remains
possible. Do not read raw private stores from a fallback tool.

A new attempt may be considered only after the original state and required cleanup
are resolved and the current policy admits it. Record the reason for repetition and
what changed. A new key, elapsed time or a different agent is not such a reason.
Deduplicate the unresolved logical check across keys within its actual resource
conflict scope, not every unrelated check across the whole repository.

An old synchronous run with no handle or trustworthy receipt may remain unresolved.
Do not claim this new design can retroactively reconstruct its exit status. A future
read-only hosted-CI adapter must inspect the same run and run-attempt, not dispatch
or rerun a workflow to recover a lost response.

## 6. Owner approvals: existing grants first

There are three different paths, not one universal 'Allow' button:

- An ordinary supported grant is missing: show the precise additional resource and
  allowed duration. Reuse current grant/Settings machinery; do not ask again for
  every ordinary command already covered.
- A known check needs another executor before it has started: choose an already
  authorized compatible executor or request the exact supported native plan. Merely
  changing executors does not repair a known prohibition.
- An actual enforcing layer refuses: preserve that refusal. Only the approval flow
  explicitly offered by that layer can resolve it. Farol cannot offer a button that
  overrides a host/platform policy.

Bind a pending owner decision to its originating runtime/environment, request,
thread/turn/item where applicable, selected physical workspace, generation,
requested scope and effect identity. The authority service owns this binding;
model-supplied text or an arbitrary 'yes' is not a trusted approval response.
Render only supported decisions. Never turn 'allow once' into full access or approve
unrequested scopes. Consume owner decisions through the owning request route, then
observe host resolution and execution separately. A resolved approval is not a
successful command result.

Concurrent clients must not answer a request they merely observed. Declined,
expired, superseded or already-resolved requests cannot be answered or replayed.
Lost response after approval means inspect the same request, not another approval
or effect. Do not enable currently unqualified task-control or consent methods
merely to make the UI demonstration work.

A supported inline client approval/elicitation surface is preferable. If this client
has no such capability, show the existing Farol Desktop pending request as the honest
route. Do not promise a native chat card based solely on protocol documentation.
Test the actual connector/client/host combination before claiming live support.

Public references checked on 2026-09-28:

- OpenAI App Server: <https://learn.chatgpt.com/docs/app-server>. It documents
  sandboxed `command/exec`, streamed output and follow-up operations, and scoped
  server-request approvals. It also distinguishes unsandboxed process/shell APIs.
  None establishes compatibility, authority, durable recovery or approval ownership
  for the installed Farol connection. Do not switch backend or use the unsandboxed
  APIs in response to refusal.
- MCP elicitation: <https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation>.
  Supported interaction modes depend on declared client capability. This is a UI
  transport option, not OS authorization. Pin the actually negotiated protocol;
  a newer public revision does not imply that an installed client supports it.
- MCP Tasks: <https://modelcontextprotocol.io/extensions/tasks/overview>. Durable
  handles and polling are relevant protocol concepts. Do not make migration to
  Tasks or support in the current ChatGPT connector a prerequisite or an assumption.

## 7. Adoption order and alternatives

### Increment A: immediate clarity, no new execution backend

Add the small known-check requirements map, read-only planning output and classified
Activity/guidance. Keep general shell behavior and existing full acceptance gates.
Write explicit source/native/owner evidence labels and a gate membership regression.
Use existing native handles whenever already available. This has the smallest
coupling to the active task-control/cleanup writer.

### Increment B: recover the same shell operation

Add scoped operation-ID lookup and a trusted durable terminal/cleanup receipt using
the existing shell owner/watchdog. Qualify restart/lost-ack/retention/fence cases.
Do not change group cleanup semantics or claim detached-child containment. Coordinate
these files with the existing Lead; no parallel overwrite of lifecycle work.

### Increment C: complete the existing owner-decision route

Integrate the request-correlated owner choice with existing task/desktop ports only
after serving identity, policy and request ownership are qualified. Read current
branch work first. Do not add another approval broker or silently enable control.

Two related changes need separate decisions: truthful owner-guard completeness and
checkpoint-versus-acceptance ordering. Suggested future ordering is targeted safe
checks, a clearly unaccepted coherent checkpoint, then exact clean full gates and
review before integration/package. This document does not change AGENTS, hooks or
current required gates. A blocked gate remains blocked; a checkpoint is not accepted.

Alternatives rejected for this increment: a generic workflow engine; per-command
consent/allowlists; automatically disabling sandbox; replacing the working shell
with App Server just to gain a different boundary; mandatory new MCP protocol work;
fixture-only validation presented as native proof; quiet-window assumptions as
containment; full-log retention as a prerequisite; hard-coded private owner paths.

## 8. Review scenarios before implementation acceptance

Each scenario must be assigned to source, native fixture or live qualification and
an exact subject. These are proposed acceptance cases, not tests run by this RFC.

1. Known native-only check in restricted Hub: explained not-started result, zero
   native launch attempts and no alternate dispatch.
2. Already granted ordinary shell/Git work: no custom per-command permission prompt.
3. Declaration or subject changes after planning: stale plan cannot authorize the
   changed workload; ordinary sandbox enforcement remains in place.
4. Grant expires or is revoked between preflight and effect: no stale admission.
5. Negative refusal test passes; unexpected EPERM assertion fails; unidentified
   errno remains unattributed rather than automatically waived.
6. Lost wait response with a live handle: same process/attempt is observed, no second
   start, independent output offsets retained.
7. Lost start acknowledgement: lookup recovers the same reservation/handle or unknown;
   it never starts the command.
8. Completed runner then MCP restart: only a valid bound terminal receipt can restore
   the observed result; no private output leaks after revoked authority.
9. Restart during execution or crash before terminal publication: unknown stays unknown;
   no auto-resume, replay or acceptance.
10. Missing/expired/corrupt/foreign receipt: no not-started inference, no safety-barrier
    removal and no operation-ID cross-task access.
11. New key for the same unresolved conflicting workload: no duplicate; an independent
    authorized workload can proceed when its resources are genuinely independent.
12. Root exit zero with unverified required cleanup: lane not accepted; detached
    cleanup is never inferred from process-group disappearance.
13. A workload exceeds supported runtime/output bounds: preflight explains incompatibility;
    no detached launcher and no silent output truncation represented as complete.
14. Two clients see one approval: only its qualified owner route answers. Decline,
    cancellation, stale generation and lost acknowledgement never expand authority.
15. Client lacks inline elicitation: honest Desktop route, no fake approval UI success.
16. Protected owner observation incomplete or changed: non-PASS guard, no blame assigned
    without causal evidence, no incident-specific exemption.
17. Test lane split or selector change: required cases and coverage remain accounted
    for; selected/partial evidence cannot satisfy the full gate.
18. New artifact digest with the same source commit: old package evidence cannot qualify it.
19. Approved ordinary source under a managed-worktree-shaped directory: a separately
    reviewed native fixture proves exact source/Git access and denied sibling stores;
    the proposal does not retry an existing protected-path refusal.
20. Hosted CI status request after transport loss: same run and attempt only, zero
    workflow dispatches or reruns.

## 9. Questions for the main Lead

Decide whether Increment A is worth taking now or whether existing active work
already supplies it. Identify the smallest current source/native subset without
weakening the full gate. Confirm one authoritative execution backend and lifecycle
owner for Increment B; do not implement two. Reconcile pending task-control and
cleanup commits before assigning Increment C. Resolve documentation/checkpoint and
acceptance ordering explicitly. Keep owner-state guard completeness as a distinct
safety change rather than an excuse to bypass the blocked gate.

The useful success measures are avoidable incompatible launches, duplicate CI
effects after reconnect, repeated prompts for already granted scope and operations
with retrievable terminal state. No numeric improvements have been measured.

This RFC is a documentation-only preservation checkpoint. Full `ci:fast`, native,
package, live and independent acceptance are not supplied by it. No current gate or
refusal is waived, and no source implementation should be integrated on its authority.
