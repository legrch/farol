# Dependency inventory

All direct versions are exact and resolved by `package-lock.json`. Provenance is the
public npm registry recorded in `.npmrc`.

| Package               | Class           | Version | License    | Purpose / decision                                                                           |
| --------------------- | --------------- | ------: | ---------- | -------------------------------------------------------------------------------------------- |
| Electron              | runtime closure |  44.4.2 | MIT        | Desktop shell, WebContentsView, sandboxed renderer and bundled utility-process runtime; kept |
| Zod                   | runtime         |   4.6.5 | MIT        | Parse untrusted IPC/HTTP boundary payloads; kept                                             |
| TypeScript            | build           |   7.0.2 | Apache-2.0 | Strict static checks; kept                                                                   |
| Vitest / coverage-v8  | test            |   5.0.0 | MIT        | One unit/component/property runner and measured V8 coverage; kept                            |
| fast-check            | test            |   4.9.0 | MIT        | State/property generation for ownership and lifecycle policies; kept                         |
| Playwright Core       | test            |  1.63.0 | Apache-2.0 | Drive the exact packaged Electron bytes without downloading another browser; kept            |
| esbuild               | build           |  0.28.2 | MIT        | Deterministic entrypoint bundles for Electron, utility process and renderer; kept            |
| Prettier              | build           |   3.9.6 | MIT        | Single formatting gate; kept                                                                 |
| Node type definitions | build           | 24.12.1 | MIT        | Types for the supported embedded/development Node API floor; kept                            |

The Electron row is enforced by `tooling/runtime-contract.mjs`, which pins the verified
darwin/arm64 distribution digest and the digest of the bundle that archive extracts to;
packaging and verification compare the installed and embedded runtime with that contract,
never only with whatever `node_modules` currently holds.

React and React DOM 19.3.0 (MIT) provide the Farol-owned renderer. Their direct
versions, scheduler runtime closure, license notices and source/compiler identity
are recorded by the existing build attestation. React type definitions 19.3.0,
jsdom 30.1.1, ESLint 10.0.3 and eslint-plugin-react-hooks 7.1.1 support strict TSX,
component fixtures and hook linting. React is restricted to renderer code.

A second validator/test runner, Next.js/SSR/RSC, Redux, a query framework, Stryker,
Bun, native addons and an HTTP framework are not required. Planted defects provide
focused mutation proof; Node's HTTP server and Web streams cover the loopback
fixture; Electron carries the production runtime.
