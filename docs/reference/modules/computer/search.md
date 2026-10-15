# Go workspace search

The owning service and filesystem adapter are source foundation. External MCP,
ordinary Dev, native and packaged qualification remain separate exits. This slice
uses the existing execution lease and final authority check. It adds no approval
store and launches no interpreter.

The Settings `computer.search-workspace` command now selects
`DesktopGoCore.searchSettingsWorkspace` → `computer.settings.search` → the
Computer Settings service → the existing Go filesystem search. Its Go owner
requires explicit Search capability from the current owner publication, checks
that publication before dispatch and disclosure, and keeps the original fixed
lease. It creates no Task, Chat participant or alternate filesystem owner.
TypeScript retains command/IPC mapping, closed response decoding and current UI
publication/root correlation. A missing, refused or unknown Go response never
dispatches the legacy Python workspace helper. That helper remains in other
compatibility paths until their separate cutovers; its resource is not yet
retired. Source transport and portable fixtures do not prove clean-Mac,
packaged-process or installed acceptance.

Search accepts a conservative RE2 subset: Unicode literals, character classes,
groups, alternatives, anchors, flags and standalone quantifiers. Python-only
constructs and shorthand escapes with different Unicode meanings are refused,
including `\w`, `\d`, `\s` and `\b`. Full Python regex compatibility is not
claimed. Unsupported patterns produce `WORKSPACE_INVALID_REQUEST`; they do not
select the old helper. External tool documentation must expose this limitation
before activating this adapter.

Results use workspace-relative paths and one-based LF line numbers. Each excerpt
contains at most 500 code points. The adapter bounds results to 100 matches,
8 MiB per file, 64 MiB per scan, 100,000 entries, 10,000 directories and depth 64.
It checks the five-second deadline between native operations. This is not a
guarantee that an individual blocked filesystem syscall returns within five seconds.

`ResultLimited` and `ScanLimited` are independent. Neither a partial result nor
an empty partial result proves absence. Explicit exclusions and mandatory path
rules apply before reading content or ignore metadata. The traversal uses the
existing descriptor and no-follow checks; it is not an atomic snapshot of a tree.

`TestSearchService*`, `TestSearchContract*` and `TestSearchPure*` provide pure
regressions. `TestSearchNative*` are disposable filesystem tests and require their
own native execution receipt. These layers do not prove an external MCP route.
