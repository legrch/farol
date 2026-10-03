# Understand Farol's architecture

Farol combines a native desktop shell, browser surfaces, scoped local Computer
access, and explicit operation recovery. Read the running system before the
migration target.

## Follow the design

1. [Runtime architecture](runtime.md) — processes, communication, browser overlays,
   and shutdown ownership.
2. [Authority and recovery](authority.md) — approval, task scope, durable intent,
   and unknown outcomes.
3. [Module boundaries](boundaries.md) — pure layers, published contracts, consumer
   ports, composition, and enforcement.
4. [Go and React migration](migration.md) — target responsibilities and the exact
   source/installed cutover boundary.
5. [Recorded decisions](decisions/README.md) — accepted choices and their authority.

## Choose the right level of detail

| Question                                       | Page                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| Which process owns a browser view or helper?   | [Runtime](runtime.md)                                            |
| Why does an unknown operation stay blocked?    | [Authority](authority.md)                                        |
| What may one module import from another?       | [Boundaries](boundaries.md)                                      |
| What is being moved into Go and React?         | [Migration](migration.md)                                        |
| Why do the sidebar and overlays work this way? | [Desktop design](desktop-design.md)                              |
| Which fields or frames cross the Core pipe?    | [Desktop/Core reference](../reference/protocols/desktop-core.md) |
| What is enabled in the published beta?         | [Current status](../reference/status.md)                         |

These pages explain responsibilities and rationale. Exact API, configuration,
capability, wire, and update facts live in [Reference](../reference/README.md).
Build and qualification procedures live in [Development](../development/README.md).

---

[Documentation](../README.md)
