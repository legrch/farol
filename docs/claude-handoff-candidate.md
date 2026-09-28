# Claude handoff candidate

This is the N4 create/status port of useful V0 behavior. It is **fixture-qualified,
not live Claude/native UI parity**. Computer, the existing Codex shared proxy,
Setup/Model launcher, Model and Product Agent are unchanged.

## Route and authority

`claude_task_create` and `claude_task_status` use the existing Computer MCP server,
sealed launch, approved writer, physical canonical Git repository and private
mutation fence. A generic folder read does not expose them. The desktop issuer
currently emits **no Claude grant**. A sealed `claude-sandboxed-print/v1` grant is
accepted only as `fixture-only`, read-only, on-request and an explicitly verified
Computer workspace shell. The implementation reuses the existing Seatbelt shell
and its owned watchdog/handles; there is no raw spawn or unsandboxed fallback.

Selection uses `tasks.harnesses.claude-code` in existing product-settings, with a
configured alias and optional explicit effort. The named Claude route selects that
harness without changing `tasks.defaultHarness` or falling back to Codex. Host
model/effort allowlists and exact executable hash are checked before dispatch.
The sealed projectId is a local owner target label, not a verified Claude native
project registry. Each durable intent preserves its original model/configuration
binding and both physical roots. A later settings edit does not reinterpret an existing result.

A UUID is both the dispatch handle and requested session ID. The private journal
claims one directory and publishes/fsyncs an intent before process submission.
Missing directory is absence. Empty/partial/corrupt, unsafe permission, symlink,
hardlink or FIFO records are unknown/refused; they never authorize another start.
Concurrent claim and a lost start/publication acknowledgement cannot duplicate the
process. `create` replay remains unknown rather than claiming another dispatch.
Read status; never use another key to recover an uncertain send.

## Evidence and limitations

Startup is only `local-process-start`. A bounded NDJSON observation verifies the
init session, writer cwd, actual model and default permission mode. Completion
requires exactly one supported final result **and actual process exit**, confirmed
owned group cleanup, no truncation, no signal/timeout/cancellation and matching
identity. Permission denials report `needs_input`, with no grant/resume/retry.
Terminal results have a bounded private receipt; reconnect on the same launch can
read that historical terminal evidence. There is no per-dispatch control/cancellation tool yet; owned runtime shutdown and
the absolute grant deadline bound these fixture processes. No receipt after disconnect is
`outcome_unknown`, not permission to relaunch. This owned print process is coupled
to Computer lifetime; it does not claim native background/shared-task continuity.

The normal sandbox denies network and credential stores. There is no actual
Claude authentication/billing/session visibility qualification. Native host
feature detection, supported sandbox/auth scope and a separate exact owner budget
are required before live exposure. A model flag or fixture result does not qualify
actual effort, subscription billing, native session persistence or shared Desktop
visibility. Full detached-descendant cleanup remains **NOT_QUALIFIED**.

CLI decisions follow the official [headless contract](https://code.claude.com/docs/en/headless)
and [CLI reference](https://code.claude.com/docs/en/cli-reference), checked 2026-09-28:
print structured output/session IDs are distinct from native background sessions;
`--print` is not combined with `--bg`. No `--bare`, API-key environment,
`bypassPermissions`, fallback model, latest-session lookup or profile copying is
introduced. Normal print context can load customizations; fixture isolation is
not proof of a safe live owner customization setup. Unsupported host fields/flags
must be qualified against the selected installed host, never guessed from docs.

## Verification

Source tests include lost acknowledgement, concurrent dispatch, exact stream and
physical/policy correlation, expiry/revocation, journal crash states and private
file types. `tests/e2e/claude-task-mcp.e2e.mjs` invokes the **built/package Computer
MCP**, a disposable Git project/linked writer and a harmless shell CLI fixture.
It proves create/status, actual exit, needs-input, same-launch reconnect and no
relaunch from the existing key. It spends zero inference turns and touches no
owner profile. Its fixture HOME is explicitly synthetic, not an assertion about
the owner's installed Claude or ordinary Git settings.

Build from clean committed bytes with `task package`, then run:

```sh
node tests/e2e/claude-task-mcp.e2e.mjs --packaged
```

No fixture PASS is transferred to the actual ChatGPT/new connector or installed
Farol. The frozen owner minimum and all prior failed/native receipts remain valid
for their own exact artifacts.
