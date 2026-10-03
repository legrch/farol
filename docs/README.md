# Farol documentation

Connect ChatGPT to an approved local workspace, develop Farol, or understand its
boundaries. Choose the path that matches what you want to do.

| Your goal                                 | Start here                             | Finish with                                        |
| ----------------------------------------- | -------------------------------------- | -------------------------------------------------- |
| Try Farol for the first time              | [Start](start/README.md)               | Read a file from a folder you approved             |
| Change access, update, or solve a problem | [Practical guides](guides/README.md)   | Complete one specific task                         |
| Build Farol or contribute a change        | [Development](development/README.md)   | A checked change or verified local candidate       |
| Understand the design                     | [Architecture](architecture/README.md) | Understand the running system and migration target |
| Look up an exact contract or setting      | [Reference](reference/README.md)       | Find the authoritative detail                      |
| Maintain an older preview installation    | [Maintenance](maintenance/README.md)   | Follow the applicable closed-app procedure         |

> [!IMPORTANT]
> The documented release is an unsigned macOS Apple Silicon owner beta. The
> [status matrix](reference/status.md) names its source snapshot and separates
> shipped implementation, gated routes, test compositions, and migration work.

## Start with a complete path

**Use Farol:** [Install](start/installation.md) →
[connect ChatGPT](start/first-connection.md) →
[read your first workspace](start/first-workspace.md).

**Develop Farol:** [Set up a worktree](development/setup.md) →
[make a scoped change](development/contributing.md) →
[run checks](development/testing.md) →
[build a candidate when needed](development/packaging.md).

**Understand Farol:** [Running desktop](architecture/runtime.md) →
[permissions and unknown outcomes](architecture/authority.md) →
[module boundaries](architecture/boundaries.md) →
[Go/React migration](architecture/migration.md).

## The documentation tree

```text
docs/
├── start/          First installation, connection, and workspace
├── guides/         Access changes, updates, and troubleshooting
├── development/    Setup, contribution, tests, dependencies, and candidates
├── architecture/   Runtime, authority, boundaries, migration, and decisions
├── reference/      Status, configuration, shortcuts, and technical contracts
│   ├── computer/
│   ├── tasks/
│   ├── protocols/
│   └── updates/
├── maintenance/    Closed preview migration and recovery
└── tools/          Documentation integrity checks
```

Each section has its own README. Detailed facts have one canonical page; guides
link to those facts instead of repeating the complete contract. Original flat page
addresses remain short compatibility pointers, including their section links.

## Frequent lookups

[Current status](reference/status.md) · [Keyboard shortcuts](reference/shortcuts.md) ·
[Profiles](reference/profiles.md) · [Configuration](reference/configuration.md) ·
[Computer access](reference/computer/capabilities.md) · [Glossary](reference/glossary.md)

For documentation changes, follow the [writing and maintenance guide](development/documentation.md).
For the product introduction, return to the [project README](../README.md).
