# Develop Farol

Build the running TypeScript/Electron application, verify a scoped change, and
create a local candidate when the task requires it. The Go/React
[migration boundary](../architecture/migration.md) remains explicit throughout.

## Your first change

1. [Prepare a development worktree](setup.md) and run Farol Dev.
2. [Make a scoped contribution](contributing.md) using the repository's current
   contracts and isolated writer rules.
3. [Verify the change](testing.md). Distinguish source checks from native, packaged,
   and live acceptance.
4. [Build and launch a candidate](packaging.md) only when packaged evidence is needed.

## Developer references

- [Dependencies](dependencies.md) — ownership, pinned runtime, and compiler provenance.
- [Ordinary Git fixture](git-fixture.md) — disposable shell/Git configuration.
- [Documentation maintenance](documentation.md) — content ownership, navigation,
  link checks, and reader-journey review.
- [Architecture](../architecture/README.md) — runtime, module boundaries, and decisions.
- [Technical reference](../reference/README.md) — Computer, tasks, wire, and update contracts.

The normal development loop does not need an installed app, a second Farol checkout,
or a live provider account. Native and account-based checks have their own prerequisites.

---

[Documentation](../README.md)
