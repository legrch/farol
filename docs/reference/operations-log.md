# App operations log

The desktop records content-free operation observations in the current profile's
`farol-state/operations/` directory. It never uses a global state directory.
Production, Dev, Owner Preview and disposable test profiles keep their existing
identity isolation.

## Storage and outcomes

Each writer appends JSON lines to its own timestamp/UUID segment, rotating at
64 KiB. The directory is mode 0700; regular single-link files are mode 0600 and
opened without following symlinks. Appends are synchronized before returning.
Retention deletes complete oldest segments after 30 days, 8 MiB or 20,000 raw
records. Whole-segment deletion can retain fewer than the maximum. Readers skip
and count invalid lines, unsafe files and oversized segments. Logging failures
are counted and shown without changing the original operation's result.

The closed schema stores time, source, operation kind, workspace label, relative
path, executable name, outcome, stable code and duration. The optional lifecycle
field contains only a UUID and started/observed phase. The names-only workspace
label index is atomically replaced in the same private directory; it grants no
access. Commands exclude arguments; search patterns, file contents, prompts,
replies, credentials and raw exception text are never projected.

An admitted operation appends a start observation before execution. An unmatched
start remains pending across restart. Its separately appended observation supplies
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

Activity reads the same durable snapshot as Home's Recent activity. It offers
source/outcome filters, search and expandable details. Unknown/pending rows link
to Unresolved actions, without granting replay. Support export includes the same
validated metadata and diagnostics; its ordinary non-log fields retain a 64 KiB
bound, with a separate 12 MiB bound for a report containing a validated log.

## Evidence limits

`tests/unit/operations-log.test.ts` exercises use-case metadata/source mapping,
classified outcomes, restart, cap, corruption, unsafe files, privacy, unmatched
starts, SSE terminals and every updater port. The MCP table in
`tests/unit/go-computer-mcp.test.ts` invokes each registered tool's actual adapter
callback with a refused contract fixture and asserts one content-free observation.
These are policy/adapter fixtures, not live providers or native effects.

`tests/e2e/operations-log.e2e.mjs` runs the exact built app hidden with a disposable
profile, adds and verifies an actual temporary workspace, records a real refused
connection check, and restarts to verify log/sidebar persistence. Only the OS
folder picker is an explicit fixture. No signed-in ChatGPT/tunnel is available in
that profile, so it does not claim a live ChatGPT-side read. Screenshots and its
mode/cleanup report are under `_output/shell-screens/`. The shell-rail runner
provides separately labelled synthetic renderer/recovery screenshots.
