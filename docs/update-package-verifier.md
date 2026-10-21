# Installed release package verification

The producer CLI and the installed updater share `tooling/verify-package-content.mjs`.
The CLI retains its checkout version, source resource manifest, and canonical
candidate path checks. An exact `-owner.beta.N` package version selects the
GitHub owner beta policy; historical preview versions retain their original
policy. Installed verification instead takes exact version,
build version, and channel from the accepted GitHub release manifest. The
artifact's recorded path is ignored there because extraction has a new private
root. For the current schema 6 package, the extracted `artifact.json` must sit
beside `Farol.app` in the ZIP. Historical schema 5 packages used
`Farol.app`; the branded installed updater refuses that older
layout. The old installed updater cannot consume the schema 6 layout. Use the
explicit [closed product cutover](product-cutover.md) to establish the branded
baseline instead of renaming or replacing an old release archive.

The producer must bundle `tooling/verify-package-standalone.mjs` and its
imports into one trusted installed resource. It also builds and attests the
native Go extractor from `resources/native/go/cmd/update-archive`, including
its compiler, source and dependency identities. The packaged executable keeps
the resource filename `update-archive.py` for update compatibility; the native
adapter supplies that pinned executable as `extractorPath` and executes it
directly, without Python. `resources/native/update_archive.py` remains a
historical parity-test oracle, not the installed extractor.

The adapter supplies the bundled verifier as `verifierPath`, an owner-private
staging parent, and a resolver from its opaque download handle to its private
archive path. The installed Electron executable runs the trusted verifier entry
in Node mode. The extracted app is never executed for verification. In Go-aware
builds the install/swap helpers are the attested Go entries; see
[runtime dependencies](development/runtime-dependencies.md) for the remaining
legacy/dev Python paths.

`createUpdatePackageVerifier().verifyPackage(handle, manifest)` rehashes
the actual regular archive through an `O_NOFOLLOW` descriptor, checks its
exact size, extracts into a disposable directory, and verifies the whole app
tree digest plus embedded source, build, bundle, version, signing, and pinned
runtime identity. It returns measured `PackageIdentity` including
`buildVersion`, and an in-memory binding from handle to the validated app
path for the install helper. On rejection, the disposable extraction is
removed. The caller discards a successful extraction after use; after a
restart it must reverify the private handle rather than trust a saved path.

The focused tests use synthetic ZIPs and mock package claims. They do not
prove a real package, installed N-to-N+1 update, or Gatekeeper behavior.
