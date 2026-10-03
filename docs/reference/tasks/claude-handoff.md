# Claude task handoff: fixture-only

**State:** create/status implementation exercised through disposable shell/CLI/MCP
fixtures. Desktop issues **no production Claude grant**. Live Claude authentication,
billing, network, native background-session visibility, and complete descendant
cleanup are not qualified. [Status](../status.md) keeps this distinct from enabled
Computer and the optional Codex task route.

## Admission

`claude_task_create` and `claude_task_status` can be exposed by the existing sealed
Computer MCP only with a `claude-sandboxed-print/v1` fixture grant: read-only,
on-request, approved physical Git project/writer, and a verified workspace shell.
Ordinary folder access does not expose them.

The route reuses native Seatbelt shell/watchdog handles, with networking and
credential stores denied. There is no unsandboxed launcher or Codex fallback.
`tasks.harnesses.claude-code` in [config.json](../configuration.md) supplies
model aliases/effort; exact host allowlists and executable hash are checked before
dispatch. A local project label is not a verified Claude native project registry.

## One-shot dispatch and result

A UUID is both the dispatch handle and requested session ID. A private exclusive
journal reservation and fsynced intent precede process submission. Partial, corrupt,
unsafe, conflicting, or unreadable state remains unknown/refused; no alternate key
or process is used to recover an uncertain send.

Startup is `local-process-start`, not native background-task proof. Bounded NDJSON
observation requires exact session, writer cwd, actual model, and default permission
mode. Completion requires one supported final result **plus actual process exit**,
confirmed owned-group cleanup, no truncation, no timeout/signal/cancellation, and
matching identity. Permission denials report `needs_input` without granting/resuming.

Terminal evidence is retained in a bounded private receipt. Reconnect to the same
launch can read it; missing evidence after disconnect stays unknown. There is no
per-dispatch control/cancel tool. Computer lifetime and the absolute grant deadline
bound the owned print process, without claiming detached-descendant cleanup.

Uncertain intent/start publication or post-effect authority loss retains the mutation
fence. Successful release is followed by current physical/deadline readback before
disclosure. Age, PID absence, or an empty journal is not permission to steal a claim.

## Stream compatibility

Before `system/init`, the bounded parser admits only the known
`system/plugin_install`, `system/hook_started`, `system/hook_progress`, and
`system/hook_response` startup notifications. Their ignored payload cannot establish
identity, model, permission, or terminal result. A present foreign session ID refuses.

Unknown pre-init types, duplicate init, NUL, oversize, and mismatched sessions refuse.
These parser fixtures do not qualify live hooks/customizations or actual account
transport. Print structured output is distinct from a native background session;
no `--bg`, `--bare`, permission bypass, fallback model, latest-session lookup, or
profile copy is introduced by this route.

## Verify the fixture

From clean packaged bytes:

```sh
task package
node tests/e2e/claude-task-mcp.e2e.mjs --packaged
node tests/e2e/claude-task-mcp-fault.e2e.mjs --packaged
```

The tests run the built Computer MCP with a harmless CLI fixture, temporary Git
project/writer, and synthetic HOME. They spend no inference turn and load no user's
profile. Create/status, needs-input, actual exit, same-launch reconnect, and no
relaunch are checked through public MCP.

The harness captures each exact child before handshake and observes every child
exit before temporary-root cleanup. A reconnect failure cannot reuse an earlier exit
receipt. The fault driver preserves its original failure and records root removal
only after successful identity/cleanup proof.

## Remaining qualification

Live exposure needs supported host feature detection, independently qualified
sandbox/auth/network scope, actual model/effort and billing observation, serving
session identity, lifetime/cleanup proof, and explicit production admission. A
model flag, local schema, or fake CLI PASS supplies none of those by itself.

Source anchors: [Computer MCP entry](../../../src/apps/computer-mcp/main.ts),
[persistent Claude service](../../../src/modules/chat/app/service/persistent-claude-handoff.ts),
and [sandboxed print adapter](../../../src/modules/chat/infra/native/sandboxed-claude-print-host.ts).

---

[Native tasks](README.md) · [Documentation](../../README.md)
