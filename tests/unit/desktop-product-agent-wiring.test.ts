import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The native Product Agent host lives in apps/desktop/task/agent.ts and is
// tested there with injected ports. Nothing else checks which main-process
// state each port reads or writes, so a swapped getter or setter would pass
// every other test. This asserts the wiring as text; it executes nothing from
// main.ts.

const mainSource = path.resolve(
  import.meta.dirname,
  "../../src/apps/desktop/main.ts",
);

async function factoryBody(): Promise<{ source: string; body: string }> {
  const source = await readFile(mainSource, "utf8");
  const begin = source.indexOf("function productAgentHost() {");
  expect(begin).toBeGreaterThanOrEqual(0);
  const body = source
    .slice(begin, source.indexOf("\n}\n", begin) + 2)
    .replace(/\s+/g, " ");
  return { source, body };
}

describe("product agent host wiring in main", () => {
  it("lends each main-process let as a late getter", async () => {
    const { source, body } = await factoryBody();
    for (const name of [
      "configuration",
      "productAgentStore",
      "activeProductAgentSession",
      "persistedProductAgentExpiry",
    ])
      expect(body).toContain(`${name}: () => ${name},`);
    // The lets stay declared in main: their other readers are untouched.
    for (const declaration of [
      "let configuration: ProductConfigurationService | null = null;",
      "let productAgentStore: PrivateProductAgentStore | null = null;",
      "let activeProductAgentSession: ActiveProductAgentSession | null = null;",
      "let persistedProductAgentExpiry: Readonly<{",
      "type ActiveProductAgentSession = ProductAgentSession<ProductTaskCommandResult>;",
    ])
      expect(source).toContain(declaration);
    expect(source).toContain("let productAgentHostCache");
  });

  it("gives each setter an assignment to the let it names", async () => {
    const { body } = await factoryBody();
    for (const [setter, name] of Object.entries({
      setActiveProductAgentSession: "activeProductAgentSession",
      setPersistedProductAgentExpiry: "persistedProductAgentExpiry",
    }))
      expect(body).toContain(`${setter}: (value) => { ${name} = value; },`);
  });

  it("shares each const owner and main helper by reference", async () => {
    const { source, body } = await factoryBody();
    for (const name of [
      "taskFailure",
      "taskSuccess",
      "buildIdentity",
      "liveTaskRegistry",
      "taskMutations",
      "authorityTransitions",
      "persistLiveTaskState",
      "publishTasksState",
      "statePaths",
      "nativeWorkspace",
      "codexHostRuntimeRoot",
      "codexHostProcessHomePath",
      "codexHostHomeOption",
      "probeCodexHost",
      "launchCodexAppServer",
      "runProductAgentAssignment",
      "CodexNativeAgentHost",
      "CodexAgentWorkspaceProbe",
      "PrivateAssignmentStore",
      "CancelAgentAssignment",
      "AcknowledgeAgentResult",
      "randomUUID",
    ]) {
      expect(body).toContain(` ${name},`);
      // A shared owner must stay a const or a function, not become a lent `let`.
      expect(source).not.toMatch(new RegExp(`\\nlet ${name}\\b`));
    }
    expect(body).toContain(
      "productAgentEnabled: FAROL_BACKED_PRODUCT_AGENT_ENABLED,",
    );
    expect(body).toContain(
      "farolBackedProductAgentRoute: () => farolBackedProductAgentRoute(),",
    );
    expect(body).toContain('tempPath: () => app.getPath("temp"),');
    expect(body).toContain("clock: () => Date.now(),");
    expect(body).toContain(
      "setTimer: (callback, delayMs) => setTimeout(callback, delayMs),",
    );
    expect(body).toContain("clearTimer: (timer) => { clearTimeout(timer); },");
  });

  it("keeps only thin wrappers in main, each reaching the one lazily built instance", async () => {
    const { source } = await factoryBody();
    for (const [header, call] of [
      [
        "function productAgentCapabilityAvailable(): boolean {",
        "productAgentHost().productAgentCapabilityAvailable()",
      ],
      [
        "function persistProductAgentSummary(\n  taskId: string,\n  summary: ProductTaskAgent,\n): Promise<boolean> {",
        "productAgentHost().persistProductAgentSummary(taskId, summary)",
      ],
      [
        "function productAgentUnknownSummaryFromTask(\n  agent: ProductTaskAgent,\n): ProductTaskAgent {",
        "productAgentHost().productAgentUnknownSummaryFromTask(agent)",
      ],
      [
        "function productAgentAssignmentBinding(input: ProductAgentInput): string {",
        "productAgentHost().productAgentAssignmentBinding(input)",
      ],
      [
        "function productAgentAssignmentMatches(\n  agent: ProductTaskAgent,\n  input: ProductAgentInput,\n): boolean {",
        "productAgentHost().productAgentAssignmentMatches(agent, input)",
      ],
      [
        "function recoverProductAgentExpiry(): Promise<void> {",
        "productAgentHost().recoverProductAgentExpiry()",
      ],
      [
        "function cancelProductAgentTask(\n  task: ProductTask,\n): Promise<ProductTaskCommandResult> {",
        "productAgentHost().cancelProductAgentTask(task)",
      ],
    ] as const) {
      const begin = source.indexOf(header);
      expect(begin, header).toBeGreaterThanOrEqual(0);
      expect(source.slice(begin, source.indexOf("\n}\n", begin) + 3)).toBe(
        `${header}\n  return ${call};\n}\n`,
      );
    }
    const execute =
      'function executeProductAgent(\n  task: ProductTask,\n  input: ProductAgentInput,\n  context: ProductAgentContext,\n  admission: "new" | "rejoin",\n): Promise<ProductTaskCommandResult> {';
    const begin = source.indexOf(execute);
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(source.slice(begin, source.indexOf("\n}\n", begin) + 3)).toBe(
      `${execute}\n  return productAgentHost().executeProductAgent(\n    task,\n    input,\n    context,\n    admission,\n  );\n}\n`,
    );
    // The call sites that remain in main still reach them by the same names.
    expect(source).toContain("nativeAgent: productAgentCapabilityAvailable(),");
    expect(source).toContain("await recoverProductAgentExpiry();");
  });

  it("leaves none of the moved bodies behind", async () => {
    const { source } = await factoryBody();
    for (const fragment of [
      "async function openProductAgentSession(",
      "function openAdmittedProductAgentSession(",
      "function closeProductAgentSession(",
      "function productAgentSummary(",
      "function productAgentIdentity(",
      "function productAgentUnknownSummary(",
      "function armProductAgentExpiry(",
      "function schedulePersistedProductAgentExpiry(",
      "function performProductAgentCancellation(",
      "function cancelProductAgentSession(",
      "function tombstoneUnavailableProductAgent(",
      "const unavailableProductAgentHost",
      "const legacyProductAgentCleanupRoute",
      "const productAgentSessionReservation",
      "PRODUCT_AGENT_SESSION_BUSY",
      "PRODUCT_AGENT_HOST_CHANGED",
      "PRODUCT_AGENT_HOST_UNAVAILABLE",
      "productAgentSessionExpiryVerdict",
      "productAgentExpiryRecoveryVerdict",
      "new CancelAgentAssignment(",
      "new AcknowledgeAgentResult(",
      "farol-product-agent-binding-v1",
    ])
      expect(source).not.toContain(fragment);
    // The pending-task lookup is shared with the quit and admission guards.
    expect(source).toContain("function pendingProductAgentTaskId()");
  });
});
