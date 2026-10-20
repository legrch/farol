import fs from "node:fs/promises";
import path from "node:path";
import {
  BUILD_ENTRIES,
  bridgeEntrySets,
  verifyBuildEntries,
} from "./build-contract.mjs";
import { GO_CORE_ENTRIES } from "./go-core-artifact.mjs";
import { NATIVE_SAFE_OPEN_HELPER } from "./native-helper-contract.mjs";
import { ELECTRON_RUNTIME } from "./runtime-contract.mjs";

// Resource identity only; the existing archive producer owns its bytes. Keep
// this verifier independent of compiler/process initialization on module import.
const nativeArchiveResource = "update-archive.py";

export const RUNTIME_CLASSES = Object.freeze([
  "legacy-python-active",
  "go-with-legacy-python",
  "legacy-system-tool",
  "app-bundled-electron",
  "optional-user-executable",
  "confined-user-command",
  "app-owned-go-executable",
]);
const launch = (
  id,
  file,
  symbol,
  api,
  executable,
  classification,
  resources = [],
) => ({
  id,
  file,
  symbol,
  api,
  executable,
  classification,
  resources,
  count: 1,
});
const desktop = "src/apps/desktop/";
const computer = "src/modules/computer/infra/native/";
const release = "src/modules/release/infra/native/";
const chat = "src/modules/chat/infra/native/";

