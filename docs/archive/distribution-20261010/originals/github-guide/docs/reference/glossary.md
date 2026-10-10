# Glossary

Use these terms consistently in guides, contracts, and status reports.

| Term            | Meaning in Farol                                                                          | Detail                                                                       |
| --------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Computer        | Local workspace access and effect policy exposed through the selected MCP connection      | [Capabilities](computer/capabilities.md)                                     |
| Workspace       | An approved physical root with an actual workspace ID, permissions, and exclusions        | [Context](computer/workspace-context.md)                                     |
| Task grant      | The current task-derived authority; a request or instruction cannot enlarge it            | [Authority](../architecture/authority.md)                                    |
| Native task     | Coding work admitted through an exact host/project/workspace route                        | [Tasks](tasks/native-tasks.md)                                               |
| Turn            | Chat-owned conversation/stream work with correlated identity and lifetime                 | [Migration ownership](../architecture/migration.md#product-module-ownership) |
| Browser adapter | Desktop-owned public-page observation and submission behind Chat's consumer ports         | [Browser](protocols/browser-adapter.md)                                      |
| Core            | The additive Go backend composition/transport checkpoint; not the active desktop executor | [Desktop/Core](protocols/desktop-core.md)                                    |
| MCP             | Model Context Protocol; the tool connection used by Computer through the selected tunnel  | [Connection](../start/first-connection.md)                                   |
| Receipt         | Operation-specific correlated evidence; its meaning depends on the owning route           | [Authority](../architecture/authority.md)                                    |
| Outcome unknown | An effect may have happened without trustworthy completion or cleanup evidence            | [Recovery](../guides/troubleshooting.md#an-operation-has-an-unknown-outcome) |
| Candidate       | Verified package built from clean committed inputs, before installed/live acceptance      | [Packaging](../development/packaging.md)                                     |
| Profile         | Environment-owned configuration, browser, connector, and instance state                   | [Profiles](profiles.md)                                                      |
| Fixture         | A controlled test composition with declared simulated boundaries                          | [Evidence classes](../development/testing.md#evidence-classes)               |
| Released        | Named published bytes bound to release metadata, not merely a source package version      | [Status](status.md)                                                          |
| Accepted target | A decided future architecture whose capabilities still need individual cutover            | [Migration](../architecture/migration.md)                                    |
| Not qualified   | Required acceptance evidence is absent or incomplete; it is not PASS                      | [Testing](../development/testing.md)                                         |

---

[Reference](README.md) · [Documentation](../README.md)
