# Dependency inventory

All direct versions are exact and resolved by `package-lock.json`. Provenance is the
public npm registry recorded in `.npmrc`.

| Package               | Class           | Version | License    | Purpose / decision                                                                           |
| --------------------- | --------------- | ------: | ---------- | -------------------------------------------------------------------------------------------- |
| Electron              | runtime closure | 41.10.7 | MIT        | Desktop shell, WebContentsView, sandboxed renderer and bundled utility-process runtime; kept |
| Zod                   | runtime         |   4.6.5 | MIT        | Parse untrusted IPC/HTTP boundary payloads; kept                                             |
| TypeScript            | build           |   7.0.2 | Apache-2.0 | Strict static checks; kept                                                                   |
| Vitest / coverage-v8  | test            |   5.0.0 | MIT        | One unit/component/property runner and measured V8 coverage; kept                            |
| fast-check            | test            |   4.9.0 | MIT        | State/property generation for ownership and lifecycle policies; kept                         |
| Playwright Core       | test            |  1.63.0 | Apache-2.0 | Drive the exact packaged Electron bytes without downloading another browser; kept            |
| esbuild               | build           |  0.28.2 | MIT        | Deterministic entrypoint bundles for Electron, utility process and renderer; kept            |
| Prettier              | build           |   3.9.6 | MIT        | Single formatting gate; kept                                                                 |
| Node type definitions | build           | 24.12.1 | MIT        | Types for the supported embedded/development Node API floor; kept                            |

React, a second validator/test runner, Stryker, Bun, native addons, and an HTTP
framework are dropped from this preview. The UI is small enough for DOM TypeScript;
planted defects provide focused mutation proof; Node's HTTP server and Web streams
cover the loopback fixture; and Electron already carries the production runtime.
