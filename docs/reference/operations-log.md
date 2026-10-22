# App operations log

The desktop records content-free operation observations in the current profile's
`farol-state/operations/` directory. It never uses a global state directory.
Production, Dev, Owner Preview and disposable test profiles keep their existing
identity isolation.

## Storage and outcomes

Each writer appends JSON lines to its own timestamp/UUID segment, rotating at
64 KiB or when the next observation belongs to a different UTC calendar day,
including when the clock moves backwards. The directory is mode 0700; regular
single-link files are mode 0600 and opened without following symlinks.
Recording is observability: `begin`, its
completion callback and `record` validate bounded metadata, enqueue, and return
without filesystem work. One asynchronous writer per store processes FIFO batches
of at most 64 observations, synchronizing once per batch/rotated segment. Directory
preparation, label replacement, tail repair, retention and diagnostics all use
asynchronous filesystem APIs on that writer.
Age retention deletes a complete segment only when its newest valid record is
strictly older than 30 days. Segment creation names never decide record age or
visibility. Each segment has a private `.jsonl.index.json` sidecar containing
minimum/maximum valid record times and raw nonempty record count. The writer
verifies this index against bounded segment contents on each retention pass and
atomically rebuilds missing, corrupt or stale indexes. An unreadable/oversized
segment or one without valid record times cannot establish age expiry. Readers
filter individual valid records against the 30-day cutoff, including in legacy
segments spanning that cutoff; a record exactly at the cutoff stays visible.
Future records do not advance the cutoff, and backwards clocks do not lower a
segment's maximum record time.

The independent 8 MiB (including indexes) and 20,000 raw-record caps still delete
whole segments, ordered by newest record time rather than creation name.
Whole-segment deletion can retain fewer than the maximum. Readers skip
and count invalid lines, unsafe files and oversized segments. Logging failures
are counted and shown once as aggregate diagnostics in Activity and support export,
without changing the original operation's result. No raw filesystem error text is
recorded. Per-writer private diagnostic sidecars expose MCP-process counts after
a successful write, survive restart, and have a separate 64 KiB/30-day bound. If
the disk cannot store even diagnostics, counts remain in that process's memory;
no logger can promise durable evidence on an unavailable disk.

The closed schema stores time, source, operation kind, workspace label, relative
path, closed command category, outcome, closed code and duration. The optional lifecycle
field contains only a UUID and started/observed phase. The names-only workspace
label index is atomically replaced in the same private directory; it grants no
access. Command categories are `git` and `other`, never arbitrary executable names; search patterns, file contents, prompts,
replies, credentials and raw exception text are never projected.

Shell read/cancel observations inherit the dispatched start's workspace, relative
directory and command category by original operation ID, checking the returned
handle when available. This server-local metadata cache keeps at most 1,024
starts, excludes proven refusals and never relabels a retained ID. For an unknown, evicted or
previous-connection start, the target contains only the fixed `handle: "unrecognized"` marker and
`start: "unknown"`; the supplied handle is never recorded; Activity displays that limitation. This lookup grants no
execution authority and never reads command arguments, stdin or output.

The recorder observes admission without granting it. Promise-based desktop
observers enqueue their start observation first, invoke the action inside a guarded
region, attach isolated settlement callbacks and return the exact original promise.
A synchronous throw records `unknown` / `OPERATION_SYNC_THROW` and rethrows the
exact original exception synchronously. Unclassified asynchronous rejections remain
`unknown` / `OPERATION_OUTCOME_UNKNOWN`. They add no
await or result transformation to health checks, Stop or Quit. The MCP tool
adapter enqueues its start at the existing handler boundary. A flushed unmatched
start remains pending across restart. Its separately appended observation supplies
the actual result; the raw start line is never edited. Activity folds only such
matched start markers. Explicit unknown and pending results remain immutable,
including after a later independent read-back. A helper ACK is pending, not proof
that an update was installed. No logger invokes retries or reconciliation.

## Closed vocabulary and field provenance (B9)