// Exceptions describe unresolved runtime dependencies. They are not approval,
// qualification or evidence that Python/toolchain requirements were eliminated.
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export const RUNTIME_LAUNCH_MANIFEST = freeze({
  schema: "farol-runtime-launches/1",
  roots: ["src", "apps/desktop", "modules", "boot", "cmd"],
  launches: [
    launch(
      "release.update-go",
      release + "installed-update-helper.ts",
      "startInstalledUpdateHelper",
      "spawn",
      "executable",
      "app-owned-go-executable",
      ["farol-backend"],
    ),
    launch(
      "release.slot-binding",
      release + "installed-update-helper.ts",
      "publishInstalledOperationBinding",
      "spawn",
      "executable",
      "app-owned-go-executable",
      ["farol-backend"],
    ),
    launch(
      "computer.workspace-python",
      computer + "native-readonly-workspace.ts",
      "runHelper",
      "spawn",
      "interpreter",
      "legacy-python-active",
      [NATIVE_SAFE_OPEN_HELPER.output],
    ),
    launch(
      "computer.snapshot-python",
      computer + "workspace-snapshot.ts",
      "spawnSnapshotHelper",
      "spawn",
      "interpreter",
      "legacy-python-active",
      [NATIVE_SAFE_OPEN_HELPER.output],
    ),
    launch(
      "desktop.closed-process-observation",
      desktop + "closed-computer-recovery.ts",
      "assertClosedConnectorProcesses",
      "execFileSync",
      '"/bin/ps"',
      "legacy-system-tool",
    ),
    launch(
      "desktop.codex-launch",
      desktop + "codex-app-server-process.ts",
      "launchCodexAppServer.start",
      "spawn",
      "input.executablePath",
      "optional-user-executable",
    ),
    launch(
      "desktop.codex-probe",
      desktop + "codex-host-probe.ts",
      "runCodexProbe",
      "execFile",
      "command.executablePath",
      "optional-user-executable",
    ),
    launch(
      "desktop.codesign",
      desktop + "executable-discovery.ts",
      "runCodesign",
      "execFile",
      "CODESIGN_PATH",
      "legacy-system-tool",
    ),
    launch(
      "desktop.model-process-observation",
      desktop + "farol-model-host-presence.ts",
      "psProcessLister",
      "execFile",
      '"/bin/ps"',
      "legacy-system-tool",
    ),
    launch(
      "desktop.installed-script",
      desktop + "installed-update-runtime.ts",
      "runInstalledTrusted",
      "execFile",
      "execution?.executable??process.execPath",
      "app-bundled-electron",
      ["update-obligations.mjs", "update-package.mjs", "update-slot.mjs"],
    ),
    launch(
      "desktop.installed-process-observation",
      desktop + "installed-update-runtime.ts",
      "readInstalledProcess",
      "execFile",
      '"/bin/ps"',
      "legacy-system-tool",
    ),
    launch(
      "desktop.preview-runtime",
      desktop + "main.ts",
      "startRuntime",
      "spawn",
      "resources.executable",
      "app-bundled-electron",
      ["runtime.cjs"],
    ),
    launch(
      "desktop.run-marker",
      desktop + "run-marker.ts",
      "readProcessStart",
      "execFileSync",
      '"/bin/ps"',
      "legacy-system-tool",
    ),
    launch(
      "desktop.connector-probe",
      desktop + "secure-mcp-connector-runtime.ts",
      "runCommand",
      "execFile",
      "command.executablePath",
      "optional-user-executable",
    ),
    launch(
      "desktop.connector-runtime",
      desktop + "secure-mcp-connector-runtime.ts",
      "startProcess",
      "spawn",
      "electronPath",
      "app-bundled-electron",
      ["computer-mcp.cjs"],
    ),
    launch(
      "desktop.tunnel-probe",
      desktop + "tunnel-client-probe.ts",
      "runProbe",
      "execFile",
      "command.executablePath",
      "optional-user-executable",
    ),
    launch(
      "task.shared-proxy",
      chat + "shared-codex-proxy-host.ts",
      "SharedCodexProxyHost.attach",
      "spawn",
      "input.executablePath",
      "optional-user-executable",
    ),
    launch(
      "task.git-identity-compatibility",
      chat + "physical-codex-handoff-authority.ts",
      "commonDirectory",
      "execFile",
      "GIT",
      "legacy-system-tool",
    ),
    launch(
      "computer.measure-system-tool",
      computer + "native-readonly-workspace.ts",
      "runExact",
      "spawn",
      "executable",
      "legacy-system-tool",
    ),
    launch(
      "computer.verification-system-tool",
      computer + "native-verification-command.ts",
      "runExact",
      "spawn",
      "executable",
      "legacy-system-tool",
    ),
    launch(
      "computer.verification-sandbox",
      computer + "native-verification-command.ts",
      "runSandboxedGit",
      "spawn",
      "SANDBOX_EXEC",
      "legacy-system-tool",
    ),
    launch(
      "computer.shell-watchdog",
      computer + "sandboxed-workspace-shell.ts",
      "SandboxedWorkspaceShell.startAdmitted",
      "spawn",
      "process.execPath",
      "app-bundled-electron",
    ),
    launch(
      "release.helper-process-observation",
      release + "installed-update-helper.ts",
      "captureInstalledProcessStart",
      "execFile",
      '"/bin/ps"',
      "legacy-system-tool",
    ),
    launch(
      "release.helper-relaunch",
      "modules/release/infra/native/process/launch.go",
      "Open",
      "go.CommandContext",
      '"/usr/bin/open"',
      "legacy-system-tool",
    ),
    launch(
      "release.go-process-observation",
      "modules/release/infra/native/processprobe/native.go",
      "nativeBoundary.prepare",
      "go.Command",
      '"/bin/ps"',
      "legacy-system-tool",
    ),
    launch(
      "release.archive-go",
      release + "update-package-verifier.ts",
      "createUpdatePackageVerifier.verifyPackage",
      "execFile",
      "extractorCopy",
      "app-owned-go-executable",
      [nativeArchiveResource],
    ),
    launch(
      "release.package-verifier-runtime",
      release + "update-package-verifier.ts",
      "createUpdatePackageVerifier.verifyPackage",
      "execFile",
      "execution?.nodeExecutable??options.nodeExecutable??process.execPath",
      "app-bundled-electron",
    ),
    launch(
      "desktop.go-core",
      "apps/desktop/bridge/client.ts",
      "spawnCore",
      "spawn",
      "executable",
      "app-owned-go-executable",
      ["farol-backend"],
    ),
    launch(
      "desktop.recovery-go",
      "apps/desktop/bridge/empty-recovery-child.ts",
      "prepareEmptyRecoveryChild",
      "spawn",
      "executable",
      "app-owned-go-executable",
      ["farol-backend"],
    ),
    launch(
      "desktop.preserved-recovery-go",
      "apps/desktop/bridge/preserved-recovery-child.ts",
      "preparePreservedRecoveryChild",
      "spawn",
      "executable",
      "app-owned-go-executable",
      ["farol-backend"],
    ),
    launch(
      "desktop.preserved-inspection-go",
      "apps/desktop/bridge/preserved-inspection-child.ts",
      "runPreservedInspectionChild",
      "spawn",
      "executable",
      "app-owned-go-executable",
      ["farol-backend"],
    ),
    launch(
      "desktop.terminal-go",
      "apps/desktop/bridge/terminal-recorder.ts",
      "recordTerminal",
      "spawn",
      "executable",
      "app-owned-go-executable",
      ["farol-backend"],
    ),
    launch(
      "task.go-proxy",
      "modules/task/infra/clients/codex/nativedarwin.go",
      "nativeBoundary.Launch",
      "go.Command",
      "s.ExecutablePath",
      "optional-user-executable",
    ),
    launch(
      "computer.go-command",
      "modules/computer/infra/process/spawn.go",
      "nativeBoundary.Start",
      "go.Command",
      "launch.command.Executable",
      "confined-user-command",
    ),
    launch(
      "computer.go-watchdog",
      "modules/computer/infra/process/watchdogdarwin.go",
      "nativeWatchdogHost.Start",
      "go.Command",
      "selection.Executable.Path",
      "app-bundled-electron",
    ),
    launch(
      "computer.go-held-guest",
      "modules/computer/infra/process/heldguestdarwin.go",
      "nativeHeldBoundary.Exec",
      "go.syscall.Exec",
      "command.Executable",
      "confined-user-command",
    ),
  ],
  embedded: [
    {
      file: computer + "shell-watchdog-source.ts",
      symbol: "SHELL_WATCHDOG_SOURCE",
      classification: "confined-user-command",
      expressions: ["selected.executable", "message.executable"],
    },
    {
      file: desktop + "secure-mcp-connector-runtime.ts",
      symbol: "CONNECTOR_GROUP_ANCHOR",
      classification: "optional-user-executable",
      expressions: ["process.argv[1]"],
    },
  ],
  commands: [
    {
      id: "computer.settings.search",
      file: desktop + "main.ts",
      symbol: "configureAdmittedProduct",
      command: "computer.search-workspace",
      classification: "selected-go",
      requiredCall: "desktopGoCore.searchSettingsWorkspace",
      allowedCalls: [
        "verifiedProductWorkspace",
        "configurationFailure",
        "configuration.snapshot",
        "desktopGoCore.searchSettingsWorkspace",
        "ProductConfigurationResultSchema.parse",
        "Number",
        "result.matches.map",
        "workspaceReadFailure",
      ],
    },
  ],
  resources: [
    {
      key: "farol-backend",
      ledger: "core",
      kind: "go-macho",
      owner: "tooling/go-core-artifact.mjs",
      mode: "executable",
    },
    {
      key: nativeArchiveResource,
      ledger: "build",
      kind: "go-macho",
      owner: "tooling/native-archive-build.mjs",
      mode: "executable",
    },
    ...[
      "main.cjs",
      "runtime.cjs",
      "computer-mcp.cjs",
      "update-obligations.mjs",
      "update-package.mjs",
      "update-slot.mjs",
    ].map((key) => ({
      key,
      ledger: "build",
      kind: "electron-script",
      owner: "tooling/build-contract.mjs",
      mode: "data",
    })),
    {
      key: NATIVE_SAFE_OPEN_HELPER.output,
      ledger: "build",
      kind: "python-source",
      owner: "tooling/native-helper-contract.mjs",
      mode: "data",
    },
    {
      key: "update-helper.py",
      ledger: "build",
      kind: "python-source",
      owner: "tooling/build.mjs",
      mode: "data",
    },
  ],
  boundaries: [
    {
      id: "vendor.electron",
      classification: "app-bundled-electron",
      owner: "tooling/runtime-contract.mjs",
      detail: `Pinned nested ${ELECTRON_RUNTIME.executable} runtime/tree; verified by existing runtime/package owners, not host Node.`,
    },
    {
      id: "user.git-hooks-python",
      classification: "optional-user-hook-runtime",
      owner: "apps/desktop/bridge/shell-support.ts",
      detail:
        "Optional user repository hooks may use CLT Python; not an app helper and not counted as eliminated.",
    },
    {
      id: "developer.toolchains",
      classification: "build-test-maintenance-only",
      owner: "tooling/build-contract.mjs",
      detail:
        "tooling/ and tests/ may use build, maintenance or parity toolchains; excluded from application launch inventory.",
    },
  ],
});

