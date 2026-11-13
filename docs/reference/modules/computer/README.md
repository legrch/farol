# Computer module reference

- [Durable access](access.md)
- [Admission](admission.md)
- [Connector contract](connector.md)
- [Context](context.md)
- [Workspace discovery](discovery.md)
- [Execution leases](leases.md)
- [Migration map](migration.md)
- [Workspace mutation](mutation.md)
- [Search](search.md)
- [Process infrastructure](infra/process.md)
- [Mutation repository](infra/repos/mutation.md)

The unselected source-bound managed Git push transport (`infra/git`,
`domain/egress` and `app/port/egress`) never had a production composition and
was removed on 2026-11-13. Farol uses the Git installed on the Mac through the
ordinary scoped Shell; the transport source remains in Git history (PR #45).