`apps/desktop/renderer/operation-outcomes.ts` owns one explicit mapping from
codes and outcome kinds to `done`, `refused`, `failed`, `unknown` or `pending`.
`operations-vocabulary.ts` derives the recording vocabulary from that mapping:
`farolOperationCodes`, the explicit `providerOperationCodes`, and
`provider_error`. Provider codes are limited to `server_error`,
`rate_limit_exceeded`, `invalid_api_key`, `insufficient_quota`,
`invalid_request_error`, `context_length_exceeded`, and
`content_policy_violation`. An unlisted result code or outcome kind becomes
`unknown` / `OPERATION_CODE_UNMAPPED`; a raw code supplied directly to the recorder
becomes `unknown` / `provider_error`. Each such observation increments the durable
`unmappedCodes` diagnostic shown in Activity and support export; no raw value is
retained. Absence remains null. New Farol classifications require an explicit source change
before their detail is recordable. A regex, uppercase spelling, HTTP status suffix,
provider failed-frame code, or handler refusal reason never extends the set.

The result observer reads string errors, structured error kinds/codes, Go outcome
and phase fields, configuration evidence/connector receipts and MCP data. Unknown
or unconfirmed evidence dominates every contradictory terminal assertion, including
`ok: true`, explicit failure/refusal and HTTP errors. Pending evidence stays pending;
`ok: false` alone supplies no refusal proof. Model terminal frames and handler
reasons use the same mapping, and the recorder preserves unknown/pending codes at
both entry points. `CHATGPT_CONVERSATION_UNCONFIRMED` therefore remains unknown.

`tests/unit/operations-outcome-inventory.ts` discovers TS contract/producer code
literals and closed result discriminants, plus Go code/outcome constants in the
observed owners. The inventory deliberately includes a conservative superset for
open string contracts. The exhaustiveness test fails with source paths for every
unmapped value and rejects duplicate mapping entries; it does not compare the
mapping against another copied list of contract codes. Shape, precedence, redaction
and persistence fixtures are source tests, not native or live-provider acceptance.

`createTotalOperationsRecorder` validates before calling any sink, including
`begin`, `record`, finish handles and workspace labels. The strict store/read/export
schemas independently reject records outside the vocabulary. Existing invalid disk
lines are counted as corruption and excluded from snapshots/export; they are not
rewritten or replayed. The HTTP model adapter uses the same code classifier before
returning upstream refusal codes. Model SSE frames and action results remain
unchanged outside the diagnostic projection.