function exact(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}
function fail(code) {
  throw new Error(`RUNTIME_LAUNCH_${code}`);
}
const relative = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  !value.startsWith("/") &&
  value.split("/").every((part) => part && part !== "." && part !== "..");
export function assertRuntimeLaunchManifest(manifest) {
  if (
    !exact(manifest, [
      "schema",
      "roots",
      "launches",
      "embedded",
      "commands",
      "resources",
      "boundaries",
    ]) ||
    manifest.schema !== "farol-runtime-launches/1"
  )
    fail("MANIFEST_INVALID");
  for (const field of [
    "roots",
    "launches",
    "embedded",
    "commands",
    "resources",
    "boundaries",
  ])
    if (!Array.isArray(manifest[field])) fail("MANIFEST_INVALID");
  if (
    !manifest.roots.every(relative) ||
    new Set(manifest.roots).size !== manifest.roots.length
  )
    fail("ROOTS_INVALID");
  const ids = new Set();
  for (const row of manifest.launches) {
    if (
      !exact(row, [
        "id",
        "file",
        "symbol",
        "api",
        "executable",
        "classification",
        "resources",
        "count",
      ]) ||
      !relative(row.file) ||
      !["id", "symbol", "api", "executable"].every(
        (key) => typeof row[key] === "string" && row[key],
      ) ||
      ![
        "spawn",
        "spawnSync",
        "exec",
        "execSync",
        "execFile",
        "execFileSync",
        "fork",
        "go.Command",
        "go.CommandContext",
        "go.syscall.Exec",
        "go.unix.Exec",
        "go.os.StartProcess",
      ].includes(row.api) ||
      !RUNTIME_CLASSES.includes(row.classification) ||
      !Number.isSafeInteger(row.count) ||
      row.count < 1 ||
      row.count > 16 ||
      !Array.isArray(row.resources) ||
      ids.has(row.id)
    )
      fail("LAUNCH_INVALID");
    ids.add(row.id);
  }
  const resources = new Set();
  for (const row of manifest.resources) {
    if (
      !exact(row, ["key", "ledger", "kind", "owner", "mode"]) ||
      !relative(row.key) ||
      row.key.includes("/") ||
      !relative(row.owner) ||
      !["go-macho", "electron-script", "python-source"].includes(row.kind) ||
      !["executable", "data"].includes(row.mode) ||
      (row.kind === "go-macho") !== (row.mode === "executable") ||
      !["build", "core"].includes(row.ledger) ||
      resources.has(row.key)
    )
      fail("RESOURCE_INVALID");
    if (
      !(row.ledger === "core" ? GO_CORE_ENTRIES : BUILD_ENTRIES).includes(
        row.key,
      )
    )
      fail("RESOURCE_LEDGER_UNKNOWN");
    resources.add(row.key);
  }
  for (const row of manifest.launches)
    if (!row.resources.every((key) => resources.has(key)))
      fail("RESOURCE_UNMANIFESTED");
  const embedded = new Set();
  for (const row of manifest.embedded) {
    if (
      !exact(row, ["file", "symbol", "classification", "expressions"]) ||
      !relative(row.file) ||
      typeof row.symbol !== "string" ||
      !row.symbol ||
      !RUNTIME_CLASSES.includes(row.classification) ||
      !Array.isArray(row.expressions) ||
      !row.expressions.every((x) => typeof x === "string" && x) ||
      embedded.has(`${row.file}:${row.symbol}`)
    )
      fail("EMBEDDED_INVALID");
    embedded.add(`${row.file}:${row.symbol}`);
  }
  for (const row of manifest.commands) {
    if (
      !exact(row, [
        "id",
        "file",
        "symbol",
        "command",
        "classification",
        "requiredCall",
        "allowedCalls",
      ]) ||
      !relative(row.file) ||
      row.classification !== "selected-go" ||
      !["id", "symbol", "command", "requiredCall"].every(
        (key) => typeof row[key] === "string" && row[key],
      ) ||
      !Array.isArray(row.allowedCalls) ||
      !row.allowedCalls.every((call) => typeof call === "string" && call) ||
      !row.allowedCalls.includes(row.requiredCall) ||
      ids.has(row.id)
    )
      fail("COMMAND_INVALID");
    ids.add(row.id);
  }
  for (const row of manifest.boundaries) {
    if (
      !exact(row, ["id", "classification", "owner", "detail"]) ||
      ![
        "app-bundled-electron",
        "optional-user-hook-runtime",
        "build-test-maintenance-only",
      ].includes(row.classification) ||
      !relative(row.owner) ||
      typeof row.id !== "string" ||
      !row.id ||
      typeof row.detail !== "string" ||
      !row.detail ||
      ids.has(row.id)
    )
      fail("BOUNDARY_INVALID");
    ids.add(row.id);
  }
  return manifest;
}

