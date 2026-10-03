# Write and maintain documentation

Make the reader's next action clear, keep technical facts owned, and verify the
navigation whenever a page or product behavior changes.

## Choose the reader and page type

Farol applies [Diátaxis](https://diataxis.fr/): learning, accomplishing a task,
understanding a design, and looking up a fact are different needs. Name the
reader's concrete question before writing.

| Page type              | Home                        | Required shape                                                               |
| ---------------------- | --------------------------- | ---------------------------------------------------------------------------- |
| First-session tutorial | `start/`                    | Goal, prerequisites, small ordered steps, observable checks, next step       |
| Practical procedure    | `guides/` or `development/` | Task, prerequisites, focused actions, result, recovery link                  |
| Design explanation     | `architecture/`             | Context, responsibilities, rationale, boundaries, current/target distinction |
| Precise reference      | `reference/`                | Status, exact terms/fields/limits, source anchors, related reference         |
| Legacy maintenance     | `maintenance/`              | Applicability, closed-app conditions, exact evidence, retained limits        |

Section README files are navigation pages: a short purpose, ordered paths or a
small task table, then related sections. Create directories only for real material.
Every documentation directory has a README and every canonical page is reachable
from the documentation index.

## Give each fact one home

The [status matrix](../reference/status.md) owns the named release/source snapshot
and capability qualification. [Configuration](../reference/configuration.md),
[profiles](../reference/profiles.md), and each contract page own their exact facts.
Guides link to those pages instead of duplicating their full tables and caveats.

Label **released**, **current source**, **accepted target**, **fixture-only**, and
**not qualified** accurately. Never turn a branch, naming decision, mock, or planned
layout into a shipping claim. Update the release/source evidence when an accepted
range changes those labels.

Original flat URLs are compatibility pointers recorded in
[redirects.json](../tools/redirects.json). They retain old section anchors and link
into canonical pages. The manifest's `baseline_anchors` freeze the heading
inventory from `compatibility_base`, including the original landing page. When a
heading changes, preserve its old anchor with a
[GitHub custom anchor](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#custom-anchors)
beside the relevant replacement section. Do not remove a baseline entry to silence
the checker. For another page move, capture its pre-move heading anchors and map
each one to its canonical destination.

Two old source contracts still read the Electron row and
bundled setup URLs at their original addresses; the documentation check verifies
those retained facts against current source. Keep the detailed explanation in its
canonical page.

## Write for GitHub

- Use plain GitHub Markdown, one H1, descriptive headings, and relative links to
  explicit files. Link sections to their README, rather than a bare directory.
- State the goal and expected result early. Give commands without shell prompt
  characters, use portable examples, and explain placeholders.
- Put the important limitation beside the affected action. Keep lengthy evidence
  and contract details in reference pages.
- Use a table for comparisons and a Mermaid diagram for useful responsibility or
  lifecycle views. Label a migration diagram as a target.
- Keep implementation prose and UI labels in English. Exclude owner-specific paths,
  task/chat IDs, employer material, secrets, prompts, and private transcripts.
- Keep page and heading URLs stable. Update links and compatibility routing when a
  split changes the canonical location.

Use [C4's container-level guidance](https://c4model.com/diagrams/container) to choose
an architectural zoom: responsibilities and communication first, implementation
mechanics only where they explain the boundary.

## Verify the change

```sh
python3 docs/tools/check.py
npm test -- tests/integration/repository-contract.test.mjs tests/unit/setup-media.test.ts
npm run format:check
git diff --check
```

The [local documentation checker](../tools/README.md) verifies targets/anchors, section indexes,
reachability, compatibility routes, selected source facts, and literal Task/npm/Node
entrypoints. It does not verify external account access, live UI, or prose semantics.
Validate Mermaid syntax separately when a diagram changes.

Before completing a documentation change, run the required clean-tree
`task ci:fast` as described in [testing](testing.md). Review the final diff for
scope and private data as well as formatting.

## Review the reader journeys

Follow each path from the GitHub landing page:

1. **New user:** requirements → download → connect → read the known example.
2. **Returning user:** one task → correct prerequisites → explicit result or remedy.
3. **Developer:** worktree → supported toolchain → Dev → focused checks → full gate.
4. **Architecture reader:** current runtime → authority → boundaries → target → decisions.
5. **Reference reader:** exact fact → source anchor → qualification and related contract.

A passing link checker cannot detect an unexplained prerequisite, circular route,
misleading first step, or two conflicting sources of truth. Inspect those explicitly.

## Keep it current

When behavior changes, update the owning page and affected guide in the same scoped
change. A released version change updates status and installation links. Preserve
older procedures only while readers need them, with their applicability visible.

## Public design references

The organization draws on the separation of first steps, guides, concepts, and
reference in [uv](https://docs.astral.sh/uv/); the separate binary/source installation
paths in [Ghostty](https://ghostty.org/docs); and task-based entrypoints in
[Docker Docs](https://docs.docker.com/). Farol implements those navigation ideas
through repository folders and Markdown, without adopting their site tooling.

---

[Development](README.md) · [Documentation](../README.md)
