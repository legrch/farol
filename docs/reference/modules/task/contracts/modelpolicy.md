# Configured Task model policy

The selected desktop Task setup path resolves configured harness, model alias,
runtime model and effective effort through `app/services/modelpolicy`. The Go
owner also computes the unchanged `farol-task-policy/1` semantic SHA-256. The
compiled supported-harness list comes from trusted boot, never from a request.
There is no account, permission, entitlement or runtime catalogue inference.

The published `contracts/modelpolicy` boundary maps independent DTOs to that
application service. Trusted boot composes the deterministic JSON decoder and
SHA-256 adapter and registers the read-only `task.model.resolve` method. This
pure method is available without opening a native Task/profile/provider owner;
normal Task lifecycle and MCP tools remain disabled/unregistered separately.

The request carries the exact settings revision, configured policy and requested
selection. Missing/null policy, invalid policy, invalid request, missing harness,
unsupported harness and missing model keep their existing resolution order.
Missing effort uses the configured default only; a model catalogue cannot supply
another default. The output carries a binding only for `ready`. Alias/harness
ordering does not change identity; changes to any configured model do.

Raw policy is bounded to 1 MiB and selection to 4096 bytes, including whitespace;
the enclosing existing desktop frame limit also applies. JSON rejects unknown
or duplicate keys, malformed UTF-8, unpaired surrogate escapes, explicit null
optionals and invalid value types. Names, models, efforts and counts retain the
existing ASCII rules. These raw-input restrictions are stronger than accepting
an already parsed JavaScript object; there is no Unicode replacement or fallback.

TypeScript retains Electron/pipe adapters, response-shape and correlation checks,
and the existing settings writer's revision/exclusion fence. Setup resolves once
before native observation and resolves freshly again in the serialized settings
turn before saving the selected route. Each read is one original request; an
unavailable, lost, crossed or stale reply refuses without a TS resolver or retry.
The initial settings revision must still match at route publication. No await
may move an old binding onto a newer revision.

The old TS resolver remains for explicitly retained compatibility consumers and
tests. The [current-settings comparison](currentsettings.md) separately reuses
full policy identity. Catalogue projection and Chat identity projections still
require their own Go cutover. The selected setup/save calls no
longer execute that resolver. This capability does not activate Task creation,
message, continuation or cancellation.

Portable tests cover exact Go/TS policy vectors and a real inherited-pipe Go
process, response correlation, revision loss, settings-writer exclusion and
absence of fallback. Those tests do not qualify packaged/installed Task setup,
native account/host authority or actual provider operations.
