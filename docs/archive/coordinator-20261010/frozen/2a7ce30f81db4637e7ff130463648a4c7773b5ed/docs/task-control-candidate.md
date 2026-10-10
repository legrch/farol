# Unified task model settings and task control candidate

Status: implementation candidate, not a live-qualified release. The production
composition leaves message/continue capabilities off pending host qualification.

## One configuration document

Use the existing `product-settings.json` in the application's isolated state
root. Add a `taskModels` section; do not introduce `models.json`, a second
`config.json`, an environment overlay or a second configuration loader.

Example section, to merge into the existing JSON rather than replace it:

```json
{
  "taskModels": {
    "defaultProfile": "worker",
    "profiles": {
      "lead": { "model": "gpt-6-sol", "effort": "xhigh" },
      "worker": { "model": "gpt-6-luna", "effort": "high" },
      "light": { "model": "gpt-6-luna", "effort": "low" }
    }
  }
}
```

Names in the example are data, not a product enum or proof of provider
availability. The normal host route must qualify the selected model/effort.
The stable Farol provider/model identity is independent of these upstream IDs.

`ProductSettingsStore` remains the only disk reader/writer. `owner-config.ts`
projects one loaded settings snapshot; it does not open another file. Settings
show a profile selector instead of hard-coded model/effort defaults. The desktop
configuration handler and launch-contract builder actually consume this section.
The selected model, effort, profile and policy digest travel in the launch grant.
Unrelated changes to setup/revision do not change that policy digest.

For this candidate, edit the subsection with the new app stopped, then restart
it and recreate its connector launch. Do not overwrite unrelated settings,
authority or readiness fields. There is no file watcher or promise that editing a
running app's JSON is safe from concurrent saves. Preview persistence paths and
bundle identities are deliberately unchanged; the V0 config is not read or edited.

Malformed/missing model policy disables task admission, not independent Computer
settings. A missing profile never chooses another profile or provider. MCP callers
may omit model/effort; the admitted route supplies the configured exact values.
Explicit model/effort arguments are matching assertions, not overrides.

## Message versus continuation

- Message sends one `turn/steer` to the issued dispatch's exact thread and turn.
  The provider receives `expectedTurnId`; there is no fallback to `turn/start`.
- Continue records one new dispatch in the same thread after the selected parent
  completed. It explicitly uses the parent's retained model/effort.
- Observation and result retrieval never start another turn.
- Owner-created/native tasks still need explicit adoption; title matching is not
  a control grant. This candidate does not implement arbitrary chat lookup.

A message reservation is NOT permission to send. A separate atomic durable
`send-intent` claim chooses one sender across concurrent same-key callers.
An accepted receipt is replayed even after the original turn completes. A lost
acknowledgement is not replayable as a new send.

Continuation retains its completed dispatch receipt even when a newer turn is
active. A parent-turn reservation prevents two Farol keys from issuing separate
continuations from the same parent, including after an unknown acknowledgement.
It never creates a second thread. Old records without a retained model binding
cannot be continued by guessing a provider default.

## Boundary that remains unqualified

A local parent reservation does not serialize a native Codex client that does not
participate in it. The examined `turn/start` contract does not supply a documented
expected-parent compare-and-set field. The current pre/post history checks can
detect some races but cannot undo an already submitted message. Do not advertise
atomic cross-client continuation from these checks.

Consequently `AdmittedCodexTaskRoute` defaults both control capabilities to false,
and MCP omits those tools unless a host-qualified composition supplies them.
These flags are not caller inputs or user configuration escape switches.

Before enabling message: qualify the exact serving `turn/steer` request/response,
expected-turn rejection and active dispatch admission. Before enabling continue:
qualify the shared-client idle/start semantics or implement a supported serialized
provider operation. Retain clear scope if the provider cannot offer a stronger
contract. No raw IPC, private database edits, duplicate task or hidden runtime.

## Verification boundary

Targeted tests exercise the real MCP in-memory transport, the existing settings
store and real temporary filesystem journals. They are not model inference,
packaged transport, installed-connector or full native acceptance.

Keep source checks, process cleanup, complete CI, package verification and live
qualification separate. Do not treat a threads-pool pass as repair of a refused
fork-worker cleanup operation. The candidate has not been installed or released.

Primary protocol reference checked 2026-09-27:
https://developers.openai.com/codex/app-server/