function macho(bytes) {
  return (
    bytes.length >= 4 &&
    [
      "cffaedfe",
      "feedfacf",
      "cefaedfe",
      "feedface",
      "cafebabe",
      "bebafeca",
    ].includes(bytes.subarray(0, 4).toString("hex"))
  );
}

// Complements existing byte/provenance validators. entrySha256 must be the
// caller's independently selected existing build/package ledger. This function
// never creates a hash expectation or grants provenance from measured bytes.
export async function verifyRuntimeExecutableClosure({
  directory,
  entrySha256,
  manifest = RUNTIME_LAUNCH_MANIFEST,
  entries = [...BUILD_ENTRIES, ...GO_CORE_ENTRIES].sort(),
}) {
  assertRuntimeLaunchManifest(manifest);
  // Only the bridge alternatives of the full ledger: the exact set, or that set
  // minus the retired Python update helper (build-contract.mjs).
  const selected = bridgeEntrySets([...BUILD_ENTRIES, ...GO_CORE_ENTRIES]).find(
    (candidate) =>
      candidate.length === entries.length &&
      candidate.every((entry, index) => entry === entries[index]),
  );
  if (!selected) fail("ENTRY_SET_INVALID");
  const declared = new Map(manifest.resources.map((row) => [row.key, row]));
  const known = new Set([
    ...BUILD_ENTRIES,
    ...GO_CORE_ENTRIES,
    "build-manifest.json",
    "package.json",
    // Added by the existing package owner after build entry production; the
    // package verifier checks its attribution bytes and whole-package digest.
    "THIRD_PARTY_NOTICES.txt",
  ]);
  const names = await fs.readdir(directory);
  if (names.length > known.size) fail("PACKAGE_ENTRY_UNMANIFESTED");
  let totalBytes = 0;
  for (const name of names) {
    const file = path.join(directory, name);
    const stat = await fs.lstat(file);
    const row = declared.get(name);
    if (!known.has(name)) fail("PACKAGE_ENTRY_UNMANIFESTED");
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size < 1 ||
      stat.size > 128 * 1024 * 1024
    )
      fail("PACKAGE_ENTRY_TYPE");
    totalBytes += stat.size;
    if (totalBytes > 256 * 1024 * 1024) fail("PACKAGE_SIZE_LIMIT");
    const handle = await fs.open(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    let prefix;
    try {
      prefix = Buffer.alloc(256);
      const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
      prefix = prefix.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    const binary = macho(prefix);
    const executable = (stat.mode & 0o111) !== 0;
    const shebang = prefix.subarray(0, 2).toString() === "#!";
    if (row && (stat.mode & 0o022) !== 0) fail("EXECUTABLE_MODE_INVALID");
    if (!row && (binary || executable || shebang))
      fail("EXECUTABLE_UNMANIFESTED");
    if (
      row &&
      ((row.mode === "executable") !== executable ||
        (row.kind === "go-macho") !== binary ||
        (row.kind === "electron-script" && shebang) ||
        (row.kind === "python-source" &&
          !prefix.toString("utf8").includes("python") &&
          shebang))
    )
      fail("EXECUTABLE_KIND_MISMATCH");
  }
  await verifyBuildEntries(directory, entrySha256, selected);
  return {
    resources: manifest.resources.length,
    byteAuthority: "existing-build-package-validators",
    nativeQualification: false,
  };
}
