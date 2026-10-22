# Farol identity cutover

Status: owner accepted on 2026-10-22.

The product is **Farol**. The owner accepts breaking updates from earlier betas:
reinstall those builds instead of migrating the running profile or translating
old receipts. This decision supersedes the earlier rule that preview identities
were permanent compatibility boundaries.

## Current identities

| Surface                               | Production                  | Development                 | Owner Preview                         |
| ------------------------------------- | --------------------------- | --------------------------- | ------------------------------------- |
| Display and application name          | `Farol`                     | `Farol Dev`                 | `Farol Preview`                       |
| Bundle ID                             | `io.github.legrch.farol`    | `local.farol.dev`           | `local.farol.owner.preview`           |
| Electron data directory under appData | `io.github.legrch.farol`    | `Farol Dev`                 | `Farol Preview`                       |
| Runtime partition                     | `persist:farol-runtime`     | `persist:farol-dev-runtime` | `persist:farol-owner-preview-runtime` |
| ChatGPT partition                     | `persist:farol-app-chatgpt` | `persist:farol-dev-chatgpt` | `persist:farol-owner-preview-chatgpt` |
| Runtime identity                      | `farol-runtime`             | `farol-dev-runtime`         | `farol-owner-preview-runtime`         |

The existing development-directory resolver also recognizes its explicitly
supported development alias. This cutover does not merge Dev, Owner Preview,
production, or retired V0 storage.

Production must never select the retired bundle `local.farol.app`, the V0 home
`~/.farol`, or `persist:farol-chatgpt`. Keep those exclusions in
[resources.json](../resources.json) and the resource contract. The display name
must not determine the data directory. See
[desktop environment](../src/apps/desktop/desktop-environment.ts) for executable
selection policy.

## Naming contracts

Current state and private child homes use `farol-state` and `farol-private`.
Current schema IDs use the `farol.` namespace; environment variables and
classified codes use `FAROL_`. Both ends of renderer IPC use `farol:` and
`window.farol`; browser storage keys use `farol.`.

The connector profile is `farol`, the MCP server is `farol-computer`, and the
verification tools are `farol_connector_verify` and
`farol_connector_verify_catalogue`. The host tools bridge is `farol_host_tools`;
it deliberately avoids the retired caller-tools name. Native host smoke uses
`farol_ping`; correlated caller IDs start with `farol_call_`.

The permanent model route stays `provider = farol`, `model = chatgpt`.
Obsolete experimental model labels use the neutral `legacy-route` namespace;
negative provider fixtures use `legacy_provider`. Those labels do not add a
supported model or normalize a rejected compound route into the current route.

## Tree digest generation

The version tag is `farol.tree-digest/v2`. The encoding remains unchanged:
length-prefixed UTF-8 paths, entry kind, big-endian mode, then a file-content hash
or length-prefixed symlink target. Sorting retains UTF-16 code-unit order.
Changing the version tag changes the resulting digest even for an empty tree.

TypeScript, Go and Python must change together. Static golden vectors bind the
new tag and fixture bytes; binary plist fixtures preserve their special encodings.
The shell-support declaration, signed-derivative contract, archive preparation
validator and launch fixtures require the same version. Helper content pins must
be refreshed from the actual changed bytes; no attestation check is weakened.

## Legacy readers and verification limits

Schema-5 package/archive readers retain an explicit old app-name constant. Alpha
migration retains its old source selectors. Closed repair, preview retirement and
closed installed-pair preservation retain explicit legacy profile selectors and
fixtures. Shared lease and drain readers select the original state directory
only for that explicit legacy profile name, preserving its lock domain. They are bounded readers of previous install identities, never current
runtime defaults or permission to operate on an installed application.

Do not rewrite frozen [archive material](archive/). Historical receipts remain
under their original identity and cannot qualify renamed bytes. Source checks,
independent review, packaging, installation and live acceptance are separate
facts. This source cutover does not run an installed migration, packaging, E2E,
activation or release. The integration Lead owns the remaining aggregate gates.

## Acceptance harness identities

E2E and acceptance tooling import identity values through the single
`tooling/harness-identity.ts` helper, which delegates to the product's
`desktopIdentity` contract for production, owner preview and Dev. Serialized
Electron callbacks receive calculated values as arguments; they must not capture
Node-side identity variables or substitute display names for profile directories.

`tests/unit/harness-identities.test.mjs` denies pinned identity tokens by default
in every non-binary file under `tests/e2e`, `tests/fixtures` and `tooling`, regardless
of extension. Every text line is checked, including comments and regexes. The
product display name is a whole-word token in all contexts, including bundle
suffixes and edition names. Bundle IDs, data-directory leaves, partitions (with
and without the persistence prefix), executable/application names and runtime
names come from all three product identities; retired rename tokens are also
denied. Decoded JavaScript/TypeScript literals and constant concatenations are
checked in addition to raw text.

Only the helper and the guard's exact file allowlist are exempt. Each entry has a
one-line reason for a fixed product/build contract, historical reader, protective
rejection fixture or displayed-copy assertion. A test rejects missing, binary,
out-of-scope or token-free (stale) exceptions. Newly discovered text files receive
no implicit exemption. Historical and rejection values grant no access to owner
profiles. Operational harness identity values still belong in the helper rather
than the displayed-copy exceptions.

Native admission can precede the startup phase that creates the caller relay.
A harness that reopens a profile refreshes its isolation witness from the
original live child before Quit. The relay retains the result of its own root
creation, including its physical path, device/inode, birth time and process
identity. A read-only E2E main-process getter reports that witness, including
when later socket startup refuses; directory provenance does not assert relay
availability. First adoption
requires creation by that child after process start and before refresh; merely
opening a socket in a harness-created directory does not qualify. Initial window
echoes never adopt a new relay from harness metadata alone. Clean Quit removes the socket and preserves
the private relay directory. Reopen still requires the previously witnessed
directory identity, an absent run marker and a graceful original child exit;
an unwitnessed or replaced relay directory remains an isolation refusal.
