// The expected cases of every evidence lane, declared independently of what a
// run happens to record.  A run proves a case only by executing it; a case the
// runner could not execute must appear among its blocked cases with a reason.
// A case that is neither executed nor blocked is missing, however green the
// run's own label is.  tests/integration/evidence-cases-contract.test.mjs keeps
// this list and the runner's push sites from drifting apart silently.
//
// The boundary vector says what a lane can prove at all.  Every current lane
// drives local fixtures for the provider and the native host, so none of them
// can satisfy a requirement whose minimum boundary is a live provider,
// connector or installed host.

const SHARED_PRODUCT_CASES = Object.freeze([
  "ordinary-native-codex-agent-lineage-verified",
  "demo-native-codex-agent-lineage-verified",
  "ordinary-native-agent-workspace-enforcement-verified",
  "demo-native-agent-workspace-enforcement-verified",
  "ordinary-native-agent-bounded-rejoin",
  "demo-native-agent-bounded-rejoin",
  "ordinary-native-agent-result-delivery-acknowledged",
  "demo-native-agent-result-delivery-acknowledged",
  "ordinary-native-agent-evidence-content-free",
  "demo-native-agent-evidence-content-free",
  "second-launch-waits-for-complete-primary-startup",
  "second-launch-rejects-failed-primary-startup",
  "ordinary-launch-has-no-synthetic-tasks",
  "ordinary-new-task-opens-actual-chatgpt-surface",
  "ordinary-live-task-embedded-in-watch-rail",
  "five-live-chatgpt-task-capacity",
  "sixth-live-task-refused-without-replacement",
  "live-task-global-sections-preserve-native-surfaces",
  "live-task-compact-overlay-bounds",
  "live-task-requested-observed-state-truthful",
  "live-task-rename-pin-close-and-capacity-recovery",
  "live-task-close-disposes-exact-surface",
  "live-task-registry-private-content-free-persistence",
  "live-task-same-conversation-after-process-restart",
  "shared-chatgpt-session-single-download-guard",
  "idle-live-task-cancel-refused-truthfully",
  "running-live-task-cancel-confirmed-once",
  "live-task-native-agent-product-objective",
  "live-task-native-agent-same-child-rejoin",
  "live-task-native-agent-result-delivery-acknowledged",
  "live-task-native-agent-private-input",
  "live-task-native-agent-content-free-recovery",
  "live-task-native-agent-owner-exact-path-narrowing",
  "live-task-native-agent-cancel-confirmed",
  "live-task-native-agent-expiry-cancelled-after-restart",
  "live-task-context-preservation-visible",
  "live-task-context-handoff-survives-restart",
  "live-task-context-confirmation-retires-source",
  "chatgpt-dispatch-intent-restart-no-resubmit",
  "chatgpt-recovered-result-delivery-acknowledged",
  "running-build-version-and-time",
  "explicit-demo-retains-synthetic-fixtures",
  "native-codex-host-live-tool-verified",
  "chatgpt-context-preview-cancel",
  "chatgpt-readonly-task-incremental-result",
  "chatgpt-attachment-image-and-document",
  "chatgpt-attachment-staging-cleanup",
  "chatgpt-task-result-delivery-acknowledged",
  "chatgpt-task-journal-content-free",
  "chatgpt-same-conversation-after-window-close",
  "chatgpt-conversation-binding-content-free",
  "settings-links-to-computer-workspaces",
  "native-agent-proof-invalidated-by-computer-generation",
  "connector-refuses-unheld-summary-fence",
  "connector-start-admitted-when-fence-reconciled",
  "workspace-app-list-search",
  "workspace-command-disabled-by-default",
  "workspace-command-authority-explicit",
  "workspace-command-fixed-no-network",
  "workspace-command-exact-head",
  "workspace-write-access-explicit",
  "workspace-guarded-edit-atomic",
  "workspace-command-observes-real-change",
  "support-export-content-free",
  "support-export-native-agent-state-current",
  "keyboard-focus",
  "quick-switcher-native-focus-transfer",
  "traffic-light-and-fullscreen-geometry",
  "layout-breakpoints-long-content",
  "hit-targets-measured",
  "accessible-contrast-measured",
  "reduced-motion-measured",
  "workspace-command-persists-and-runs-after-restart",
  "chatgpt-same-conversation-after-process-restart",
  "chatgpt-explicit-conversation-reset",
  "visible-window-secondary-display",
  "visible-window-show-inactive",
  "isolated-state-root",
  "task-network-default-deny",
  "task-capability-isolation",
  "two-tabs-independent",
  "incremental-before-terminal",
  "computer-exact-correlation",
  "watch-rail-native-geometry",
  "sidebar-native-menu-and-shortcut",
  "settings-native-menu-and-global-chrome",
  "rail-hit-targets-and-titlebar-clearance",
  "compact-sidebar-overlay-hides-native-page",
  "task-menu-hides-native-page",
  "quick-switcher-keyboard-navigation",
  "inactive-window-appearance",
  "geist-resource-loaded",
  "setup-hides-native-page",
  "activity-redaction",
  "activity-detail-preference",
  "compact-layout",
  "stable-layout-geometry",
  "client-delivery-acknowledged",
  "first-run-setup-journey",
  "settings-setup-reentry",
  "native-workspace-picker-save-readback",
  "workspace-native-verification",
  "workspace-read-preview-not-persisted",
  "workspace-exclusion-effective",
  "settings-controls-persist-after-restart",
  "setup-position-and-dismissal-persist",
  "chatgpt-next-partition-readiness",
  "chatgpt-popup-and-expiry-recovery",
  "chatgpt-session-persists-after-restart",
  "mismatched-build-second-launch-rejected",
  "second-launch-reuses-single-instance",
  "window-close-reopen-keeps-runtime",
  "window-reopen-restores-runtime-connection",
  "isolated-start-order-legacy-then-next",
  "provider-failure-state",
  "task-stream-failure-isolation",
  "utility-process-sigkill-state",
  "isolated-start-order-next-then-legacy",
  "next-only-failure-preserves-legacy-fixture",
  "utility-process-sigkill-after-runtime-ready",
  "utility-process-sigkill-during-first-view-load",
  "utility-process-sigkill-during-second-view-load",
  "fault-scenarios-remain-hidden",
  "quit-terminates-exact-owned-processes",
  "ux34-settings-widths-readable",
  "ux34-settings-setup-details-bounded",
  "ux34-sidebar-toggle-roundtrip",
  "ux34-sidebar-setup-continue-double-click",
  "ux34-sign-in-window-owned",
  "ux34-sign-in-blocked-navigation-reported",
  "ux34-sign-in-return-handler",
  "ux34-sign-in-return-pointer",
  "ux34-sign-in-return-keyboard",
  "ux34-sign-in-return-pointer-after-blocked-navigation",
  "ux34-covered-return-fails-input-proof",
  "n04b-model-not-connected-before-preview",
  "n04b-model-preview-shows-diff",
  "n04b-model-decline-changes-nothing",
  "n04b-model-apply-writes-managed-block",
  "n04b-model-connected-after-served-request",
  "n04b-model-rollback-restores-config",
  "n04b-model-preview-decline-idempotent",
  "n04b-model-default-provider-consented",
  "n04b-model-rotate-refuses-stale-bearer",
  "n04b-model-rollback-restores-owner-bytes",
  "n09-connector-start-names-earliest-unmet-prerequisite",
  "n09-connector-started-with-synthetic-client",
  "n09-connector-running-freezes-its-own-configuration",
  "n09-connector-stop-clears-runtime-and-challenge",
  "n09-attach-challenge-answered-by-local-peer",
  "n09-attach-challenge-answered-exactly-once",
  "n09-attach-verified-from-its-own-receipt",
  "n11-agent-denied-subfolder-refused",
  "n11-agent-subfolder-narrows-delivered-root",
  "n11-agent-exclusion-reaches-the-delivered-assignment",
  "n12-agent-draft-survives-background-auth-window-return",
  "n12-agent-draft-survives-to-a-single-submission",
  "n12-agent-draft-cleared-by-owner-close",
  "n12-agent-draft-refused-after-authority-change",
  "n10-computer-second-workspace-added-from-panel",
  "n10-computer-workspace-removed-from-panel-and-settings",
  "n10-computer-guarded-edit-cancelled-file-unchanged",
  "n10-computer-lost-edit-record-is-the-products-own",
  "n10-computer-lost-edit-reply-redelivered-after-restart",
]);

