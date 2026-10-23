import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { parse } from "@babel/parser";
import { expect, it } from "vitest";
import { createTotalOperationsRecorder } from "../../apps/desktop/operations/recorder";

// Execute the actual desktop diagnostic sink and its selected callback values.
// Child/native mechanics are covered separately with controlled producers;
// this fixture is not an installed process or durable diagnostic witness.
const main = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
const host = fs.readFileSync("apps/desktop/go-core-host.ts", "utf8");
const mainTree = parse(main, { sourceType: "module", plugins: ["typescript"] });
const hostTree = parse(host, { sourceType: "module", plugins: ["typescript"] });

function selected(
  source: string,
  tree: unknown,
  choose: (node: Record<string, unknown>) => unknown,
): string {
  const matches: Record<string, unknown>[] = [];
  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (choose(node)) matches.push(node);
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object") visit(child);
    }
  }
  visit(tree);
  if (matches.length !== 1) throw Error("LIFECYCLE_COMPOSITION_MISSING");
  const node = matches[0]!;
  return source.slice(node.start as number, node.end as number);
}

function sink(fail = false, recordingFails = false) {
  const lines: string[] = [];
  const records: { outcome: string; code: string | null }[] = [];
  const recorder = createTotalOperationsRecorder({
    record: (_metadata, outcome, code) => {
      if (recordingFails) throw Error("CONTROLLED_RECORDER_CLOSED");
      records.push({ outcome, code });
    },
  });
  const declaration = selected(
    main,
    mainTree,
    (node) =>
      node.type === "FunctionDeclaration" &&
      (node.id as { name?: string } | undefined)?.name ===
        "reportOwnedBackendLifecycle",
  );
  const report = vm.runInNewContext(
    `${stripTypeScriptTypes(declaration)}; reportOwnedBackendLifecycle`,
    {
      operationsStore: () => recorder,
      console: {
        warn: (line: string) => {
          if (fail) throw Error("CONTROLLED_SINK_CLOSED");
          lines.push(line);
        },
      },
    },
  ) as (observation: unknown) => void;
  return { report, lines, records, diagnostics: () => recorder.diagnostics() };
}

const backend = {
  source: "go-backend",
  phase: "active",
  event: "child-close",
  code: "backend_child_closed",
  state: "observed",
  exitCode: 17,
  signal: null,
  forced: false,
  hostLifetimeId: "original-host",
  childLaunchId: "original-child",
};

it("reports original backend facts using a closed content-free projection", () => {
  const { report, lines } = sink();
  report({
    ...backend,
    requestBody: "CONTROLLED_PRIVATE_CONTENT",
    exception: "CONTROLLED_PRIVATE_CONTENT",
    toJSON: () => {
      throw Error("RAW_OBSERVATION_MUST_NOT_BE_SERIALIZED");
    },
  });
  expect(lines).toHaveLength(1);
  const record = JSON.parse(lines[0]!.split(":").slice(1).join(":"));
  expect(record).toEqual({ at: expect.any(String), ...backend });
  expect(lines[0]).not.toContain("CONTROLLED_PRIVATE_CONTENT");
});

it("reports an original tunnel generation without upgrading UNKNOWN to exit", () => {
  const { report, lines } = sink();
  const original = {
    source: "connector-tunnel",
    phase: "closing",
    event: "cleanup-unknown",
    code: "CONNECTOR_STOP_UNCONFIRMED",
    state: "outcome_unknown",
    exitCode: null,
    signal: null,
    forced: false,
    runtimeGeneration: "original-runtime",
  };
  report(original);
  expect(JSON.parse(lines[0]!.slice(lines[0]!.indexOf(":") + 1))).toEqual({
    at: expect.any(String),
    ...original,
  });
  expect(original.state).toBe("outcome_unknown");
});

it("isolates a closed diagnostic sink from original child settlement", () => {
  expect(() => sink(true).report(backend)).not.toThrow();
});

