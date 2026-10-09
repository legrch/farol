// Small source selection map for unit/component, integration and fast scopes.
// Full assembled E2E and live qualification keep their existing separate gates.
import path from "node:path";

export const scopes = Object.freeze(["unit", "integration", "fast"]);
// Whole mixed files stay integration: actual OS/compiler semantics or real
// production collaborators, despite their legacy unit-directory placement.
export const integrationUnitFiles = Object.freeze([
  "tests/unit/go-backend-build.test.mjs",
  "tests/unit/renderer-foundation.test.mjs",
  "tests/unit/farol-model-report-identity.test.mjs",
  "tests/unit/attested-core.test.ts",
  "tests/unit/go-core-artifact.test.mjs",
  "tests/unit/github-release-transport.test.ts",
  "tests/unit/desktop-environment.test.ts",
  "tests/unit/checkpoint-policy.test.mjs",
  "tests/unit/await-phases.test.mjs",
  "tests/unit/desktop-build-defines.test.mjs",
  "tests/unit/shell-display-identity.test.ts",
  "tests/unit/codex-caller-relay-receipt.test.ts",
  "tests/unit/browser-pump.test.ts",
  "tests/unit/core-host-context.test.ts",
  "tests/unit/go-core-host.test.ts",
  "tests/unit/go-computer-authority.test.ts",
]);
export const propertyUnitFiles = Object.freeze([
  "tests/hunt/model.test.ts",
  "tests/hunt/proof.test.ts",
  "tests/hunt/selftest.test.ts",
]);
// Reviewed pure policies, source contracts and single adapters with fake ports.
// Their legacy integration-directory names do not establish a real boundary.
export const unitIntegrationFiles = Object.freeze([
  "tests/e2e/current-react-setup-action.test.mjs",
  "tests/e2e/setup-config-error-child.test.mjs",
  "tests/integration/build-identity-contract.test.mjs",
  "tests/integration/candidate-contract.test.mjs",
  "tests/integration/completion-ledger-apply-verdicts.test.mjs",
  "tests/integration/owner-launch-result.test.mjs",
  "tests/integration/soak-retention.test.mjs",
  "tests/integration/host-compaction-codec.test.ts",
  "tests/integration/codex-native-tool-registry.test.ts",
  "tests/integration/saved-chat-preview-admission.test.ts",
  "tests/integration/codex-project-selection.test.ts",
  "tests/integration/agent-draft-contract.test.mjs",
  "tests/integration/e2e-harness-waits.test.mjs",
  "tests/integration/e2e-runner-recovery.test.mjs",
  "tests/integration/e2e-selection.test.mjs",
  "tests/integration/evidence-cases-contract.test.mjs",
  "tests/integration/ipc-registration-contract.test.ts",
  "tests/integration/resource-manifest.test.mjs",
  "tests/integration/route-b-check-admission-contract.test.mjs",
  "tests/integration/task-menu-note-contract.test.mjs",
  "tests/integration/watch-rail-product-contract.test.mjs",
  "tests/integration/farol-model-host-presence.test.ts",
  "tests/integration/codex-project-task-discovery.test.ts",
  "tests/integration/computer-connector-drain.test.ts",
  "tests/integration/claude-task-process-peer.test.ts",
  "tests/integration/codex-host-compaction.test.ts",
  "tests/integration/codex-host-smoke.test.ts",
  "tests/integration/codex-chatgpt-host-route.test.ts",
  "tests/integration/codex-app-server-client.test.ts",
  "tests/integration/saved-chat-browser.test.ts",
  "tests/integration/fixture-socket-failures.test.mjs",
  "tests/integration/owned-mcp-fixture-lifecycle.test.mjs",
  "tests/integration/owner-fixture-supervisor.test.mjs",
]);
export const fastIntegrationFiles = Object.freeze([
  "tests/integration/chat-turn.test.ts",
  "tests/integration/agent-delivery.test.ts",
  "tests/integration/context-continuity.test.ts",
  "tests/unit/codex-caller-relay-receipt.test.ts",
]);
export const nodeSelftests = Object.freeze([
  "tests/fixtures/ordinary-git-environment.selftest.mjs",
]);

function uniquePaths(files) {
  if (!Array.isArray(files) || files.length === 0)
    throw Error("TEST_DISCOVERY_EMPTY");
  const seen = new Set();
  for (const file of files) {
    if (
      typeof file !== "string" ||
      !file ||
      file.startsWith("/") ||
      file.includes("\\") ||
      file.split("/").includes("..") ||
      seen.has(file)
    ) {
      throw Error("TEST_DISCOVERY_INVALID");
    }
    seen.add(file);
  }
  return [...seen].sort();
}

