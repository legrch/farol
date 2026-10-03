# Configuration and native model discovery

**State:** current selected-Codex task-route implementation with source/built/package
fixtures. The host's model catalogue is an observation, not proof of account identity,
entitlement, quota, or successful inference. This route is separate from the disabled
[Farol model provider](protocols/model-identity.md).

## One product configuration

The filename is **`config.json`** under the product profile's `farol-next-state/`.
For ordinary Farol on macOS, that profile is
`$HOME/Library/Application Support/Farol Next Preview`. Farol Dev has its separate
profile. Existing schema/revision and unrelated settings remain in the same document.

The following is only an illustrative **tasks subsection**, not a complete config or
an assertion that a model exists on your host:

```json
{
  "tasks": {
    "defaultHarness": "codex",
    "harnesses": {
      "codex": {
        "defaultModel": "primary",
        "models": {
          "primary": {
            "model": "configured-model-id",
            "defaultEffort": "high"
          }
        }
      }
    }
  }
}
```

Replace the example's concrete string/effort only with values explicitly configured
and supported by the selected host. A request can choose an alias and optional effort;
it cannot bypass the mapping. A new model needs policy plus host support. A new
harness also needs an implemented transport; the Claude route remains fixture-only.

Close all processes using that product profile before editing. Desktop and the sealed
connector load a snapshot; concurrent raw-file edits and hot reload are unsupported.
Configuration changes affect later launches/new tasks, not an existing dispatch's
binding. Ordinary Computer stays independent of missing task policy or discovery.

## Legacy filename

A fresh profile creates `config.json`. An existing `product-settings.json` produces
`CONFIG_RENAME_REQUIRED`, instead of silently creating defaults, merging, or overwriting
files. With all relevant processes closed, rename it in the same directory only if
`config.json` is absent. If both exist, reconcile deliberately before reopening.
Promotion also checks this obligation. Older builds cannot be assumed compatible
with the renamed file.

## Read the selected runtime catalogue

The task proxy queries `model/list` on its already-selected server. It does not start
a daemon or inspect a private model cache. The bounded reader requests
`includeHidden=true`, follows opaque cursors, and rejects malformed, cyclic,
duplicate, conflicting, oversized, or incomplete results.

Match a configured concrete model against **`Model.model`**, not `Model.id`, display
name, a substring, or an upgrade suggestion. Hidden entries remain labelled hidden;
explicit policy can select an exact reported hidden model. Reported effort order is
preserved without turning it into a quality ranking.

Read-only display has a connection-owned cache for up to 60 seconds. **Refresh models**
and `fresh=true` bypass it. A new task or continuation always gets a fresh bounded
catalogue read. Status/result, active-turn messaging, and confirmed same-key replay do
not silently resolve a new model. Client loss/replacement and supported account
notifications invalidate local scope; no account payload is retained.

Availability can change after observation. Codex may itself return cached/bundled
metadata. The UI reports what this runtime advertised, with yes/no/unknown availability,
not independently verified backend entitlement.

## Dispatch and durable binding

Creation validates physical/task authority and catalogue before the first durable
reservation or provider effect. Deadline/cancellation and physical authority are
rechecked after awaited claims and immediately before `thread/start` / `turn/start`.
Authority loss or uncertain publication after intent consumes that operation;
it cannot authorize another dispatch.

Effort selection is explicit request, then configured `defaultEffort`, then one
reported default. If the model advertises no effort, the parameter remains omitted.
The journal binds the resolved model/effort, alias, policy digest, and small catalogue
observation. It does not persist the full catalogue or authentication data.

The bounded dispatch-attempt protocol permits a next attempt only with immutable
proof of a known, non-cancelled pre-send refusal. Submission, lost acknowledgment,
failed proof, incomplete legacy state, or exhaustion remains unknown. No catalogue
or model fallback is performed. Known replay is checked before discovery so a later
model outage cannot rewrite an already-recorded result.

Continuation retains the original concrete model/effort and exact thread. A fresh
catalogue must still admit them; a removed model or unsupported effort refuses before
new continuation intent. Current config cannot silently migrate old work. An omitted
active-turn message effort retains its issued binding; an explicit conflict refuses.

## UI and MCP

`codex_task_models` takes only optional `fresh`; sealed admission owns host/workspace,
not arbitrary caller sockets/accounts/paths. Physical authority and expiry are checked
before and after the read.

Settings **Refresh models** uses the verified existing task route, observes its own
proxy cleanup, and starts no model turn. Standalone discovery before route selection
is not claimed. Provider labels render as text, not HTML.

## Source and verification

- [Product settings store](../../src/apps/desktop/product-configuration.ts)
  owns the persisted document contract.
- [Model catalogue policy tests](../../tests/unit/codex-model-catalogue.test.ts) cover
  parsing, bounds, exact selection, and cache rules.
- [Task discovery integration tests](../../tests/integration/task-model-discovery.test.ts)
  cover original binding, no-effect refusal, authority, and journal interactions.

Synthetic names/accounts and fake-server model lists are not live host qualification.
Run required source/package checks on exact bytes, then separately qualify the selected
serving host and user workflow. Discovery does not log in, restart a daemon, send a
ChatGPT message, or enable Product Agent.

---

[Reference](README.md) · [Documentation](../README.md)