for (const route of ["go", "connector"] as const) {
  it(`selects the same diagnostic sink for the actual ${route} launch`, () => {
    const expression = selected(main, mainTree, (node) => {
      if (route === "go")
        return (
          node.type === "CallExpression" &&
          (node.callee as { name?: string }).name ===
            "startObservedDesktopGoCore"
        );
      return (
        node.type === "NewExpression" &&
        (node.callee as { name?: string }).name === "SecureMcpConnectorRuntime"
      );
    });
    const tree = parse(expression, {
      sourceType: "module",
      plugins: ["typescript"],
    });
    const callback = selected(expression, tree, (node) => {
      return (
        node.type === "ObjectProperty" &&
        (node.key as { name?: string }).name === "onLifecycleObservation"
      );
    });
    const report = sink().report;
    const selectedCallback = vm.runInNewContext(
      `({${stripTypeScriptTypes(callback)}}).onLifecycleObservation`,
      { reportOwnedBackendLifecycle: report },
    );
    expect(selectedCallback).toBe(report);
  });
}

it("forwards the selected original observer through the actual attested launch", () => {
  const property = selected(host, hostTree, (node) => {
    return (
      node.type === "ObjectProperty" &&
      (node.key as { name?: string }).name === "onLifecycleObservation"
    );
  });
  const report = sink().report;
  const callback = vm.runInNewContext(
    `({${stripTypeScriptTypes(property)}}).onLifecycleObservation`,
    { selection: { onLifecycleObservation: report } },
  );
  expect(callback).toBe(report);
});

it("omits an absent optional observer from the actual native launch object", () => {
  const call = selected(host, hostTree, (node) => {
    const callee = node.callee as
      { object?: { name?: string }; property?: { name?: string } } | undefined;
    return (
      node.type === "CallExpression" &&
      callee?.object?.name === "attested" &&
      callee.property?.name === "start"
    );
  });
  const budgetDeclaration = selected(
    host,
    hostTree,
    (node) =>
      node.type === "VariableDeclaration" &&
      (node.declarations as { id?: { name?: string } }[]).some(
        (value) => value.id?.name === "DESKTOP_CORE_STARTUP_TIMEOUT_MS",
      ),
  );
  const budget = vm.runInNewContext(
    `${stripTypeScriptTypes(budgetDeclaration)}; DESKTOP_CORE_STARTUP_TIMEOUT_MS`,
  );
  const options = vm.runInNewContext(stripTypeScriptTypes(call), {
    DESKTOP_CORE_STARTUP_TIMEOUT_MS: budget,
    attested: { start: (_budget: number, options: object) => options },
    profile: {},
    settings: { computer: { computerId: "controlled-only" } },
    storage: { storeMode: "open", settingsMutations: true },
    selection: { previousHostDrainConfirmed: true },
    hostLifetimeId: "controlled-host-lifetime",
    childLaunchId: "controlled-child-launch",
    codexRead: undefined,
    shellMetadata: undefined,
  });
  expect(Object.hasOwn(options, "onLifecycleObservation")).toBe(false);
  expect(Object.hasOwn(options, "codexRead")).toBe(false);
});

it("selects Shell for the actual desktop caller only in its supported layout", () => {
  const call = selected(
    main,
    mainTree,
    (node) =>
      node.type === "CallExpression" &&
      (node.callee as { name?: string }).name === "startObservedDesktopGoCore",
  );
  const tree = parse(call, { sourceType: "module", plugins: ["typescript"] });
  const property = selected(
    call,
    tree,
    (node) =>
      node.type === "ObjectProperty" &&
      (node.key as { name?: string }).name === "compiledShell",
  );
  const selector = selected(
    host,
    hostTree,
    (node) =>
      node.type === "FunctionDeclaration" &&
      (node.id as { name?: string }).name === "desktopShellSelection",
  );
  const compiledGoShell = {
    support: "controlled",
    watchdogSource: new Uint8Array(),
  };
  for (const runtimeEnvironment of ["dev", "preview"]) {
    for (const packaged of [false, true]) {
      const directory = packaged
        ? "/synthetic/Farol.app/Contents/Resources/app"
        : "/synthetic/repo/_output/build/app";
      const actual = vm.runInNewContext(
        `${stripTypeScriptTypes(selector)}; ({${stripTypeScriptTypes(property)}}).compiledShell`,
        {
          path,
          compiledGoShell,
          runtimeEnvironment,
          directory,
          installedResourcesOrigin: undefined,
        },
      );
      expect(actual).toBe(
        runtimeEnvironment === "dev" && !packaged ? undefined : compiledGoShell,
      );
    }
  }
});

