# Owner Preview source preparation

Status: source preparation only. Artifact derivation and launch are blocked by
runtime contracts outside this packet. No owner Preview package, startup smoke,
native isolation, installation or beta readiness is established.

The on-demand owner channel targets `_output/preview/Farol Preview.app` and its
own persistent `Farol Preview` application-support directory. Its fixed marker
is `owner-preview`, application ID is `local.farol.owner.preview`, runtime
partition is `persist:farol-owner-preview-runtime`, and ChatGPT partition is
`persist:farol-owner-preview-chatgpt`. Identity is declared in
[`desktop-environment.ts`](../../src/apps/desktop/desktop-environment.ts), never
inferred from a display name. The declaration does not select or open a profile.
The runtime parser deliberately rejects the new marker until coordinated
admission is implemented and verified.

## Commands and migration

The old `task preview` command is preserved as `task preview:development`. It
delegates to `npm run preview`, launching existing development build bytes
without rebuilding. The npm command retains that meaning. The active references
in [testing guidance](../testing.md) still describe that npm command and the
separate `task run` candidate launcher. Frozen setup examples under
`docs/archive/distribution-20261010/originals/` describe the historical Task
alias and are retained as historical material. No other active repository
caller of `task preview` was found in this source baseline.

`task preview` now delegates to owner `preview:run`. The new commands require
`--expected-main` with the full accepted main commit. Build and run always
return `OWNER_PREVIEW_RUNTIME_INTEGRATION_REQUIRED` before accessing packages or
profiles or starting an app. They do not invoke `task package` yet.

```sh
task preview:plan -- --expected-main <full-accepted-main-sha>
task preview:build -- --expected-main <full-accepted-main-sha>
task preview:run -- --expected-main <full-accepted-main-sha>
```

The offline plan requires clean exact source at that SHA, matching local `main`
and `origin/main` tracking refs. It performs no fetch and cannot prove remote
freshness; the Lead must freshly establish accepted main before invoking it.
An unmerged feature checkout fails source admission. The JSON is a plan, never
a package, verification or launch receipt. Build/run refusal does not establish
source acceptance. Arbitrary profile/root paths and other launch flags are
rejected. Existing `task package` and `task run` retain their strict contracts.

## Required integration packet

The smallest next source packet needs explicit ownership of these boundaries:

- `src/apps/desktop/desktop-environment.ts`: admit `owner-preview` only with the
  complete fixed identity and independent child configuration/home semantics.
  Existing `preview` storage, Dev identity and historical strings stay intact.
- `src/apps/desktop/single-instance.ts`: extend the closed request/ACK environment
  schema and retain exact-source admission for the new packaged environment.
- `src/ui/renderer/contract.ts`, `src/pkg/product-settings/setup-entry.ts`,
  `src/pkg/product-settings/browser-presentation.ts`, and
  `src/apps/desktop/connector-resume-policy.ts`: carry the distinct environment
  without coercing it into production or Dev. Test first-run unconfigured
  connector state and later Preview-only persistence.
- `src/apps/desktop/main.ts` and its existing startup/updater composition:
  admit independent child configuration/home paths without owner Codex
  configuration/profile discovery. Preserve and qualify the existing installed
  updater's path/profile exclusions for Preview; change them only if an exact
  gap is demonstrated. Do not introduce a second settings, permissions or
  updater system.
- The owned Preview tooling and tests: derive from a clean committed
  `task package` at current accepted main, after the unchanged canonical verifier
  succeeds. Preserve the base manifest and exact executable/resource bytes;
  record base artifact digest, source commit/tree digest, and the derivative's
  own fixed identity and tree digest. Implement `verify-owner-preview.mjs`
  against explicit permitted branding/launcher changes, reverify the canonical
  base and derivative before launch, and bind Preview branding/icon and its
  launcher marker. A renamed bundle or an unchecked digest is insufficient.

The existing package verifier fixes the production bundle/launcher/product
identity. It must remain strict; a derivative needs its own verification layer.
Do not rewrite the attested build identity or Go resource declarations to make
a renamed package appear canonical. Exact artifact format and native startup
admission remain for the Lead's coordinated packet, not a guessed local bypass.

## Qualification and ownership

Pure contract tests use synthetic source observations and Node subprocesses
that only witness refusal. They establish no packaged, native, provider or
filesystem-isolation acceptance. The source lane runs focused Node tests,
desktop unit tests where dependencies exist, type/format checks and
`npm run docs:check`. The Lead owns full CI, `task package`, representative
package startup, repeated-launch persistence and independent Critic review.

Preview starts independently unconfigured. Never copy live profiles, credentials,
grants, browser state or journals; share or stop a production tunnel; close the
installed application; or migrate historical `local.farol.next.preview`,
`Farol Next Preview` or Dev state. Package, installed, release and beta acceptance
remain separate gates. This preparation does not enable automatic updates,
installation, signing or publication.
