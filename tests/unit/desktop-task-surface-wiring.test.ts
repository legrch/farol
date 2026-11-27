import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The live-task surface helpers live in apps/desktop/task/surface.ts and are
// tested there with injected ports. Nothing else checks which main-process
// state each port reads, so a swapped getter would pass every other test. This
// asserts the wiring as text; it executes nothing from main.ts.

const mainSource = path.resolve(
  import.meta.dirname,
  "../../src/apps/desktop/main.ts",
);

async function factoryBody(): Promise<{ source: string; body: string }> {
  const source = await readFile(mainSource, "utf8");
  const begin = source.indexOf("function taskSurface() {");
  expect(begin).toBeGreaterThanOrEqual(0);
  const body = source
    .slice(begin, source.indexOf("\n}\n", begin) + 2)
    .replace(/\s+/g, " ");
  return { source, body };
}

describe("task surface wiring in main", () => {
  it("publishes every rollback of the live task registry", async () => {
    const source = await readFile(mainSource, "utf8");
    expect(source).toContain(
      "liveTaskRegistry.onRollback(() => publishTasksState());",
    );
  });

  it("lends the window as a late getter and the demo flag by value", async () => {
    const { source, body } = await factoryBody();
    expect(body).toContain("currentWindow: () => window,");
    // The let stays declared in main: its other readers are untouched.
    expect(source).toContain("let window: BrowserWindow | null = null;");
    expect(source).toContain("let taskSurfaceCache");
    // The flag is a const fixed at launch, so the value is the owner.
    expect(body).toContain(" demoMode,");
    expect(source).toMatch(
      /\nconst \{[^}]*\bdemoMode,[^}]*\} = readLaunchArguments\(/,
    );
  });

  it("shares each const owner and main helper by reference", async () => {
    const { source, body } = await factoryBody();
    for (const name of [
      "channels",
      "desktopAdmission",
      "liveTaskRegistry",
      "liveTaskRoutes",
      "taskSurfaceFailures",
      "persistLiveTaskState",
      "publishTaskSurfaceStatus",
      "applyLayout",
      "focusForLayoutAfterRendererCommit",
    ]) {
      expect(body).toContain(` ${name},`);
      // A shared owner must stay a const or a function, not become a lent `let`.
      expect(source).not.toMatch(new RegExp(`\\nlet ${name}\\b`));
    }
    expect(body).toContain(
      "parseResult: (candidate) => ProductTaskCommandResultSchema.parse(candidate),",
    );
  });

  it("keeps only thin wrappers in main, reaching the one lazily built instance", async () => {
    const { source } = await factoryBody();
    const wrapper = (header: string, call: string) => {
      const begin = source.indexOf(header);
      expect(begin, header).toBeGreaterThanOrEqual(0);
      expect(source.slice(begin, source.indexOf("\n}\n", begin) + 3)).toBe(
        `${header}\n  ${call};\n}\n`,
      );
    };
    wrapper(
      "function publishTasksState(): void {",
      "taskSurface().publishTasksState()",
    );
    wrapper(
      'function taskFailure(\n  error: Extract<ProductTaskCommandResult, { ok: false }>["error"],\n): ProductTaskCommandResult {',
      "return taskSurface().taskFailure(error)",
    );
    wrapper(
      "function taskSuccess(taskId: string | null): ProductTaskCommandResult {",
      "return taskSurface().taskSuccess(taskId)",
    );
    wrapper(
      "function surfaceLiveTaskPersistenceFailure(taskId: string): void {",
      "taskSurface().surfaceLiveTaskPersistenceFailure(taskId)",
    );
    wrapper(
      'function setLiveTaskLifecycle(\n  taskId: string,\n  lifecycle: ProductTask["lifecycle"],\n): void {',
      "taskSurface().setLiveTaskLifecycle(taskId, lifecycle)",
    );
    wrapper(
      "async function openLiveTaskSurface(taskId: string): Promise<boolean> {",
      "return taskSurface().openLiveTaskSurface(taskId)",
    );
    // None of the moved bodies is left behind.
    for (const fragment of [
      "TASK_SURFACE_UNREACHABLE",
      "const recordSurfaceFailure",
      "ProductTaskCommandResultSchema.parse({",
      "liveTaskRegistry.setLifecycle(",
      "channels.tasksState",
    ])
      expect(source).not.toContain(fragment);
  });
});
