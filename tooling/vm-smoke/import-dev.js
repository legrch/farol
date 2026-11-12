// Credential import remains blocked until a qualified descriptor-rooted guest
// helper can reject unsafe parents and durably order the uncertainty fence,
// credential, commit receipt and final clear (file fsync + directory fsync).
// Do not inspect receipts or read secret bytes through this unqualified route:
// neither missing nor unreadable evidence can authorize an import here.
function run() {
  throw Error("GUEST_IMPORT_PERSISTENCE_UNQUALIFIED");
}
