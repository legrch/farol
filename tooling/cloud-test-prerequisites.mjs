// Explicit host-resource boundaries for the Cloud SOURCE profile.
// Full native CI and its coverage thresholds remain unchanged.
export const cloudDeferredFiles = Object.freeze(
  [
    ...[
      "promotion-lease.test.ts",
      "promotion-lease-fence.test.ts",
      "promotion-flow.test.mjs",
      "promotion-apply.test.mjs",
      "promotion-lease-descriptor.test.mjs",
      "startup-promotion-lease-native.test.ts",
      "core-profile-storage.test.ts",
      "go-core-startup.test.ts",
      "update-archive.test.mjs",
      "update-package-resource-types.test.mjs",
      "native-verification-command.test.ts",
      "readonly-computer-mcp.test.ts",
    ].map((name) => ({
      file: "tests/integration/" + name,
      prerequisite:
        "Darwin native owner, Apple tools or reviewed native compiler",
      mixed: false,
    })),
    ...[
      "replace-installed-preview.test.mjs",
      "promote-preview-cli.test.mjs",
      "sandboxed-workspace-shell.test.ts",
      "execution-fence.test.ts",
      "summary-fence-recovery.test.ts",
      "summary-execution-fence.test.ts",
      "product-configuration-desktop-wiring.test.ts",
      "product-configuration-workspace-edit-lease.test.ts",
      "installed-update-helper.test.mjs",
      "installed-update-helper-closed.test.mjs",
      "installed-update-helper-readiness.test.mjs",
      "installed-update-runtime.test.ts",
      "package-platform.test.mjs",
      "runtime-contract.test.mjs",
      "native-mutable-workspace.test.ts",
      "mutable-computer-action.test.ts",
      "mutable-computer-mcp.test.ts",
      "repository-config-access.test.ts",
      "workspace-snapshot.test.ts",
      "workspace-snapshot-bounded.test.ts",
      "workspace-bootstrap-mcp.test.ts",
    ].map((name) => ({
      file: "tests/integration/" + name,
      prerequisite:
        "Mixed integration suite needs Darwin lease, atomic exchange, APFS or Apple runtime resources",
      mixed: true,
    })),
    ...[
      "installed-execution-snapshot.test.ts",
      "supervised-update-backup.test.mjs",
      "supervised-update-resources.test.mjs",
    ].map((name) => ({
      file: "tests/integration/" + name,
      prerequisite:
        "Physical ancestor owner chain (UID0/effective UID) and installed resource custody",
      mixed: true,
    })),
    ...[
      "native-readonly-workspace.test.ts",
      "readonly-computer-action.test.ts",
      "dev-mcp-proof.test.ts",
    ].map((name) => ({
      file: "tests/integration/" + name,
      prerequisite:
        "Legacy helper fixtures require supported Python3.9; Apple interpreter attestation remains separate",
      mixed: true,
    })),
    {
      file: "tests/integration/release-archive.test.mjs",
      prerequisite: "Trusted Node at the producer's fixed clean search paths",
      mixed: true,
    },
    {
      file: "tests/integration/go-connector-launch.test.ts",
      prerequisite: "Connector's fixed physical /private/tmp socket parent",
      mixed: true,
    },
  ].map((entry) => Object.freeze(entry)),
);

// Keep the portable cases of these mixed files in Cloud. Test names are literal,
// not a failed-test list. New files are included by default.
export const cloudMixedFiles = Object.freeze(
  [
    {
      file: "tests/integration/build-provenance.test.mjs",
      excludedTests: [
        "finds this checkout's compiler and bundled packages byte-identical to the reviewed install",
        "authenticates this checkout's compiler and refuses a redirected one",
      ],
      prerequisite:
        "Exact independently reviewed platform-specific compiler install",
    },
    {
      file: "tests/integration/installed-computer-drain.test.ts",
      excludedTests: [
        "refuses active read/write leases without stopping them, then excludes new work during drain",
        "preserves unknown shell markers, summary fences and dispatch locks",
      ],
      prerequisite: "Darwin physical execution fence",
    },
    {
      file: "tests/integration/saved-chat-bridge.test.ts",
      excludedTests: [
        "keeps the desktop execution lease until a disconnected Browser operation ends",
      ],
      prerequisite: "Darwin physical execution fence",
    },
    {
      file: "tests/integration/route-b-task-lifecycle.test.ts",
      excludedTests: [
        "S35-H1-1 a later turn whose lease is stolen between the entry check and its durable running mark is refused before submission, and the task stays idle",
      ],
      prerequisite: "Darwin promotion lease and exact adversary child",
    },
    {
      file: "tests/integration/readonly-computer-digest.test.ts",
      includedSuite: "closed full/window public read response",
      prerequisite: "Other suite needs legacy Python3.9 and Darwin atomic edit",
    },
  ].map((entry) =>
    Object.freeze({
      ...entry,
      ...(entry.excludedTests
        ? { excludedTests: Object.freeze(entry.excludedTests) }
        : {}),
    }),
  ),
);

export function cloudSelection(files) {
  const deferred = new Set();
  for (const entry of [...cloudDeferredFiles, ...cloudMixedFiles]) {
    if (!files.includes(entry.file) || deferred.has(entry.file))
      throw Error("CLOUD_PREREQUISITE_DECLARATION_INVALID:" + entry.file);
    if (!entry.prerequisite) throw Error("CLOUD_PREREQUISITE_REASON_MISSING");
    deferred.add(entry.file);
  }
  const excluded = new Set(cloudDeferredFiles.map((entry) => entry.file));
  return {
    selected: files.filter((file) => !excluded.has(file)),
    deferredFiles: cloudDeferredFiles,
    mixedFiles: cloudMixedFiles,
  };
}

const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function cloudPattern(entry) {
  if (entry.includedSuite)
    return "^" + escapePattern(entry.includedSuite) + " ";
  if (!entry.excludedTests?.length) throw Error("CLOUD_MIXED_SELECTION_EMPTY");
  return (
    "^(?!.*(?:" + entry.excludedTests.map(escapePattern).join("|") + ")).*$"
  );
}