const SEALED_PACKAGE_CASES = Object.freeze([
  "malformed-artifact-rejected",
  "copied-destination-verified",
  "rewritten-build-identity-rejected",
  "manifest-redirected-artifact-rejected",
  "tampered-artifact-rejected",
  "legacy-private-resource-rejected",
  "wrong-helper-bundle-rejected",
  "tampered-launcher-rejected",
  "tampered-runtime-rejected",
  "packaged-launcher-identity",
]);

const LOCAL_FIXTURE_BOUNDARY = Object.freeze({
  filesystem: "real-temporary",
  process: "real-owned",
  provider: "fixture",
  connector: "fixture",
  nativeHost: "fixture",
  display: "secondary-inactive",
});

const LIFECYCLE_SOAK_CASES = Object.freeze([
  "fifty-task-create-close-cycles",
  "five-concurrent-task-surfaces",
  "alternating-task-menu-and-quick-switcher-overlays",
  "two-same-state-application-recoveries",
  "zero-provider-surfaces-after-each-batch",
  "single-shared-download-guard",
  "single-runtime-process",
  "bounded-process-fd-resource-and-memory-trend",
  "zero-task-restart",
]);

// The outputs a lane's runner records for every attempt; acceptance re-reads
// them and refuses an attempt whose recorded bytes are gone or different.
const PRODUCT_REPORT = Object.freeze(["report.json"]);