| Stored field                            | Origin and recording rule                                                                                                                                                                                                          |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`                                | Farol adapter selection; exact `ChatGPT`, `Setup`, `You`, `Updater`, `Codex` enum.                                                                                                                                                 |
| `kind`                                  | Static Farol operation names and validated command discriminants; exact `operationKinds` enum. Arbitrary strings are rejected, including regex-shaped names.                                                                       |
| `target.workspace`                      | Exact caller ID resolved to the owner-configured label at observation time; otherwise `[unknown workspace]`. Labels retain existing bounded owner-text normalization.                                                              |
| `target.relativePath`                   | Selected relative-path/directory metadata only after workspace resolution; existing bounded normalization removes control/format characters and rejects absolute paths, empty segments, traversal and backslashes. `.` is allowed. |
| `target.command`                        | MCP's selected executable word or Farol's fixed Git action, reduced at the recorder boundary to `git` or `other`; no arbitrary tool-argument word survives.                                                                        |
| `target.handle`, `target.start`         | Unmatched process arguments have no trusted start metadata; fixed `unrecognized` and `unknown` only. Matched starts retain their validated target; raw handles are never persisted.                                                |
| `outcome`, `code`                       | Farol's closed outcome classifier and the single closed code set above. Provider, ChatGPT, process, tool and network text cannot add a value.                                                                                      |
| `id`, `lifecycle.id`, `lifecycle.phase` | UUIDs minted by the store and exact `started`/`observed` phase. Adapter metadata cannot supply or override them.                                                                                                                   |
| `at`, `durationMs`                      | Farol wall/monotonic clocks; finite, nonnegative safe integers. Duration is rounded locally; invalid numeric values are rejected.                                                                                                  |
| Workspace label index                   | Only `workspaceId`/`label` selected from owner configuration; same name bounds, at most 128 pairs. Other configuration fields never reach the sink. Disk label values are validated again before substitution.                     |
| Diagnostic/index counters               | Local increments or counts of validated/read records; nonnegative safe integers at the snapshot/export boundary. No external text or error message is retained.                                                                    |

Workspace names and relative paths are the explicit owner-metadata exception, not
code or kind vocabularies. International names and normal relative filenames remain
visible. Raw file/process/network contents, command arguments, search text, prompts,
answers and exception messages have no log field. Unknown target/metadata keys are
rejected. Failing observation never suppresses work, changes promise identity,
adds an await turn or retries an operation.

## Workspace resolution and target inventory (B14)

`apps/desktop/operations/target.ts` owns the shared target resolver. Adapter
metadata carries workspace IDs. `createTotalOperationsRecorder` resolves the exact
ID before any normalization, before calling a sink's `begin` or `record`, and
again when a finish handle observes enriched metadata. A caller cannot impersonate
an ID by supplying its owner label, a control-character variant or a truncated
prefix. Missing configuration resolves nothing. Unmatched workspace values become
`[unknown workspace]`; relative paths and directories are absent unless a workspace
resolved. Resolved labels and paths keep their existing per-field normalization.
Command names become only `git`/`other`; unknown process handles become only
`unrecognized`/`unknown`. Unknown target keys still fail the closed schema.

The store queues only resolved targets. Configuration changes before the writer
runs cannot retrospectively resolve an earlier caller value. The separate MCP
process loads the private owner label index before serving tools; an unavailable
index leaves its workspace targets unresolved. Loading the index never rewrites
it or creates execution authority.

Persisted records contain labels, not IDs. Store reads resolve those labels
against the owner index, before display normalization, and reapply the resolver
to returned snapshots, including cached deadline fallbacks. Older raw unmatched
IDs and their paths are suppressed without rewriting historical segments. A label
removed from the current configuration is also suppressed. A historical label
that equals a currently configured owner label is indistinguishable from that
owner label and is retained as configured metadata; arbitrary unmatched text is
never accepted as a label.

`createSupportExport` independently uses its full owner configuration; the final
`writeSupportExport` uses an explicit names-only workspace argument. Both invoke
the same resolver before their closed snapshot schema. A direct export without
configuration drops workspace/path detail. The production export passes the same
configuration snapshot to both boundaries. The renderer receives the sanitized
store snapshot through the operations IPC; no renderer label map grants trust.

| Target producer / caller input                                                                                                                     | Projection and handling                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bridge/computer-mcp.ts`: `farol_connector_verify`                                                                                                 | Caller `workspaceId` only; exact-ID resolution or fixed marker. Challenge is excluded.                                                                                                                                                                                                                              |
| Same: `computer_workspace_bootstrap`                                                                                                               | Caller `workspaceId`, `relativeDirectory` projected as relative path; directory survives only with resolved workspace.                                                                                                                                                                                              |
| Same: `computer_workspace_list`, `computer_workspace_read`, `computer_workspace_search`                                                            | Caller `workspaceId`, `relativePath`; same resolution. Search pattern and returned file/match data are excluded.                                                                                                                                                                                                    |
| Same: `computer_workspace_write`, `computer_workspace_edit`, `computer_mutation_read`                                                              | Caller `workspaceId`, `relativePath`; same resolution. Operation IDs, hashes, content and edits are excluded.                                                                                                                                                                                                       |
| Same: `computer_shell_start`                                                                                                                       | Caller `workspaceId`, `relativeCwd`, executable word; workspace/directory resolution and closed command category. Arguments/stdin are excluded.                                                                                                                                                                     |
| Same: `computer_shell_read`, `computer_shell_cancel`                                                                                               | Original operation ID/handle select server-local start metadata; inherited raw ID is resolved anew at observation. No match yields fixed markers only. Provider-returned handles are used only for matching; never stored.                                                                                          |
| Same: `computer_connection_status`, `farol_connector_verify_catalogue`, `computer_workspace_catalogue`, `codex_selected_thread_read`               | Empty targets. Catalogue entries, selected thread/turn IDs and provider text are excluded.                                                                                                                                                                                                                          |
| `operations/configuration.ts`: every `configurationOperation` command                                                                              | Only command `workspaceId`, optional `relativePath`, and Farol's fixed Git category/root directory are selected. The recorder resolves the ID; absent/unresolved workspace drops the path. Add labels, filesystem roots, exclusions, executable settings, thread IDs and other configuration payloads are excluded. |
| Same: every `configurationResultTarget` receipt                                                                                                    | Only receipt `workspaceId`, optional `relativePath`, and Farol's fixed Git category/root directory; the same recorder resolves against the updated owner configuration, including Add. No independent label substitution.                                                                                           |
| `bridge/computer.ts`, `connector-mutation.ts`, `connector-process.ts`, `connector-verification.ts`, `selected-codex-read.ts`                       | Go contract adapters return typed results, not operation targets. The enclosing MCP observer selects the fields above; Go response identifiers cannot add target fields.                                                                                                                                            |
| `operations/model-turn.ts`: Responses turn and compaction; `go-chat-browser.ts`: Consult send and turn                                             | Empty targets. Request/provider conversation, thread, turn, response and model-route identifiers are excluded.                                                                                                                                                                                                      |
| `src/apps/desktop/main.ts`: task configuration, Codex chat turns, backend/connector lifecycle, connection health/start/repair/stop, Hub start/stop | Empty targets. IDs and lifecycle/provider payloads are excluded; source/kind remain the closed vocabulary.                                                                                                                                                                                                          |
| `operations/updater.ts`: recovery/check/download/apply/apply-on-quit/restore/rollback                                                              | Empty targets. Update versions, build IDs and provider metadata cannot enter targets.                                                                                                                                                                                                                               |

