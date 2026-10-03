# Dependencies

[package.json](../package.json) declares exact direct versions;
[package-lock.json](../package-lock.json) owns the resolved npm graph. The public
npm registry is selected in [.npmrc](../.npmrc). [go.mod](../go.mod) and
[go.sum](../go.sum) own the additive Go dependency graph.

## Current npm dependencies

| Dependency | Role            | Version |
| ---------- | --------------- | ------- |
| Electron   | runtime closure | 44.4.2  |

Electron provides the main process, sandboxed renderer, native views, and bundled
utility-process runtime. Other direct dependencies are grouped by their purpose:

| Group                 | Packages                                                                                     | Purpose                                                            |
| --------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Boundaries            | Zod `4.6.5`, `@modelcontextprotocol/server` `2.0.0`                                          | Runtime validation and Computer MCP serving                        |
| Socket transport      | `ws` `8.22.0`                                                                                | Selected native-host proxy transport                               |
| Build                 | TypeScript `7.0.2`, esbuild `0.28.2`, Prettier `3.9.6`                                       | Strict compilation, bundles, single format gate                    |
| Testing               | Vitest/coverage-v8 `5.0.0`, fast-check `4.9.0`, Playwright Core `1.63.0`, MCP client `2.0.0` | Policy/property coverage and real built-byte protocol/app fixtures |
| Source analysis/types | Babel parser and Node/WebSocket type packages                                                | Architecture checks and supported host types                       |

The manifest is the authority for omitted type/parser versions; this page describes
why dependencies exist instead of duplicating the complete lockfile.

## Runtime and compiler provenance

[The runtime contract](../tooling/runtime-contract.mjs) pins Electron's Darwin ARM64
archive and extracted bundle digest. Packaging verifies the installed and embedded
runtime against those reviewed bytes. The outer Farol app embeds the unchanged
vendor Electron bundle; it does not strip or add its code signature.

Locked dependency inputs and compiler identity are checked separately. An installation
whose own generated hashes agree can still fail the independent reviewed contract.
Use [development setup](standalone-build.md#prepare-a-fresh-clone-or-worktree) for the
explicit esbuild/Electron install scripts; do not change digest files to accept a
mismatched dependency.

## Go and native helpers

The root Go module currently uses `golang.org/x/sys` and `golang.org/x/text` for the
Go Computer/Core foundation. The active desktop still uses reviewed Python native
helpers for Computer and updates. Adding Go source has not replaced that runtime
dependency; see [Desktop/Core](desktop-core.md).

The selected tunnel client and native host are external prerequisites, with their
own executable/contract verification. No native provider account, private cache,
credential, or browser profile is a build dependency.

## Migration boundary

React is the accepted UI target and is not present in the current npm dependencies.
The running shell remains DOM TypeScript until its slice switches. The migration
contract lives in [AGENTS.md](../AGENTS.md) and the
[accepted architecture](architecture.md).

The current runtime does not depend on Bun, a separate HTTP framework, or a second
policy test runner. These are current implementation facts, not restrictions on an
unrelated future design decision.

---

[Documentation index](README.md) · [Project overview](../README.md)
