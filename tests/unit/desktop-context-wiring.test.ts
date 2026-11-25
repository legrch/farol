import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The Route B and context host lives in apps/desktop/task/context.ts and is
// tested there with injected ports. Nothing else checks which main-process
// state each port reads, or that every reader in main still reads the owner's
// cell at the place it always did, so a swapped getter or a reader left on a
// stale copy would pass every other test. This asserts the wiring as text; it
// executes nothing from main.ts.

const mainSource = path.resolve(
  import.meta.dirname,
  "../../src/apps/desktop/main.ts",
);

const fixtureSource = path.resolve(
  import.meta.dirname,
  "../../apps/desktop/dev/fixture.ts",
);

async function read(): Promise<{
  source: string;
  block: string;
  flat: string;
}> {
  const source = await readFile(mainSource, "utf8");
  const begin = source.indexOf("\nconst contextHost = createContextHost({");
  expect(begin).toBeGreaterThanOrEqual(0);
  const block = source
    .slice(begin, source.indexOf("\n});\n", begin) + 4)
    .replace(/\s+/g, " ");
  return { source, block, flat: source.replace(/\s+/g, " ") };
}

describe("Route B and context host wiring in main", () => {
  it("lends each main let as a late getter and keeps every let declared", async () => {
    const { source, block } = await read();
    expect(block).toContain(" liveTaskStore: () => liveTaskStore,");
    expect(block).toContain(
      " liveTaskRegistryRestored: () => liveTaskRegistryRestored,",
    );
    expect(block).toContain(" callerRelay: () => bridge.relay.get(),");
    for (const name of ["liveTaskStore", "liveTaskRegistryRestored"]) {
      // A lent variable stays a `let` main owns, not a copy taken at creation.
      expect(source).toMatch(new RegExp(`\\nlet ${name}\\b`));
    }
  });

  it("shares each const owner, main helper and constructor by reference, assigning nothing back", async () => {
    const { source, block } = await read();
    for (const name of [
      "statePaths",
      "contextOwnerId",
      "contextProviderProfileId",
      "contextModel",
      "taskMutations",
      "liveTaskRegistry",
      "liveTaskRoutes",
      "liveTaskConversationUrls",
      "routeBTaskSurfaces",
      "persistLiveTaskState",
      "publishTasksState",
      "openLiveTaskSurface",
      "createLiveChatGptRoute",
      "createContextSummaryFallbackRoute",
      "createCodexContextController",
      "startRouteBRuntime",
    ]) {
      expect(block).toContain(` ${name},`);
      expect(source).not.toMatch(new RegExp(`\\nlet ${name}\\b`));
    }
    expect(block).toContain(
      " createExecutionFence: (root) => new PrivateExecutionFence({ root }),",
    );
    expect(block).not.toMatch(/\(value\) =>/);
    expect(block).not.toMatch(/ set[A-Z]\w*:/);
  });

  it("declares none of the four handles in main and keeps neither initializer nor the moved bodies", async () => {
    const { source, flat } = await read();
    for (const name of [
      "codexContextController",
      "summaryExecutionFence",
      "summaryFenceRecovery",
      "routeBRuntime",
    ]) {
      expect(source).not.toMatch(new RegExp(`\\nlet ${name}\\b`));
      expect(source).not.toMatch(new RegExp(`\\b${name}\\s*=[^=>]`));
    }
    // The drain, supervisor and start ports keep their names, each reading
    // the owner's cell.
    expect(source).not.toMatch(/\bcodexContextController\b/);
    for (const name of [
      "initializeRouteBRuntime",
      "initializeCodexContextController",
      "reconcileContextAfterRestart",
      "recordSummaryFenceRecovery",
    ])
      expect(source).not.toContain(`function ${name}`);
    for (const fragment of [
      "TASK_STATE_UNAVAILABLE",
      "TASK_CAPACITY_REACHED",
      "Codex task ${ordinal}",
      "summary-fence-recovery.json",
      "sweepOrphanTaskContexts(",
      "recoverSummaryExecutionFence(",
      "new PrivateExecutionFence({ root: statePaths",
    ])
      expect(flat).not.toContain(fragment);
    expect(source.match(/createContextHost\(/g)).toHaveLength(1);
  });

  it("keeps only thin wrappers for the binding and the admission, reaching the one owner", async () => {
    const { source } = await read();
    const wrapper = (header: string, call: string) => {
      const begin = source.indexOf(header);
      expect(begin, header).toBeGreaterThanOrEqual(0);
      expect(source.slice(begin, source.indexOf("\n}\n", begin) + 3)).toBe(
        `${header}\n  return contextHost.${call};\n}\n`,
      );
    };
    wrapper(
      "function contextBinding(taskId: string): ContextBinding {",
      "binding(taskId)",
    );
    wrapper(
      "async function admitRouteBTask(\n  threadId: string,\n): Promise<RouteBSurfaceAdmission> {",
      "admitRouteBTask(threadId)",
    );
    expect(source).toContain("  admitTask: admitRouteBTask,");
  });

  it("creates the owner at module level after the Route B surfaces and before main", async () => {
    const { source } = await read();
    const created = source.indexOf("\nconst contextHost = createContextHost({");
    for (const earlier of [
      "\nconst taskMutations = ",
      "\nconst liveTaskRegistry = ",
      "\nconst liveTaskRoutes = ",
      "\nconst liveTaskConversationUrls = ",
      "\nlet liveTaskStore",
      "\nlet liveTaskRegistryRestored",
      "\nconst bridge = createBridge({",
      "\nconst routeBTaskSurfaces: RouteBTaskSurfaces = {",
    ]) {
      const at = source.indexOf(earlier);
      expect(at, earlier).toBeGreaterThanOrEqual(0);
      expect(created, earlier).toBeGreaterThan(at);
    }
    expect(created).toBeLessThan(source.indexOf("\nasync function main("));
  });

  it("starts the context controller, its recovery and Route B in that order at startup", async () => {
    const { flat } = await read();
    expect(flat).toContain(
      "await contextHost.initializeCodexContextController(); await contextHost.reconcileContextAfterRestart(); await bridge.initializeCallerRelay(); await bridge.initializeSavedChatBridge(); await contextHost.initializeRouteBRuntime(); });",
    );
    for (const call of [
      "initializeCodexContextController",
      "reconcileContextAfterRestart",
      "initializeRouteBRuntime",
    ])
      expect(
        flat.match(new RegExp(`await contextHost\\.${call}\\(`, "g")),
      ).toHaveLength(1);
  });

  it("reads the fence, the controller and the runtime through the cells where the Route B lifecycle does", async () => {
    const { flat } = await read();
    expect(flat).toContain(
      "owns: (taskId) => contextHost.routeB.get()?.owns(taskId) ?? false,",
    );
    expect(flat).toContain(
      'deleteContext: (taskId) => { const controller = contextHost.controller.get(); return controller ? deleteTaskContext( controller.store, contextBinding(taskId), contextHost.fence.get() ?? undefined, ) : Promise.resolve("none"); },',
    );
  });

  it("lends the fence recovery and the runtime to the other owners as getters on the cells", async () => {
    const { source } = await read();
    expect(
      source.match(
        /summaryFenceRecovery: \(\) => contextHost\.recovery\.get\(\),/g,
      ),
    ).toHaveLength(3);
    expect(
      source.match(/routeBRuntime: \(\) => contextHost\.routeB\.get\(\),/g),
    ).toHaveLength(2);
    expect(source).toContain(
      "  summaryExecutionFence: () => contextHost.fence.get(),",
    );
  });

  it("reads the controller for the E2E context fixture at the start of the call", async () => {
    // The fixture moved to apps/desktop/dev/fixture.ts; main lends it the same
    // owners by reference and the call still reads the cell at its start.
    const { flat } = await read();
    const fixture = (await readFile(fixtureSource, "utf8")).replace(
      /\s+/g,
      " ",
    );
    expect(flat).toContain(
      " liveTaskRegistry, contextHost, contextBinding, contextModel, buildHostCompactionHandoff, }",
    );
    expect(fixture).toContain(
      'const task = liveTaskRegistry.get(taskId); const controller = contextHost.controller.get(); if (!task || task.provider !== "chatgpt" || !controller) { return { error: "CONTEXT_FIXTURE_UNAVAILABLE" }; } const binding = contextBinding(taskId);',
    );
  });

  it("serves the model endpoint from the runtime read at call time", async () => {
    const { flat } = await read();
    expect(flat).toContain(
      "routeBTurn: () => routeBModelTurnHandler(() => contextHost.routeB.get()?.endpoint ?? null),",
    );
    expect(flat).toContain(
      "routeBCompaction: () => routeBModelCompactionHandler( () => contextHost.routeB.get()?.endpoint ?? null, ),",
    );
  });

  it("takes the runtime once at Quit, clears it, and closes it before the relay", async () => {
    const { flat } = await read();
    expect(flat).toContain(
      'const routeB = contextHost.routeB.get(); contextHost.routeB.set(null); if (routeB) closers.push({ name: "route-b", close: () => routeB.close() }); const relay = bridge.relay.get();',
    );
  });
});