export const EVIDENCE_LANES = Object.freeze({
  "development-build": Object.freeze({
    root: "artifacts/e2e-dev",
    requiredByproducts: PRODUCT_REPORT,
    cases: Object.freeze([
      "development-build-identity",
      ...SHARED_PRODUCT_CASES,
    ]),
    boundary: Object.freeze({
      ...LOCAL_FIXTURE_BOUNDARY,
      build: "development-electron",
    }),
  }),
  "sealed-package": Object.freeze({
    root: "artifacts/e2e",
    requiredByproducts: PRODUCT_REPORT,
    cases: Object.freeze([...SEALED_PACKAGE_CASES, ...SHARED_PRODUCT_CASES]),
    boundary: Object.freeze({
      ...LOCAL_FIXTURE_BOUNDARY,
      build: "sealed-package",
    }),
  }),
  "lifecycle-soak": Object.freeze({
    root: "artifacts/lifecycle-soak",
    requiredByproducts: PRODUCT_REPORT,
    cases: LIFECYCLE_SOAK_CASES,
    boundary: Object.freeze({
      ...LOCAL_FIXTURE_BOUNDARY,
      build: "development-electron",
      display: "hidden",
    }),
  }),
  // The same workload, seed, budgets and cases driven through the sealed
  // package's own launcher: what the owner would run, measured as such.
  "lifecycle-soak-packaged": Object.freeze({
    root: "artifacts/lifecycle-soak-packaged",
    requiredByproducts: PRODUCT_REPORT,
    cases: LIFECYCLE_SOAK_CASES,
    boundary: Object.freeze({
      ...LOCAL_FIXTURE_BOUNDARY,
      build: "sealed-package",
      display: "hidden",
    }),
  }),
  "persistence-fault": Object.freeze({
    root: "artifacts/persistence-fault",
    requiredByproducts: PRODUCT_REPORT,
    cases: Object.freeze([
      "conversation-url-save-failure-is-visible",
      "lifecycle-save-failure-is-outcome-unknown",
      "later-mutation-fails-closed",
      "last-durable-snapshot-is-not-advanced",
    ]),
    boundary: Object.freeze({
      ...LOCAL_FIXTURE_BOUNDARY,
      build: "development-electron",
      display: "hidden",
      fault: "simulated",
    }),
  }),
  // Two sealed generations in turn on one isolated state: the predecessor a
  // manifest names, qualified by its own pinned verifier, and the candidate.
  // The crashes are real process kills, not simulated faults.
  "two-generation-state": Object.freeze({
    root: "artifacts/two-generation-state",
    requiredByproducts: PRODUCT_REPORT,
    cases: Object.freeze([
      "predecessor-qualified-by-own-pinned-verifier",
      "generation-a-establishes-owner-state",
      "second-generation-refused-while-first-owns-state",
      "context-handoff-survives-generation-switch",
      "crash-with-running-turn-leaves-no-process",
      "interrupted-activation-leaves-state-readable",
      "second-generation-reads-first-generation-state",
      "running-turn-restored-as-outcome-unknown-without-resubmit",
      "first-generation-refused-while-second-owns-state",
      "newer-generation-completes-older-handoff",
      "second-generation-change-survives-restart",
      "rollback-reads-newer-state-without-rewriting-it",
      "generation-bytes-unchanged",
    ]),
    boundary: Object.freeze({
      ...LOCAL_FIXTURE_BOUNDARY,
      build: "sealed-package",
      display: "hidden",
      fault: "process-kill",
    }),
  }),
  hunt: Object.freeze({
    root: "artifacts/hunt",
    requiredByproducts: Object.freeze(["path.json"]),
    cases: Object.freeze([
      "tests/hunt/selftest.test.ts",
      "tests/hunt/proof.test.ts",
      "tests/hunt/model.test.ts",
    ]),
    boundary: Object.freeze({
      filesystem: "none",
      process: "hermetic-model",
      provider: "none",
      connector: "none",
      nativeHost: "none",
      display: "none",
      build: "development",
    }),
  }),
});

// An observation a run records about itself is not always a claim that the
// run failed. A run that lost the application before its own close could
// inspect it has proved nothing about quitting and must stay FAIL; a run
// that merely saw a surface move under the driver while every assertion
// passed has proved what it claims, and failing the lane for that would
// downgrade ledger rows for something no case asserted.
//
// Severity is explicit and its absence means blocking, so a kind added
// without thinking about this keeps the stricter behaviour rather than
// quietly losing it.
export function blockingObservations(observations) {
  return observations.filter((entry) => entry.severity !== "informational");
}

export function laneContract(lane) {
  const contract = EVIDENCE_LANES[lane];
  if (contract === undefined) throw new Error(`EVIDENCE_LANE_UNKNOWN:${lane}`);
  return contract;
}

// Cases a lane requires that a run neither executed nor explicitly blocked.
export function missingCases(lane, executed, blocked = []) {
  const seen = new Set([...executed, ...blocked.map((entry) => entry.name)]);
  return laneContract(lane).cases.filter((name) => !seen.has(name));
}
