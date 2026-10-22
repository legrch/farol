# Farol identity inventory

This inventory describes current source contracts after the owner-approved
2026-10-22 rename. It records paths by responsibility rather than stale source
line numbers. The decision and exact edition identities are in
[identity cutover](identity-cutover.md).

| Responsibility                         | Source owners                                                                                                                                                                                                                                                                                               | Current contract                                                                 |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Product and resource ownership         | [resources.json](../resources.json), [resource contract](../tooling/resource-contract.mjs), [release identity](../tooling/release-identity.mjs)                                                                                                                                                             | `Farol`, `io.github.legrch.farol`, separate storage and runtime process          |
| Desktop editions and profile selection | [desktop environment](../src/apps/desktop/desktop-environment.ts), [Dev launcher](../tooling/dev.mjs), [Owner Preview contract](../tooling/owner-preview-contract.mjs)                                                                                                                                      | Production, Dev and Owner Preview stay isolated                                  |
| State and private child homes          | [desktop composition](../src/apps/desktop/main.ts)                                                                                                                                                                                                                                                          | `farol-state`, `farol-private`; no installed-profile mutation during source work |
| Renderer bridge and local storage      | [preload](../src/apps/desktop/preload.ts), [shell](../src/ui/shell.ts), [React entry](../src/ui/renderer/entry.tsx)                                                                                                                                                                                         | `window.farol`, `farol:` IPC, `farol.` storage keys                              |
| Connector tool registration            | [Computer MCP](../src/modules/computer/infra/mcp/create-readonly-computer-mcp.ts), [Go bridge adapter](../apps/desktop/bridge/computer-mcp.ts)                                                                                                                                                              | `farol_connector_verify`, `farol_connector_verify_catalogue`, `farol_host_tools` |
| Caller correlation and smoke           | [Go Responses adapter](../apps/desktop/go-chat-responses.ts), [caller lifecycle](../modules/chat/app/services/lifecycle/caller.go), [host smoke](../src/apps/desktop/codex-host-smoke.ts)                                                                                                                   | `farol_call_`, `farol_ping`; all pins and producers agree                        |
| Model route                            | [model routing](model-routing.md)                                                                                                                                                                                                                                                                           | Only `farol` / `chatgpt` is the canonical public pair                            |
| Package generations                    | [package layout](../tooling/package-layout.mjs), [Python archive reader](../resources/native/update_archive.py), [Go archive reader](../modules/release/infra/archive/archive.go)                                                                                                                           | Current `Farol.app`; explicit legacy schema-5 input name                         |
| Tree encoding                          | [TypeScript digest](../src/pkg/artifact-tree-digest/digest.ts), [Go app tree](../modules/release/infra/native/apptree/filesystem.go), [promotion helper](../tooling/promotion-apply.py), [update helper](../resources/native/update_helper.py), [closed repair helper](../tooling/closed-preview-repair.py) | `farol.tree-digest/v2`, unchanged record format, updated static golden digests   |
| Shell and derivative validation        | [shell support](../apps/desktop/bridge/shell-support.ts), [platform declaration](../tooling/shell-platform.json), [signed derivative](../tooling/signed-derivative-contract.mjs), [archive preparation](../tooling/prepare-release-archive.py)                                                              | Same digest generation as producers                                              |
| Legacy profile sources                 | [Alpha identity](../modules/release/domain/migration/identity.go), [closed repair](../tooling/closed-preview-repair.mjs), [retirement](../tooling/retire-preview-install.mjs), [preservation](../tooling/supervised-update-backup.mjs)                                                                      | Explicit old-beta selectors and matching opaque-state fixtures                   |

Current environment keys use `FAROL_`; support exports use `Farol-Support-*.json`
and kind `farol_support`. The npm package is `farol`; its packaged app package is
`farol-app`. Temporary names and internal protocols use the same product spelling.
Pagination, iterators, Next.js and unrelated `vnext` placeholders keep their own
meaning.

The only old-beta spelling permitted outside frozen history is an explicit legacy
reader constant, its fixture, or a negative drift test. Reproduce the inventory
from tracked source, excluding frozen documentation:

```sh
git grep -n -i -E 'farol.?n[e]xt|profile-isolated-n[e]xt|n[e]xt-partition' \
  -- . ':!docs/archive'
```

A clean source inventory does not establish package, installed or live acceptance.
