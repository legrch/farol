# Workspace instructions and guidance

**State:** current Computer MCP source and built/package fixtures. Tool availability
still depends on the serving connector, task grant, current approval, and client
metadata refresh. [Computer](capabilities.md) describes the broader access model.

## Discover workspace IDs

Call `computer_workspace_catalogue` without arguments before selecting a folder.
It returns exact IDs and scope roots from the current participant's materialized
task grant, including delegated narrowing. Do not derive an ID from a name/path or
reuse another task's ID.

At most 32 roots are checked through the existing native context operation, then
checked again before disclosure. A refusal, expiry, revocation, or rebound root
discards the entire collected result. The tool does not read file contents, enumerate
filenames, grant access, or offer owner-approved folders outside this task.
Exact-file-only grants are omitted because they cannot browse a directory.

This is a bounded, twice-checked observation, not an atomic filesystem snapshot.
An already-attached client may need its normal metadata refresh to discover a new tool.

## Read applicable instructions

`computer_workspace_bootstrap` takes `workspaceId` and canonical
`relativeDirectory` (`.` for the task scope root). It verifies that directory, then
reads `AGENTS.md` at the task root and along the directory chain. A selected linked
worktree uses its own physical files; the primary checkout is not substituted.

| Result               | Meaning                                                                |
| -------------------- | ---------------------------------------------------------------------- |
| `read`               | The admitted instruction file was read                                 |
| `not_found`          | The selected admitted path is absent                                   |
| `unavailable` + code | Denied, unsafe, non-text, oversized, unstable, or otherwise unverified |
| `complete: false`    | At least one applicable entry was unavailable                          |

The chain excludes ancestors outside task scope and unrelated descendants. It is
limited to 32 nested components and a 64 KiB aggregate response. Exclusions and
budget overflow never become a truncated instruction or an absence claim. Apply
root rules before more specific rules; their text cannot expand the grant.

Bootstrap reads the chain twice and refuses change, then rechecks directory/root
context and authority before disclosure. Cancellation, expiry, root replacement,
revocation, or correlation failure discards collected text. Exact-file-only grants
cannot bootstrap directories.

## Published product guidance

`computer_guidance_search` and `computer_guidance_fetch` use
[the embedded product manifest](../../../src/modules/computer/infra/mcp/computer-guidance.json).
Search ranks published title/summary/keywords and reports `resultLimited`. Fetch
accepts a published ID, never a supplied path. Every reference must name another
manifest entry; malformed, duplicate, or dangling entries make guidance unavailable.

This bundle contains product guidance. Workspace instructions and private personal
knowledge are not imported into it.

## Search coverage

Directory list is bounded and nonrecursive. Text search reports its scan and result
limits. For recursive filename/include discovery, use an admitted ordinary shell,
for example:

```sh
rg --files --glob '*.ts' --glob '!_output/**'
```

Report the actual command exit and ignore/include coverage. Default ignore rules,
exclusions, and scan limits cannot be described as a complete physical inventory.
For large text reads, follow the returned page offsets.

## Verification boundary

[Workspace-bootstrap MCP tests](../../../tests/integration/workspace-bootstrap-mcp.test.ts)
use actual safe-open behavior on temporary folders. Packaged stdio fixtures cover
the sealed Computer entry and embedded guidance. They do not prove that a live
ChatGPT connector refreshed its catalogue or that a user's current task/account
ran. Model, Product Agent, and embedded login are not prerequisites for these
Computer tools.

---

[Computer](README.md) · [Documentation](../../README.md)