The MCP table drives every registered tool, including retained, unknown, repeated,
refused, evicted and mismatched shell starts, with a configured ID, an unmatched
private sentence, and a label used as an ID. Configuration projection tables are
derived from every command and receipt discriminant. Store/recorder fixtures cover
record-time resolution, finish enrichment, private-index loading, missing
configuration and legacy read/export suppression. A disposable store-to-controller
renderer test verifies Activity data and rendered text. Existing model/browser and
updater fixtures exercise their empty-target projections. These are bounded source
and renderer fixtures, not live Go/provider, installed or native acceptance.

## Recording boundaries

| Operation kinds                                                                                                                                   | Source                 | Recording boundary                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------- |
| `computer_workspace_catalogue`, `computer_workspace_bootstrap`, `computer_workspace_list`, `computer_workspace_read`, `computer_workspace_search` | ChatGPT                | `createGoComputerMcpServer` final fenced handler outcome, through injected `OperationsRecorder` |
| `computer_workspace_write`, `computer_workspace_edit`, `computer_mutation_read`                                                                   | ChatGPT                | Same adapter, after Go contract result and final abort/drain classification                     |
| `computer_shell_start`, `computer_shell_read`, `computer_shell_cancel`                                                                            | ChatGPT                | Same adapter; executable name only, no command arguments/stdin/output                           |
| `computer_connection_status`, `farol_connector_verify`, `farol_connector_verify_catalogue`                                                        | ChatGPT                | Same adapter's existing Go verification contracts                                               |
| `codex_selected_thread_read`                                                                                                                      | Codex                  | Same adapter's selected read contract                                                           |
| `hub.start`, `hub.stop`, `hub.lifecycle`, `connection.lifecycle`                                                                                  | Setup / You for stop   | Existing main-process Go host startup, ordered Quit closure and original lifecycle observations |
| `connection.health`                                                                                                                               | Setup                  | Original explicit and background connector health checks                                        |
| `connection.start`, `connection.repair`, `connection.stop`                                                                                        | You / Setup for resume | Main process's original connector lifecycle functions, including automatic calls                |
| `chatgpt.open-sign-in`, `chatgpt.observe-sign-in`, `chatgpt.verify`, `computer.verify-workspace`, `computer.check-folder`                         | Setup                  | Validated `configureProduct` use-case boundary                                                  |
| `connector.*`, including health/attachment checks, client discovery/adoption, connect/start/stop                                                  | Setup                  | Same configuration boundary, including refused checks                                           |
| `computer.add-workspace`, `computer.remove-workspace`, `computer.update-access`, exclusions and file/command policy changes                       | You                    | Same configuration boundary; Add resolves the saved workspace label after success               |
| Other validated `computer.*`, `chatgpt.*`, `support.export`, settings commands                                                                    | You                    | Same configuration boundary; only named target metadata is selected                             |
| `host.*`, `model.*`, `task.*`                                                                                                                     | Codex                  | Configuration and task-command boundaries                                                       |
| `model.responses.turn`, `model.responses.compact`                                                                                                 | Codex                  | The original model handler and consumed SSE stream; event names only                            |
| `chatgpt.consult.send`, `chatgpt.consult.turn`                                                                                                    | ChatGPT                | Go Browser adapter's existing send contract and terminal observation callback                   |
| `chat.turn`                                                                                                                                       | Codex                  | Main process's validated preview-runtime terminal receiver                                      |
| `update.check`, `update.download`, `update.apply`, `update.apply-on-quit`, `update.recover`, `update.rollback`, `update.recovery-check`           | Updater                | Injected updater ports, including automatic and normal-Quit paths                               |

Go policy and execution remain behind existing published contracts. This packet
adds recording at their desktop adapters; it introduces no neighbour-internal
reads and changes no Go source or protocol bindings. The retired legacy MCP
fixture route is not an active Go-backed recording boundary.

