# Module boundaries

Understand how code and contracts remain owned during the TypeScript/Go transition.
[AGENTS.md](../../AGENTS.md) is the accepted repository policy.

## Dependency rules

Pure domain/application layers depend on values and consumer-owned ports. They do
not perform filesystem/network operations, import host APIs, read ambient clocks,
or locate services globally. Infrastructure implements the ports; boot injects
concrete implementations and owns lifetimes.

| Boundary           | TypeScript under `src/`                                                     | Go target                                                                                                      |
| ------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Published surface  | `contract`: boundary DTOs/schemas without app/domain implementation imports | `contracts/<feature>`: thin owning facade that delegates to its app with independent DTOs and explicit mapping |
| Neighbor access    | Consumer `infra/peer` to neighbor `contract`                                | Consumer `infra/peer` to neighbor `contracts`                                                                  |
| Forbidden crossing | Neighbor domain/app/infra and executable hosts                              | Neighbor internals, infrastructure leakage, boot/host imports into contracts                                   |
| Composition        | `src/boot/`                                                                 | Root `boot/`                                                                                                   |

The Go facade rule does not change the legacy TypeScript DTO-only contract rule.
Import gates enforce dependency edges. Review still verifies facade delegation,
independent DTO signatures, no implementation aliases, and explicit conversion;
an import check alone does not prove those properties.

Kernel infrastructure requires at least two real consumers with identical
semantics. Shared implementations own no mutable cross-consumer singleton. No Go
module imports kernel infrastructure; boot injects its ports. The existing
TypeScript clock is shared by Chat and Computer through separate injected instances.
Generic SSE framing is transport code under `src/pkg/sse/`, not kernel policy.

## Enforcement and evidence

[TypeScript architecture tooling](../../tooling/check-architecture.mjs) rejects invalid
imports, dynamic loaders, cycles, unclassified source, and forbidden UI/host edges.
[Go tooling](../../tooling/check-go-architecture.mjs) enforces the accepted Go imports.
`task test:core` includes generation, race/vet, protocol, and bridge compilation;
`task ci:fast` adds the complete deterministic source gate.

Source tests, native temporary-workspace tests, app fixtures, packaged acceptance,
and live provider/installed behavior are different claims. [Testing](../development/testing.md)
explains how reports keep those boundaries visible.
---

[Architecture](README.md) · [Documentation](../README.md)