it("uses the authenticated private image for the actual Go and Shell caller", () => {
  const call = selected(
    main,
    mainTree,
    (node) =>
      node.type === "CallExpression" &&
      (node.callee as { name?: string }).name === "startObservedDesktopGoCore",
  );
  const tree = parse(call, { sourceType: "module", plugins: ["typescript"] });
  const root = selected(
    call,
    tree,
    (node) =>
      node.type === "ObjectProperty" &&
      (node.key as { name?: string }).name === "artifactRoot",
  );
  const shell = selected(
    call,
    tree,
    (node) =>
      node.type === "ObjectProperty" &&
      (node.key as { name?: string }).name === "compiledShell",
  );
  const selector = selected(
    host,
    hostTree,
    (node) =>
      node.type === "FunctionDeclaration" &&
      (node.id as { name?: string } | undefined)?.name ===
        "desktopShellSelection",
  );
  const privateRoot = "/owner-private/Farol.app/Contents/Resources/app";
  const compiledGoShell = {
    support: "controlled",
    watchdogSource: new Uint8Array(),
  };
  const value = vm.runInNewContext(
    `${stripTypeScriptTypes(selector)}; ({${stripTypeScriptTypes(root)},${stripTypeScriptTypes(shell)}})`,
    {
      path,
      compiledGoShell,
      runtimeEnvironment: "preview",
      directory: "/Applications/Farol.app/Contents/Resources/app",
      installedResourcesOrigin: { execution: { directory: privateRoot } },
    },
  );
  expect(value.artifactRoot).toBe(privateRoot);
  expect(value.compiledShell).toBe(compiledGoShell);
});

it("keeps the original lifecycle diagnostic when operations recording throws", () => {
  const { report, lines } = sink(false, true);
  expect(() => report(backend)).not.toThrow();
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!.slice(lines[0]!.indexOf(":") + 1))).toMatchObject(
    backend,
  );
});

// Exercise the actual sink through the actual closed-code recorder. A producer
// observation alone cannot prove that durable Activity keeps its classification.
const lifecycleRecordingCases: [string, Record<string, unknown>, string][] = [
  ["requested clean exit", {}, "done"],
  ["unexpected active exit", { phase: "active" }, "unknown"],
  ["unexpected startup exit", { phase: "startup" }, "unknown"],
  ["forced exit", { forced: true }, "unknown"],
  ["nonzero exit", { exitCode: 1 }, "unknown"],
  ["signal exit", { exitCode: null, signal: "SIGTERM" }, "unknown"],
  ["conflicting terminal", { signal: "SIGTERM" }, "unknown"],
  ["missing terminal", { exitCode: null }, "unknown"],
  ["unavailable producer", { state: "unavailable" }, "unknown"],
  ["unknown producer", { state: "outcome_unknown" }, "unknown"],
  [
    "pending request",
    { event: "failure", code: "client_closed", state: "outcome_unknown" },
    "unknown",
  ],
  [
    "cleanup unknown",
    {
      event: "cleanup-unknown",
      code: "backend_cleanup_unconfirmed",
      state: "outcome_unknown",
    },
    "unknown",
  ],
];
it.each(lifecycleRecordingCases)(
  "preserves %s in the real operations recorder",
  (_name, change, expected) => {
    const { report, records, diagnostics } = sink();
    report({ ...backend, phase: "closing", exitCode: 0, ...change });
    expect(records).toEqual([
      { outcome: expected, code: change.code ?? "backend_child_closed" },
    ]);
    expect(diagnostics().unmappedCodes).toBe(0);
  },
);
