# Installed release package verification

The producer CLI and the installed updater share `tooling/verify-package-content.mjs`.
The CLI retains its checkout version, source resource manifest, and canonical
candidate path checks. An exact `-owner.beta.N` package version selects the
GitHub owner beta policy; historical preview versions retain their original
policy. Installed verification instead takes exact version,
build version, and channel from the accepted GitHub release manifest. The
artifact's recorded path is ignored there because extraction has a new private
root. The extracted `artifact.json` must sit beside
`Farol Next Preview.app` in the ZIP.

The producer must bundle `tooling/verify-package-standalone.mjs` and its
imports into one trusted installed resource. The native adapter supplies that
resource as `verifierPath`, the pinned `resources/native/update_archive.py`
as `extractorPath`, an owner-private staging parent, and a resolver from its
opaque download handle to its private archive path. The installed Electron
executable runs the trusted verifier entry in Node mode. The extracted app is
never executed for verification.

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
