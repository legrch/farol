# Make a scoped contribution

Take one change from an accepted source base to reviewable, verified bytes. Start
with a prepared [development worktree](setup.md).

## Establish the contract

Read [AGENTS.md](../../AGENTS.md) and the relevant
[architecture decision or boundary](../architecture/README.md). Inspect nearby
source, tests, and executable configuration before relying on a documentation claim.
A Proposed design, disabled route, or fixture is not active runtime behavior.

Name the capability being changed and the evidence needed for it. New desktop
source belongs under `apps/desktop/`; existing TypeScript remains under `src/`
until its owned slice switches. Follow the [migration contract](../architecture/migration.md)
and [module boundaries](../architecture/boundaries.md).

## Work in isolation

Use an available supported writer from the exact accepted base. Preserve unrelated
changes and stage only the paths or hunks you own. A busy primary checkout is not
your scratch space.

Keep code, comments, implementation documentation, errors, and UI in English.
Update the canonical documentation page in the same change when behavior,
contracts, commands, or runtime status changes. The [documentation guide](documentation.md)
shows where each kind of change belongs.

## Checks and review

Run focused existing tests and `git diff --check` while editing. Inspect the final
diff and create a coherent English Conventional Commit containing only owned work.
Use the complete [source gate](testing.md#source-gate) on clean committed bytes.
Hunt's clean-tree requirement means a checked checkpoint may precede final CI;
that checkpoint alone does not establish full-gate success.

Enable the existing push gate in a fresh clone when required:

```sh
git config core.hooksPath .githooks
```

The [GitHub source workflow](../../.github/workflows/standalone-ci.yml) is manual-only,
uses read-only repository permissions, and runs the dispatched SHA. A workflow
file does not establish that a run passed.

## Describe the result

Give the reviewer the concrete problem, changed behavior, source base/HEAD, checks
actually run, and unresolved qualification. Source tests, package fixtures, live
provider acceptance, integration, installation, and publication are distinct facts.

Integration and external actions follow the current owner scope and repository
policy in [AGENTS.md](../../AGENTS.md). A clean branch or review result does not
itself authorize a release, settings change, installation, or activation.

---

[Development](README.md) · [Testing](testing.md) · [Documentation](../README.md)
