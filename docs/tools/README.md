# Check the public documentation

Run the offline checker and its synthetic regression tests from the repository root:

```sh
npm run docs:check
```

The existing checker derives from `docs/github-guide` and uses Git's tracked plus new nonignored file inventory, so dependencies and generated output are not walked. Ordinary Markdown must live under `docs/`, apart from root `README.md` and `AGENTS.md`. The small [placement exception inventory](placement-exceptions.json) permits only the ten [manifest-bound historical handoff documents](../design/README.md#frozen-offline-handoff-exceptions), each with a reason and canonical index entry. Missing index entries and stale exceptions fail. There are no module Markdown exceptions.

Local Markdown links/images, reference definitions, HTML anchor/image targets and heading anchors are checked throughout non-frozen repository Markdown, including module/design pages, historical narratives, archive indexes and root agent instructions. Directory links to existing source trees are allowed. Exact frozen originals under `docs/archive/distribution-20261010/originals/` and `docs/archive/coordinator-20261010/frozen/` retain their historical links; they are not rewritten or linted as current guidance. Targets and anchors inside a frozen document still resolve when a checked page links into it. External URL reachability is outside this offline check.

Strict prose/command lint remains scoped to README, current Start / Guides / Development pages, documentation/tool indexes and status/readiness/verification references. These pages require one H1, balanced code fences, no owner-specific filesystem path and valid referenced Task/npm/Node entrypoints. Technical and historical pages retain their original command examples and qualifications. Dependency install-script references are checked against package declarations when node_modules is absent. Task contracts explicitly described as unimplemented remain excluded from executable-command checks. The exact scope and options are visible with:

```sh
python3 docs/tools/check.py --help
```

The synthetic unittest fixtures use disposable local Git repositories to prove placement refusal, exception/index/staleness checks, link/anchor failures, archive-index coverage and ignored dependency exclusion. They execute no Farol, network, provider or native capability. `npm run ci` includes `docs:check`; Python is a developer check dependency, with no installed application dependency added.

For formatting, use the repository's installed pinned Prettier on the task-owned Markdown files. Preserve prose paragraphs as one physical line; do not reformat historical snapshots merely to change wrapping. Run `git diff --check` and inspect the owned diff before committing. These checks do not establish current UI behavior, package acceptance or an installed/live user journey.

The [audit record](../reference/documentation-verification.md) gives the source pins and remaining acceptance. [AGENTS.md](../../AGENTS.md) owns checkpoint and integration gates; this offline checker is not a replacement for them.

[Development](../development/README.md) · [Documentation](../README.md)