export function classifyTests(files) {
  const all = uniquePaths(files);
  const nodeUnit = [],
    renderer = [],
    integration = [];
  const goUnit = new Set(),
    goIntegration = new Set(),
    goRelease = new Set();
  for (const file of all) {
    if (nodeSelftests.includes(file)) {
      continue;
    } else if (/^tests\/renderer\/.+\.test\.tsx?$/u.test(file)) {
      renderer.push(file);
    } else if (/^tests\/.+\.test\.(ts|tsx|mjs)$/u.test(file)) {
      if (integrationUnitFiles.includes(file)) integration.push(file);
      else if (
        file.startsWith("tests/unit/") ||
        propertyUnitFiles.includes(file) ||
        unitIntegrationFiles.includes(file)
      )
        nodeUnit.push(file);
      else if (
        /^tests\/(integration|architecture|contract|hunt|e2e\/fixtures)\//u.test(
          file,
        )
      )
        integration.push(file);
      else throw Error("TEST_SCOPE_UNCLASSIFIED:" + file);
    } else if (file.endsWith("_test.go")) {
      const directory = path.posix.dirname(file);
      if (
        /^modules\/[^/]+\/(app|domain)(\/|$)/u.test(directory) ||
        directory === "pkg/ipc"
      ) {
        goUnit.add("./" + directory);
      } else if (directory.startsWith("resources/native/go/")) {
        goRelease.add("./" + directory.slice("resources/native/go/".length));
      } else if (
        /^(boot|gen|modules|pkg|tests\/(native|fixtures)|transport)(\/|$)/u.test(
          directory,
        )
      ) {
        goIntegration.add("./" + directory);
      } else throw Error("GO_TEST_SCOPE_UNCLASSIFIED:" + file);
    } else throw Error("TEST_SCOPE_UNCLASSIFIED:" + file);
  }
  for (const file of [
    ...integrationUnitFiles,
    ...unitIntegrationFiles,
    ...propertyUnitFiles,
    ...fastIntegrationFiles,
    ...nodeSelftests,
  ]) {
    if (!all.includes(file))
      throw Error("TEST_SCOPE_DECLARATION_MISSING:" + file);
  }
  for (const file of fastIntegrationFiles) {
    if (!integration.includes(file))
      throw Error("TEST_FAST_SCOPE_INVALID:" + file);
  }
  return {
    all,
    nodeUnit,
    renderer,
    integration,
    goUnit: [...goUnit].sort(),
    goIntegration: [...goIntegration].sort(),
    goRelease: [...goRelease].sort(),
  };
}

export function planTests(scope, files) {
  if (!scopes.includes(scope)) throw Error("TEST_SCOPE_INVALID");
  const classified = classifyTests(files);
  const plan = [];
  const vitest = (id, selected, config) => {
    if (!selected.length) throw Error("TEST_SCOPE_EMPTY:" + id);
    plan.push({
      id,
      runner: "vitest",
      cwd: ".",
      files: [...selected].sort(),
      ...(config ? { config } : {}),
      timeoutMs: scope === "integration" ? 300000 : 180000,
    });
  };
  const go = (id, packages, cwd = ".") => {
    if (!packages.length) throw Error("TEST_SCOPE_EMPTY:" + id);
    plan.push({ id, runner: "go", cwd, packages, timeoutMs: 180000 });
  };
  if (scope === "unit" || scope === "fast") {
    const selected =
      scope === "fast"
        ? [...new Set([...classified.nodeUnit, ...fastIntegrationFiles])]
        : classified.nodeUnit;
    vitest("node-" + scope, selected);
    vitest("renderer-unit", classified.renderer, "vitest.renderer.config.ts");
    go("go-unit", classified.goUnit);
  } else {
    // Native/compiler files can each take over a minute. Bound serial groups
    // independently instead of terminating the whole collection after 5 minutes.
    for (let start = 0; start < classified.integration.length; start += 16) {
      vitest(
        "node-integration-" + String(start / 16 + 1).padStart(2, "0"),
        classified.integration.slice(start, start + 16),
      );
    }
    go("go-integration", classified.goIntegration);
    go("go-release-integration", classified.goRelease, "resources/native/go");
    plan.push({
      id: "node-git-integration",
      runner: "node",
      cwd: ".",
      files: [...nodeSelftests],
      timeoutMs: 60000,
    });
  }
  return {
    version: 1,
    scope,
    prerequisites: {
      node: ["24.20.0", "26.7.0"],
      go: "1.26.2",
      dependencies: "Already installed locally; no automatic acquisition",
      integrationHost: "Current native suites require macOS and system Git",
    },
    claim:
      scope === "fast"
        ? "unit/component plus explicitly fast browser-free integration"
        : scope + " only",
    limits: [
      "No assembled-product E2E, installed or live qualification",
      "Standalone native/browser .e2e.mjs witnesses remain separate explicit entrypoints",
      "Provider-free selection; full process-tree containment is not established by this runner",
    ],
    discovery: {
      files: classified.all.length,
      nodeUnit: classified.nodeUnit.length,
      renderer: classified.renderer.length,
      integration: classified.integration.length,
      goUnitPackages: classified.goUnit.length,
      goIntegrationPackages: classified.goIntegration.length,
      nestedGoPackages: classified.goRelease.length,
      nodeSelftests: nodeSelftests.length,
    },
    suites: plan,
  };
}