The queue holds at most 1,024 waiting observations plus one in-flight batch of 64. Overflow evicts the oldest settled observation. Pending/unknown observations
already queued are protected; a queued start becomes evictable only when its
known terminal observation arrives. Every eviction increments the visible
"N entries were not recorded" counter. A completion whose start was evicted still
contains its lifecycle ID, target, outcome, code and duration. If every slot is
protected, new observations are rejected from the log, with explicit separate
counts for unrecorded pending/unknown observations; operations continue. This
bounds memory even under unlimited uncertain outcomes, without silent loss.
Counters describe observations, so a begin/completion pair can count twice.

Writes and sync failures never escape into operations. An uncertain/partially
written batch is not replayed; its observations are conservatively counted as
unconfirmed recording losses. Diagnostic persistence is attempted without a busy
retry loop. Later enqueues or a flush may publish updated counters, but never
replay lost observations. Retention failures count as log failures without
misclassifying an already flushed batch as lost.

Desktop Quit and MCP exit never await log durability: child drain, lease
retention/release, Quit receipts and run-marker handling keep their original
ordering and deadlines. The background writer may lose the newest tail even on
normal exit. An operations entry is not a clean-Quit receipt. Explicit store
shutdown (used by disposable writer fixtures) has a 250 ms default deadline and
reports false if stalled or if a write fails. Reaching that deadline does not cancel or replay a filesystem
operation. A crash or forced exit can lose the newest unflushed tail (the queued
observations and in-flight batch); only successfully synchronized batches are
durable. Asynchronous logging cannot guarantee a start survives a crash before
its first flush. Previously flushed observations remain immutable.

Snapshots use asynchronous reads, never prune, and never wait for the writer. A
100 ms read deadline returns the last snapshot with an unreadable-log diagnostic,
so a stalled profile disk cannot hang Activity or the support operation. Fresh
process-local loss counters are still included. Snapshot reads are coalesced to
avoid accumulating stalled reads. The support report is a point-in-time view,
not a flush acknowledgement.

The branch's operation-write audit covers `OperationsStore`, the desktop main
process recording/configuration/quit paths, the Go MCP adapter and stdio exit,
Go Browser consult callbacks, model/SSE and updater wrappers, preload/IPC, and
support export. All operation-log writes go through this appender; support-file
export already uses asynchronous FileHandle writes. No Go source or generated
protocol changes are needed.

Activity reads the same durable snapshot as Home's Recent activity. It offers
source/outcome filters, search and expandable details. Unknown/pending rows link
to Unresolved actions, without granting replay. Support export includes the same
validated metadata and diagnostics; its ordinary non-log fields retain a 64 KiB
bound, with a separate 12 MiB bound for a report containing a validated log.

## Evidence limits

`tests/unit/operations-log.test.ts` exercises use-case metadata/source mapping,
classified outcomes, restart, cap, 40-day quiet-profile retention, UTC day
rotation, legacy segments spanning the cutoff, missing/corrupt/stale index
rebuilds, future records and backwards clocks, corruption, unsafe files, privacy,
unmatched starts, SSE terminals and every updater port. Injected filesystem fixtures also
exercise stalled write/sync calls, nonblocking begin/completion, bounded shutdown
and snapshot deadlines, overflow/loss counters, protected-queue exhaustion,
orphan completions, error isolation, cross-writer diagnostics and FIFO rotation. The MCP table in
`tests/unit/go-computer-mcp.test.ts` invokes every registered tool through the SDK
with fabricated start/refused contract fixtures and asserts the exact content-free
target after recorder normalization. The recorder/export hostile-input matrix in
`operations-log.test.ts` then checks every external text field, legacy disk rejection,
owner metadata bounds and every approved code. It covers inherited shell targets, unmatched handles/IDs, a start without
a returned handle, refused/evicted starts, and retained IDs without relabeling.
These are policy/adapter fixtures, not live providers or native effects.

`tests/e2e/operations-log.e2e.mjs` runs the exact built app hidden with a disposable
profile, adds and verifies an actual temporary workspace, records a real refused
connection check, and restarts to verify log/sidebar persistence. Only the OS
folder picker is an explicit fixture. No signed-in ChatGPT/tunnel is available in
that profile, so it does not claim a live ChatGPT-side read. Screenshots and its
mode/cleanup report are under `_output/shell-screens/`. The shell-rail runner
provides separately labelled synthetic renderer/recovery screenshots.
