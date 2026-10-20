# Computer migration evidence

> Historical preparation checkpoint. The evidence below records the original
> Computer preparation slice based on
> `1eb30bd23df22c9581d277280f8e0699612786b5`, including its subsequent read/list
> safety fixes. References to "current" owners, installed status, pending gates
> and provider exclusions describe that checkpoint, not the latest source or
> installed state. Semantic reconciliation against accepted source
> `aa242b08f755618db8081b638e013b24ec1e28bb` retains these original safety
> obligations and evidence limits; it does not establish fresh execution,
> packaging, installation or live-provider acceptance.

For current source ownership, follow [Go authority](../../../../modules/computer/domain/authority/),
[workspace application services](../../../../modules/computer/app/services/workspace/),
[published workspace contracts](../../../../modules/computer/contracts/workspace/),
[native filesystem guards](../../../../modules/computer/infra/filesystem/), the
[durable authority owner](../../../../modules/computer/infra/repos/access/), and
[trusted operation composition](../../../../boot/computer.go).

Current [file-policy meanings](../../../../modules/computer/domain/authority/filepolicy.go) distinguish
trusted root-scoped `approved-roots-v1` from legacy protected-file policy.
[Native policy](../../../../modules/computer/infra/filesystem/workspace.go) and
[boot selection](../../../../boot/computerfilepolicy.go) must match the approved mode.
Root-scoped policy removes implicit filename bans while retaining explicit
exclusions, exact scope, physical-root/no-follow guards, byte bounds and race
checks. The mandatory-name description below records the historical policy.

Use [AGENTS.md](../../../../AGENTS.md) for current review timing and the
General/Specialists -> Strong/R3 -> Frontier/R4 ladder. The unavailable-provider
paragraph below preserves a preparation-era constraint and does not replace
the current review policy.

Base: `1eb30bd23df22c9581d277280f8e0699612786b5`.
This is a preparation slice. No installed capability or active executor has
switched to Go. Shared wire schemas, composition and the root module belong to
Core. Production integration belongs to the program integrator.

## Current operation owners and contracts

| Family           | Current implementation                                                                      | Retained contract and deletion exit                                                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authority        | `src/modules/computer/domain/execution-authority.ts`, read/mutable app services             | Owner/session/task/epoch and Computer generation; subtree/exact narrowing, exclusion provenance, capabilities, command/network scope, expiry, mutation ownership; recheck before read disclosure. Remove only after trusted approval/participant repositories have one Go owner. |
| Read/list/search | `native-readonly-workspace.ts`, `resources/native/safe_open.py`                             | Descriptor-relative no-follow walk, approved ancestor device/inode, owned non-writable root, single-link regular files, denial aliases, bounded UTF-8 windows and raw-byte digest. Replace each verb only after real routed parity.                                              |
| Write/edit       | `safe_open.py`, mutable app service and mutation repository                                 | Hash/size-bound edit, create-only collision, durable operation binding before effects, publication-before-response ambiguity. A lost response is unknown, never replay or Python fallback.                                                                                       |
| Shell/process    | `sandboxed-workspace-shell.ts`, `shell-watchdog-source.ts`                                  | Durable exclusive intent, exact request fingerprint, process-group lifetime, paged raw output, timeout/cancel, sticky signal denial, explicit unverified detached descendants. Terminal root exit does not prove cleanup.                                                        |
| Fixed Git        | `workspace-snapshot.ts`, `native-verification-command.ts`, snapshot verbs in `safe_open.py` | Independent APFS clone, bounded metadata/tracked snapshot and source identities, literal filtered paths, declared tracked-only coverage and exact linked-worktree metadata approval. No copy/hardlink fallback.                                                                  |
| MCP              | `create-readonly-computer-mcp.ts`, bootstrap/catalogue, execution fence, private lifecycle  | Caller authority is admitted from trusted state. A tool declaration alone does not prove the serving runtime. Fence `retry:later` is an admission refusal before effects; effect failures retain `retry:never`.                                                                  |

