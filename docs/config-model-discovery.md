# Configuration and runtime model discovery

This candidate extends the existing task route; it does not replace the harness
configuration or introduce a second task service. Configured policy is intent.
The selected Codex App Server's `model/list` is a runtime observation, not proof
of account identity, entitlement, quota, or successful inference.

## One configuration file

The filename is **config.json**, in the existing isolated preview state root:
`<Farol Next Preview userData>/farol-next-state/config.json`. Bundle IDs, state
roots, browser partitions and V0 paths do not change. Internal
`ProductSettingsStore` and schema names stay stable to avoid an unrelated API
rename. The existing schema/revision and other settings remain in the document.

Only the task policy subsection is shown here. This is illustrative data, not a
claim that these models are currently available on any particular account:

```json
{
  "tasks": {
    "defaultHarness": "codex",
    "harnesses": {
      "codex": {
        "defaultModel": "luna",
        "models": {
          "luna": { "model": "gpt-6-luna", "defaultEffort": "high" },
          "sol": { "model": "gpt-6-sol", "defaultEffort": "high" }
        }
      }
    }
  }
}
```

No lead/worker profiles or compiled model-name enum is added. Explicit selections
may override alias and effort, but never bypass the configured harness/model
mapping. Adding a model to a supported harness needs only a config edit and a
supported restart/reload, not a new binary. A new harness still needs implemented
transport support. The Claude fixture-only route is not enabled by this change.

Close the preview before editing. The store and sealed connector load a snapshot;
editing the file behind a running app is not a supported hot-reload mechanism.
A normal fresh install produces only config.json. If product-settings.json exists,
startup and writes report CONFIG_RENAME_REQUIRED rather than creating defaults,
merging sources, or overwriting either file. With **all preview processes closed**,
the owner may rename the old file to config.json in the same directory if the
new name is absent. If both exist, reconcile them deliberately before reopening.
No automatic migration or installed-profile edit is performed. Promotion also
checks the old filename so pending obligations cannot disappear during the rename.
Do not run an older preview against the renamed state and expect compatibility.

## Runtime catalogue

The shared task proxy permits `model/list` against its selected existing server.
It never starts a replacement daemon or reads a private models cache. The bounded
reader requests includeHidden=true, follows opaque cursors, limits pages/entries,
and rejects malformed, cyclic, duplicate or conflicting catalogue data.

Match the configured concrete string against **Model.model**, never Model.id,
displayName, substring, upgrade suggestion or another configured alias. Model.id
is retained as catalogue metadata only. Supported effort order is not sorted or
converted into an assumed quality ranking. Hidden entries remain visible as such;
explicit configuration may select an exact reported hidden model.

The first version uses one connection-owned in-memory cache for read-only display,
up to 60 seconds. Explicit Refresh models and fresh=true bypass it. Every new
create or continuation performs a new bounded model/list read; it never admits
work using the display cache. Status, result, active-turn message and confirmed
same-key replay do not trigger discovery or a new model selection. An active-turn
message with omitted effort retains its issued effective binding; an explicit
conflicting effort refuses before steering. The message intent digest still
distinguishes omitted and explicit caller values for exact-key replay.

The local cache scope changes on client replacement/loss and supported account
notifications. No account payload is retained. A local epoch is not a server PID,
an account ID, or proof of shared Codex Desktop ownership. Delayed refreshes cannot
overwrite a newer display result. Availability may still change after discovery;
the existing no-provider-fallback request and exact thread-model checks remain.
Codex itself may serve a cached or bundled catalogue. The UI therefore reports
what this runtime advertised, not an independently refreshed backend entitlement.

## Dispatch, effort and durable binding

Creation validates physical/task authority and checks the catalogue before its
first durable reservation or provider effect. Trusted MCP cancellation and its
bounded deadline travel through the admitted route and catalogue read; a cancelled
request cannot reserve new work after discovery. Physical authority is checked
again after each awaited durable claim, immediately before thread/start or
turn/start. Cancellation, revocation or root replacement after a durable intent
leaves an outcome-unknown consumed operation, never permission to dispatch again.
Once a thread binding is durable, create consumes turn intent before awaited
preflight. Continuation consumes a cancelled intent before returning unknown,
while preserving known pre-effect fence recovery for non-cancelled requests.
A failed journal write remains unknown, never permission to send. An absent model or unsupported
effort reports the configured values and bounded reported alternatives. A failed
or partial catalogue is availability **unknown**, never absence and never a
reason to use a fallback model.

Explicit effort wins, then configured defaultEffort. If both are omitted, a
reported model default is resolved once and recorded as the effective effort.
A model which actually advertises no effort keeps the parameter omitted. Old
unbound records are not retroactively assigned today's provider default.

The journal keeps the original intent digest and the resolved model binding.
Only a small catalogue observation (entry ID, local scope, observed time) is
retained, not the complete catalogue or authentication data. Concurrent requests
with different observed defaults cannot substitute for the journal winner's
binding. Known replay is checked before discovery, preserving historical results
when a model later disappears or the runtime becomes unavailable.

Continuation resolves no alias from current settings. It checks the original
model/effort against a fresh catalogue and sends them explicitly to the same
thread. A removed model or unsupported original effort refuses before another
continuation reservation. Configuration edits never silently migrate existing
work. Catalogue epoch/deadline checks fence the bounded path to provider sends;
this is not an atomic lock on the remote catalogue or on another native client.

## Read-only views

`codex_task_models` uses the same catalogue and configured aliases. Its input is
only an optional fresh boolean. The sealed route supplies the host and workspace;
the caller cannot select an arbitrary socket/account/path. Physical authority and
expiry are checked before and after the read. The typed response separates
configured models, yes/no/unknown availability, effort support, and runtime time.

Settings has Refresh models under the existing verified Codex task route. It
opens only a proxy client to that same selected endpoint, requests the catalogue,
waits for its own client cleanup and reports a snapshot. It starts no model turn
and never modifies the config. This initial UI requires an already selected task
route; standalone onboarding discovery before route selection is not claimed.
All labels are rendered with textContent, including provider-supplied names.

## Tests and integration boundary

Tests cover the pure bounded reader, cache invalidation, malformed/paginated
results, exact model/effort selection, missing/unknown distinction, original
binding continuation, no-effect refusal, concurrent default race, real private
journals, actual in-memory MCP requests, and the config/promotion filename checks.
The packaged fake-server driver also understands model/list. Synthetic model names
and mocked account epochs are not live account evidence.

Before production acceptance, run the repository gate and independent review on
exact committed bytes, then the packaged task route and native Settings refresh
with an explicitly qualified serving host. Preserve the prior native/sandbox
blockers: the separate experimentalApi patch is not included or retried here.
No install, account login, daemon restart, automatic Send or V0 cutover is part of
this candidate. Ordinary Computer remains independent of missing task policy or
model discovery failure.

Protocol reference: [Codex App Server](https://developers.openai.com/codex/app-server),
model/list and thread/turn lifecycle; checked 2026-09-28. Compare the selected
installed host schema before treating newer documented fields as implemented.
