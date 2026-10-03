# Recorded architecture decisions

This register points to choices already recorded in repository policy and accepted
source. It does not create new product decisions or convert a planned route into
released behavior.

| Choice                                                    | State                                                 | Authority and explanation                                                                                                                      |
| --------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| React UI, TypeScript desktop/browser adapters, Go backend | Accepted migration target; gradual capability cutover | [AGENTS.md](../../../AGENTS.md), [migration](../migration.md)                                                                                  |
| Consumer-owned ports and published neighbor contracts     | Accepted dependency rule; current import gates        | [AGENTS.md](../../../AGENTS.md), [boundaries](../boundaries.md)                                                                                |
| Keep product identity and state/receipt compatibility     | Current compatibility boundary                        | [resources.json](../../../resources.json), [profiles](../../reference/profiles.md)                                                             |
| Permanent `farol` / `chatgpt` route identity              | Accepted naming; provider route still disabled        | [Feature gates](../../../src/apps/desktop/foundation-feature-gates.ts), [model identity](../../reference/protocols/model-identity.md)          |
| Exact-operation recovery without blind replay             | Current effect/recovery contract                      | [Computer capabilities](../../reference/computer/capabilities.md), [authority](../authority.md), [updater](../../reference/updates/runtime.md) |

When a later accepted decision changes one of these rules, update the owning
explanation, reference, and status evidence together. Historical maintenance
procedures stay in [Maintenance](../../maintenance/README.md) while applicable.

---

[Architecture](../README.md) · [Documentation](../../README.md)