Shell start/read/cancel and fixed Git status/head are present in the current MCP
source. Ordinary Git uses approved shell command authority and separate Git
history approval. The existing Chat Computer port and Product Agent peer do not
admit general shell. Migration must not widen those grants to claim route parity.
The Settings Git status/head buttons are separate: by owner decision of
2026-10-20 they are unavailable in Go-aware builds (`WORKSPACE_COMMAND_UNAVAILABLE`)
and run only in the explicit legacy build.

## Unknown and reconnect

Shell reserves `operationId` durably before dispatch. Same-process identical
requests return their existing handle; changed content conflicts. After restart,
a reserved intent returns `SHELL_OUTCOME_UNKNOWN` rather than spawning again.
Current handles/output are process-local and cannot be restored by a new executor.
Read/cancel of a missing handle returns `SHELL_HANDLE_UNKNOWN`. Reconnect must
observe the same operation; it must not create another intention or reset a deadline.

Mutable filesystem operations bind the operation and digest before effects.
An interrupted persist/publication/acknowledgement window remains unknown until
exact observation reconciles it. No language fallback after possible effects.

## Brain Markdown regression

The known incident remains unresolved in the installed route. Native listing has
no extension filter: it omits denied names, symlinks, multiply linked files and
unsupported types. A returned filtered list is not proof that omitted files are
absent. A concurrent directory change is classified as a race.

Mandatory root-relative secret names and enclosing home credential stores remain
protected independently of owner exclusions. The host injects the trusted home;
a tool request cannot choose it. The complete combined deny list is bounded
without dropping any prohibition.

Disposable Go vectors cover repeated Markdown list/read, exact raw-byte digest,
BOM, full/ranged UTF-8, truncation/invalid encoding, path escape, denial aliases,
symlink/hardlink/FIFO, root replacement, narrow approved ancestor, cancelled read,
changed snapshot and bounded listing. Application vectors cover revoked grants
and approvals before disclosure. One coherent snapshot callback serializes
validation and response construction with grant/approval mutations; two separate
repository lookups are not a valid substitute. The in-memory access repository
is a disposable K1 owner, not installed persistence migration. The native
[authority state owner](access.md) now supplies a protected, coherent durable view
and trusted composition ingress; its source/native checks are separate from
production activation and settings migration. These vectors do not establish the incident's
cause, installed profile identity, provider acceptance or product routing.

Full and ranged workspace reads require stable file identity, mode, size, mtime
and ctime across the individual native read. Same-size overwrites, growth and
truncation are refused as `WORKSPACE_RACE_DETECTED` with no response and no retry.
A ranged response describes one checked window; separate pages do not share a
persistent file snapshot. This policy does not apply to process-output streams.

Pure authority permits `/` in scope algebra. Native workspace execution retains
the TS adapter and `safe_open.py` restriction: selected roots and approved
ancestors must contain a named absolute path component. `/` returns
`WORKSPACE_INVALID_REQUEST` with no response and no retry, before native traversal.
Disposable boundary vectors cover read/list refusals; they do not read or list the
system root. Authority admission alone does not establish native capability.

## Evidence and remaining gates

Go native tests are intended for Darwin/arm64 disposable trees. Linux compilation
is a portability check only. A repository terminal call is not shell/Git product
proof. K1 requires the accepted real TS bridge -> Go backend -> Computer service
with missing/stale backend, malformed frame, denied/revoked authority and lost
response cases. Shared protocol must come from Core's canonical schema.

Search/bootstrap, create/edit, process persistence/reconnect, ordinary shell/Git,
linked-worktree/hooks/config qualification and removal of old active executors
remain separate migration slices. Their tests and installed exits are NOT_RUN for
this preparation slice. No old Python/TS executor is removed here.

Authorization cutover requires the full R4 review. The currently configured Codex
Frontier route selects a provider explicitly excluded by this program; that gate
remains unavailable until its owner resolves the policy. Preparation specialist
review must not be reported as the completed cumulative gate.
