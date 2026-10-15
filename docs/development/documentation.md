# Documentation layout and maintenance

Keep ordinary product, module, contract, design and technical-reference Markdown
under `docs/`. Root `README.md` and `AGENTS.md` remain the user and agent entrypoints.
Use the existing Start, Guides, Development and Reference sections; add organized
subdirectories without copying an existing canonical document.

- `docs/start/` and `docs/guides/`: recipient and everyday-use guidance.
- `docs/development/`: contributor workflows and verification.
- `docs/architecture.md`, `docs/desktop-core.md` and related technical pages:
  existing architecture references; their paths remain stable.
- [docs/reference/modules/](../reference/modules/README.md): canonical Computer,
  Chat, Task and Release specifications, with module indexes and meaningful
  nested contract/infrastructure names.
- [docs/design/](../design/README.md): design records and navigation to asset
  provenance. Actual images, fonts and license files retain their resource paths.

Keep historical proposals and evidence qualified as such. A path move does not
change module architecture, runtime activation, requirements or native/package/
installed/live acceptance. Private Brain decisions and owner-specific evidence
remain outside the public repository.

## Module migration inventory

The source baseline `6e8ddbded5567b8830a855bfa868aa58c32fabd6` contains 179 Markdown
files: 123 in `docs/`, 37 in Go modules, 17 in `design-lab/` and `resources/`, and
the two root entrypoints. A later signed-derivative reference added one `docs/`
file before this maintenance packet. All 37 module documents move to the indexes
above, without a module-level redirect or exception:

| Module   | Original paths under `modules/<module>/`                                                                                                                            | Canonical paths under `docs/reference/modules/<module>/`                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Computer | `access.md`, `admission.md`, `connector.md`, `context.md`, `discovery.md`, `leases.md`, `migration.md`, `mutation.md`, `search.md`                                  | Same filenames (9).                                                                                                                   |
| Computer | `infra/process/README.md`, `infra/repos/mutation/README.md`                                                                                                         | `infra/process.md`, `infra/repos/mutation.md` (2).                                                                                    |
| Chat     | `README.md`, `ADMISSION.md`, `LIFECYCLE.md`                                                                                                                         | `README.md`, `admission.md`, `lifecycle.md` (3).                                                                                      |
| Chat     | `contracts/conversation/CONFORMANCE.md`, `contracts/conversation/RELAY.md`                                                                                          | `contracts/conversation/conformance.md`, `contracts/conversation/relay.md` (2).                                                       |
| Chat     | `infra/browser/README.md`, `infra/contextsource/README.md`, `infra/modelruntime/README.md`, `infra/results/README.md`, `infra/results/DURABLE.md`                   | `infra/browser.md`, `infra/contextsource.md`, `infra/modelruntime.md`, `infra/results.md`, `infra/results/durable.md` (5).            |
| Task     | `README.md`                                                                                                                                                         | `README.md` (1).                                                                                                                      |
| Task     | `contracts/control/README.md`, `contracts/observation/README.md`, `contracts/selectedthread/README.md`                                                              | `contracts/control.md`, `contracts/observation.md`, `contracts/selectedthread.md` (3).                                                |
| Task     | `infra/clients/claude/README.md`, `infra/clients/codex/README.md`, `infra/peer/parent/README.md`, `infra/peer/process/README.md`, `infra/workflowruntime/README.md` | `infra/clients/claude.md`, `infra/clients/codex.md`, `infra/peer/parent.md`, `infra/peer/process.md`, `infra/workflowruntime.md` (5). |
| Release  | `README.md`, `adoption.md`, `journal.md`, `migration.md`, `native.md`, `relocation.md`, `infra/archive/provenance.md`                                               | Same filenames and nested structure (7).                                                                                              |

The extra Computer README is a destination index. Original prose, requirements,
source identities and safety qualifications remain; links are rebased and module
indexes add navigation. Go packages stay in their original source directories.
No generation, embedding, packaging, policy or test consumer required any of the
37 Markdown files at its former location.

## Design and provenance inventory

Of the other 17 documents, seven ordinary records move:

| Original                                 | Canonical document                                          |
| ---------------------------------------- | ----------------------------------------------------------- |
| `design-lab/DESIGN.md`                   | [Lab directions](../design/lab-directions-2026-09.md)       |
| `design-lab/PRODUCT.md`                  | [Lab product brief](../design/lab-product-brief-2026-09.md) |
| `design-lab/fonts/PROVENANCE.md`         | [Font provenance](../reference/font-provenance.md)          |
| `resources/brand/README.md`              | [Brand provenance](../reference/brand-assets.md)            |
| `resources/brand/signal-color/README.md` | [Signal / Color](../reference/brand-assets/signal-color.md) |
| `resources/brand/sunrise-dock/README.md` | [Sunrise Dock](../reference/brand-assets/sunrise-dock.md)   |
| `resources/brand/sunrise/README.md`      | [Sunrise source](../reference/brand-assets/sunrise.md)      |

The [ten frozen handoff exceptions](../design/README.md#frozen-offline-handoff-exceptions)
remain byte-for-byte inside their manifest-bound offline archive. Their license,
provenance, revision and relative-link custody is the reason for co-location.
The canonical index records each exact path and reason. No ordinary module
Markdown is exempt. New machine-required exceptions need an exact entry in
`docs/tools/placement-exceptions.json` and the corresponding canonical index.

Dated reconciliation JSON inventories and frozen copies retain original source
paths and hashes as historical evidence. Living links in surrounding indexes
point to the canonical documents. Do not rewrite immutable handover snapshots or
archive bytes to make historical path inventories look current.

## Verification

Run `npm run docs:check` before committing. The existing lightweight offline
checker now covers placement and local links throughout non-frozen repository
Markdown, including module/design indexes, root agent instructions and archive
indexes. Frozen `originals/` and `frozen/` content retains its historical links.
Reader H1, privacy, fence and command checks keep their declared scope; see
[the checker contract](../tools/README.md). Its synthetic tests cover scattered
new documents, exact/stale exceptions, broken links/anchors and ignored vendor
files. CI runs the same command.

Search all source, tests, tooling, Taskfiles and CI for former paths. Inspect
machine consumers before removal, use `git mv`, update owned links and inspect
the complete diff. Run pinned formatting, architecture checks and affected tests;
do not add product runtime changes to a documentation cleanup.

[Development](README.md) · [Documentation](../README.md)
