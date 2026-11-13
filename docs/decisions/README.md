# Architecture decisions

Accepted Farol architecture decision records. Each record states its scope,
the alternatives it rejected and how existing code migrates. A record governs
Farol only; it does not amend another project's decisions.

| Record                                              | Decision                                                                                                                                                                                             |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ADR-0001](0001-application-operations.md)          | Application `Command`/`Query` → `Result`, one-word names, services versus capabilities, domain privacy and subject-mapped tests                                                                      |
| [ADR-0002](0002-uniform-names-tests-composition.md) | One-word package and file names, test pairing, pure composition root, module-owned desktop adapters, shared `pkg` kernel and kits, and the per-module enforcement switch; partly supersedes ADR-0001 |
