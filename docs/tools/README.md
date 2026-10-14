# Check the public documentation

Run this focused offline check from the repository root:

```sh
python3 docs/tools/check.py
```

It checks README and the current Start / Guides / Development pages, documentation/tool indexes and the status/readiness/verification references. It validates local Markdown targets and anchors, fenced-code balance and referenced Task/npm/Node entrypoints. It also checks existing non-archived Markdown links into README for retained section anchors. The checker derives from `docs/github-guide` and has been adapted to the current structure instead of activating its obsolete redirect inventory.

Historical narratives, frozen archives and unrelated technical pages are outside the outgoing-page lint scope. Their targets can still be resolved when a checked page links to them. Directory links to existing source trees are allowed. Dependency install-script references are checked against package declarations when this worktree has no node_modules; the audited install scripts were also found in the existing local dependency installation. Task contracts explicitly described as unimplemented are excluded from executable-command checks. The exact scope and options are visible with:

```sh
python3 docs/tools/check.py --help
```

For formatting, use the repository's installed pinned Prettier on the task-owned Markdown files. Preserve prose paragraphs as one physical line; do not reformat historical snapshots merely to change wrapping. Run `git diff --check` and inspect the owned diff before committing. These checks do not establish external-link reachability, current UI behavior, package acceptance or an installed/live user journey.

The [audit record](../reference/documentation-verification.md) gives the source pins and remaining acceptance. [AGENTS.md](../../AGENTS.md) owns checkpoint and integration gates; this focused checker is not a replacement for them.

[Development](../development/README.md) · [Documentation](../README.md)
