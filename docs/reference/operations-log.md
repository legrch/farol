# App operations log

The desktop records content-free operation observations in the current profile's
`farol-state/operations/` directory. It never uses a global state directory.
Production, Dev, Owner Preview and disposable test profiles keep their existing
identity isolation.

## Storage and outcomes

Each writer appends JSON lines to its own timestamp/UUID segment, rotating at
64 KiB. The directory is mode 0700; regular single-link files are mode 0600 and
opened without following symlinks. Recording is observability: `begin`, its
completion callback and `record` validate bounded metadata, enqueue, and return
without filesystem work. One asynchronous writer per store processes FIFO batches
of at most 64 observations, synchronizing once per batch/rotated segment. Directory
preparation, label replacement, tail repair, retention and diagnostics all use
asynchronous filesystem APIs on that writer.
Retention deletes complete oldest segments after 30 days, 8 MiB or 20,000 raw
records. Whole-segment deletion can retain fewer than the maximum. Readers skip
and count invalid lines, unsafe files and oversized segments. Logging failures
are counted and shown once as aggregate diagnostics in Activity and support export,
without changing the original operation's result. No raw filesystem error text is
recorded. Per-writer private diagnostic sidecars expose MCP-process counts after
a successful write, survive restart, and have a separate 64 KiB/30-day bound. If
the disk cannot store even diagnostics, counts remain in that process's memory;
no logger can promise durable evidence on an unavailable disk.

The closed schema stores time, source, operation kind, workspace label, relative
path, executable name, outcome, stable code and duration. The optional lifecycle
field contains only a UUID and started/observed phase. The names-only workspace
label index is atomically replaced in the same private directory; it grants no
access. Commands exclude arguments; search patterns, file contents, prompts,
replies, credentials and raw exception text are never projected.

Shell read/cancel observations inherit the dispatched start's workspace, relative
directory and executable name by original operation ID, checking the returned
handle when available. This server-local metadata cache keeps at most 1,024
starts, excludes proven refusals and never relabels a retained ID. For an unknown, evicted or
previous-connection start, the target contains only the supplied handle and
`start: "unknown"`; Activity displays that limitation. This lookup grants no
execution authority and never reads command arguments, stdin or output.

An admitted operation enqueues a start observation before execution. A flushed
unmatched start remains pending across restart. Its separately appended observation supplies
the actual result; the raw start line is never edited. Activity folds only such
matched start markers. Explicit unknown and pending results remain immutable,
including after a later independent read-back. A helper ACK is pending, not proof
that an update was installed. No logger invokes retries or reconciliation.

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

Desktop normal Quit flushes after child drains, within the existing overall Quit
budget; the Go MCP adapter flushes after its handler drain on either exit path.
Each store's shutdown flush has a 250 ms deadline and reports false if stalled or
if a write fails. Reaching that deadline does not cancel or replay a filesystem
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
classified outcomes, restart, cap, corruption, unsafe files, privacy, unmatched
starts, SSE terminals and every updater port. Injected filesystem fixtures also
exercise stalled write/sync calls, nonblocking begin/completion, bounded shutdown
and snapshot deadlines, overflow/loss counters, protected-queue exhaustion,
orphan completions, error isolation, cross-writer diagnostics and FIFO rotation. The MCP table in
`tests/unit/go-computer-mcp.test.ts` invokes every registered tool through the SDK
with fabricated start/refused contract fixtures and asserts the exact content-free
target. It covers inherited shell targets, unmatched handles/IDs, a start without
a returned handle, refused/evicted starts, and retained IDs without relabeling.
These are policy/adapter fixtures, not live providers or native effects.

`tests/e2e/operations-log.e2e.mjs` runs the exact built app hidden with a disposable
profile, adds and verifies an actual temporary workspace, records a real refused
connection check, and restarts to verify log/sidebar persistence. Only the OS
folder picker is an explicit fixture. No signed-in ChatGPT/tunnel is available in
that profile, so it does not claim a live ChatGPT-side read. Screenshots and its
mode/cleanup report are under `_output/shell-screens/`. The shell-rail runner
provides separately labelled synthetic renderer/recovery screenshots.
