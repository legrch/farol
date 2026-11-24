import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The live-task persistence lives in apps/desktop/task/persist.ts and is tested
// there with injected ports. Nothing else checks which main-process state each
// port reads or writes, so a swapped getter or setter would pass every other
// test. This asserts the wiring as text; it executes nothing from main.ts.

const mainSource = path.resolve(
  import.meta.dirname,
  "../../src/apps/desktop/main.ts",
);

async function factoryBody(): Promise<{ source: string; body: string }> {
  const source = await readFile(mainSource, "utf8");
  const begin = source.indexOf("function taskPersist() {");
  expect(begin).toBeGreaterThanOrEqual(0);
  const body = source
    .slice(begin, source.indexOf("\n}\n", begin) + 2)
    .replace(/\s+/g, " ");
  return { source, body };
}

describe("task persist wiring in main", () => {
  it("lends each main-process let as a late getter and a setter that assigns", async () => {
    const { source, body } = await factoryBody();
    for (const name of [
      "liveTaskStore",
      "liveTaskPersistence",
      "chatGptHomeUrl",
    ])
      expect(body).toContain(`${name}: () => ${name},`);
    for (const [setter, name] of Object.entries({
      setLiveTaskStore: "liveTaskStore",
      setLiveTaskPersistence: "liveTaskPersistence",
      setLiveTaskRegistryRestored: "liveTaskRegistryRestored",
      setSelectedTaskId: "selectedTaskId",
    }))
      expect(body).toContain(`${setter}: (value) => { ${name} = value; },`);
    // The lets stay declared in main: their other readers are untouched.
    for (const declaration of [
      "let liveTaskStore: PrivateLiveTaskStore | null = null;",
      "let liveTaskRegistryRestored = false;",
      "let liveTaskPersistence: Promise<void> = Promise.resolve();",
      "let selectedTaskId: string",
      "let chatGptHomeUrl",
    ])
      expect(source).toContain(declaration);
    expect(source).toContain("persistence: () => liveTaskPersistence");
    expect(source).toContain("let taskPersistCache");
  });

  it("shares each const owner and function by reference and builds the real store", async () => {
    const { body } = await factoryBody();
    for (const name of [
      "liveTaskRegistry",
      "liveTaskRoutes",
      "liveTaskConversationUrls",
      "statePaths",
      "createLiveChatGptRoute",
      "publishTasksState",
      "surfaceLiveTaskPersistenceFailure",
    ])
      expect(body).toContain(` ${name},`);
    expect(body).toContain(
      "openStore: (root, hooks) => new PrivateLiveTaskStore({ root }, hooks),",
    );
    expect(body).toContain("env: process.env,");
  });

  it("keeps only thin wrappers in main, reaching the one lazily built instance", async () => {
    const { source } = await factoryBody();
    const wrapper = (header: string, call: string) => {
      const begin = source.indexOf(header);
      expect(begin, header).toBeGreaterThanOrEqual(0);
      expect(source.slice(begin, source.indexOf("\n}\n", begin) + 3)).toBe(
        `${header}\n  return taskPersist().${call};\n}\n`,
      );
    };
    wrapper("function persistLiveTaskState(): Promise<void> {", "persist()");
    wrapper(
      "async function markLiveTaskRunningDurable(taskId: string): Promise<boolean> {",
      "markRunningDurable(taskId)",
    );
    wrapper(
      "async function initializeLiveTaskState(): Promise<void> {",
      "initialize()",
    );
    expect(source).not.toMatch(/\nfunction storedLiveTaskState\(/);
    // None of the moved bodies is left behind.
    for (const fragment of [
      "LIVE_TASK_STATE_UNAVAILABLE",
      "LIVE_TASK_E2E_SAVE_FAULT",
      "liveTaskRegistry.markRunningDurable(",
      "liveTaskRegistry.restore(",
    ])
      expect(source).not.toContain(fragment);
  });
});
