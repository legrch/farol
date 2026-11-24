import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The `task.*` command switch lives in apps/desktop/task/command.ts and is
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
  const begin = source.indexOf("function taskCommands() {");
  expect(begin).toBeGreaterThanOrEqual(0);
  const body = source
    .slice(begin, source.indexOf("\n}\n", begin) + 2)
    .replace(/\s+/g, " ");
  return { source, body };
}

describe("task commands wiring in main", () => {
  it("lends each main-process let as a late getter", async () => {
    const { source, body } = await factoryBody();
    for (const [port, name] of Object.entries({
      selectedTaskId: "selectedTaskId",
      liveTaskStore: "liveTaskStore",
      activeProductAgentSession: "activeProductAgentSession",
      persistedProductAgentExpiry: "persistedProductAgentExpiry",
      configuration: "configuration",
      productAgentStore: "productAgentStore",
      chatGptRoute: "chatGptRoute",
    }))
      expect(body).toContain(`${port}: () => ${name},`);
    // The lets stay declared in main: their other readers are untouched.
    for (const declaration of [
      "let selectedTaskId: string",
      "let section: SurfaceSection",
      "let setupOpen = true;",
      "let shellOverlay: ShellOverlay",
      "let liveTaskStore: PrivateLiveTaskStore | null = null;",
      "let productAgentStore: PrivateProductAgentStore | null = null;",
      "let activeProductAgentSession: ActiveProductAgentSession | null = null;",
      "let persistedProductAgentExpiry: Readonly<{",
      "let configuration: ProductConfigurationService | null = null;",
      "let chatGptRoute: ChatGptRoute | null = null;",
    ])
      expect(source).toContain(declaration);
    expect(source).toContain("let taskCommandsCache");
  });

  it("gives every setter an assignment to the let it names", async () => {
    const { body } = await factoryBody();
    for (const [setter, name] of Object.entries({
      setSelectedTaskId: "selectedTaskId",
      setSection: "section",
      setShellOverlay: "shellOverlay",
      setSetupOpen: "setupOpen",
      setLiveTaskStore: "liveTaskStore",
      setPersistedProductAgentExpiry: "persistedProductAgentExpiry",
    }))
      expect(body).toContain(`${setter}: (value) => { ${name} = value; },`);
  });

  it("shares each const owner and main helper by reference", async () => {
    const { source, body } = await factoryBody();
    for (const name of [
      "taskFailure",
      "taskSuccess",
      "desktopAdmission",
      "demoMode",
      "taskMutations",
      "liveTaskRegistry",
      "liveTaskRoutes",
      "liveTaskConversationUrls",
      "routeBTaskLifecycle",
      "randomUUID",
      "applyLayout",
      "publishLayout",
      "publishTasksState",
      "openLiveTaskSurface",
      "persistLiveTaskState",
      "surfaceLiveTaskPersistenceFailure",
      "chatGptTaskAdmissionReady",
      "createLiveChatGptRoute",
      "pendingProductAgentTaskId",
      "productAgentAssignmentBinding",
      "productAgentAssignmentMatches",
      "productAgentUnknownSummaryFromTask",
      "persistProductAgentSummary",
      "executeProductAgent",
      "cancelProductAgentTask",
    ]) {
      expect(body).toContain(` ${name},`);
      // A shared owner must stay a const or a function, not become a lent `let`.
      expect(source).not.toMatch(new RegExp(`\\nlet ${name}\\b`));
    }
    expect(body).toContain(
      "parseCommand: (value) => ProductTaskCommandSchema.safeParse(value),",
    );
    expect(body).toContain(
      "productAgentEnabled: FAROL_BACKED_PRODUCT_AGENT_ENABLED,",
    );
    expect(body).toContain("buildId: buildIdentity.buildId,");
    expect(body).toContain("now: () => Date.now(),");
  });

  it("keeps only the thin wrapper in main, reaching the one lazily built instance", async () => {
    const { source } = await factoryBody();
    const header =
      "function runProductTaskCommandObserved(\n  value: unknown,\n): Promise<ProductTaskCommandResult> {";
    const begin = source.indexOf(header);
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(source.slice(begin, source.indexOf("\n}\n", begin) + 3)).toBe(
      `${header}\n  return taskCommands().run(value);\n}\n`,
    );
    // The observing wrapper still reaches it through that function.
    expect(source).toContain("() => runProductTaskCommandObserved(value),");
    // None of the moved bodies is left behind.
    for (const fragment of [
      "task.activate",
      "task.start-agent",
      "task.rejoin-agent",
      "task.create-chatgpt",
      "ChatGPT task ${ordinal}",
      "startAgentDurable",
      "admitProductAgentRejoin",
      "resolveProductAgentScope",
      "function productAgentInput(",
    ])
      expect(source).not.toContain(fragment);
  });
});
