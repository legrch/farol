import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The preview runtime child lives in apps/desktop/runtime/host.ts and is tested
// there with injected ports. Nothing else checks which main-process state each
// port reads or writes, so a swapped getter or setter would pass every other
// test. This asserts the wiring as text; it executes nothing from main.ts.

const mainSource = path.resolve(
  import.meta.dirname,
  "../../src/apps/desktop/main.ts",
);

async function factoryBody(): Promise<{ source: string; body: string }> {
  const source = await readFile(mainSource, "utf8");
  const begin = source.indexOf("function previewRuntime() {");
  expect(begin).toBeGreaterThanOrEqual(0);
  const body = source
    .slice(begin, source.indexOf("\n}\n", begin) + 2)
    .replace(/\s+/g, " ");
  return { source, body };
}

describe("preview runtime wiring in main", () => {
  it("lends the stopping flag as a late getter and keeps every let declared", async () => {
    const { source, body } = await factoryBody();
    expect(body).toContain("runtimeStopping: () => runtimeStopping,");
    // The lets stay declared in main: Quit, status and support read them too.
    for (const declaration of [
      "let runtime: RuntimeReady | null = null;",
      'let runtimeState: "starting" | "ready" | "offline" | "failed" = "starting";',
      "let runtimeError: string | null = null;",
      "let runtimeStopping = false;",
      "let taskCountsBeforeRuntimeExit: Readonly<{",
    ])
      expect(source).toContain(declaration);
    expect(source).toContain("let previewRuntimeCache");
  });

  it("gives each setter an assignment to the let it names", async () => {
    const { body } = await factoryBody();
    for (const [setter, name] of Object.entries({
      setRuntimeStopping: "runtimeStopping",
      setRuntime: "runtime",
      setRuntimeState: "runtimeState",
      setRuntimeError: "runtimeError",
      setTaskCountsBeforeRuntimeExit: "taskCountsBeforeRuntimeExit",
    }))
      expect(body).toContain(`${setter}: (value) => { ${name} = value; },`);
    // Exactly these five lets are assigned by the runtime, and no other.
    expect(body.match(/\(value\) => \{/g)).toHaveLength(5);
  });

  it("owns the child and its generation in the factory, not in main", async () => {
    const { source } = await factoryBody();
    expect(source).not.toMatch(/\nlet runtimeChild\b/);
    expect(source).not.toMatch(/\nlet localRuntimeGeneration\b/);
  });

  it("shares each const owner and main helper by reference", async () => {
    const { source, body } = await factoryBody();
    for (const name of [
      "desktopAdmission",
      "ownedLocalRuntimes",
      "installedUpdates",
      "activeDesktopIdentity",
      "demoMode",
      "expectedTasks",
      "readySchema",
      "streamControllers",
      "pendingComputer",
      "taskSurfaceFailures",
      "stopStreams",
      "disposeTaskViews",
      "publishRuntimeStatus",
      "observeLocalRuntime",
    ]) {
      expect(body).toContain(` ${name},`);
      // A shared owner must stay a const or a function, not become a lent `let`.
      expect(source).not.toMatch(new RegExp(`\\nlet ${name}\\b`));
    }
    expect(source).toContain(
      "const ownedLocalRuntimes = new Map<LocalRuntimeLifetime, string>();",
    );
  });

  it("launches from the factory file, not through a port or from main", async () => {
    const { source, body } = await factoryBody();
    const host = await readFile(
      path.resolve(import.meta.dirname, "../../apps/desktop/runtime/host.ts"),
      "utf8",
    );
    // The runtime launch inventory only sees a launcher imported where it is
    // called, so the one `spawn` stays imported in the file that calls it.
    expect(host).toContain(
      'import { spawn, type ChildProcess } from "node:child_process";',
    );
    expect(host).toContain("const child = spawn(");
    expect(body).not.toContain(" spawn,");
    expect(source).not.toContain("node:child_process");
  });

  it("reads the real clock, environment and arguments", async () => {
    const { body } = await factoryBody();
    for (const fragment of [
      " setTimeout, clearTimeout, env: process.env, argv: process.argv,",
    ])
      expect(body).toContain(fragment);
  });

  it("keeps only a thin wrapper in main, reaching the one lazily built instance", async () => {
    const { source } = await factoryBody();
    const header = "function startRuntime(): Promise<void> {";
    const begin = source.indexOf(header);
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(source.slice(begin, source.indexOf("\n}\n", begin) + 3)).toBe(
      `${header}\n  return previewRuntime().start();\n}\n`,
    );
    // The one remaining caller still reaches it by the same name.
    expect(source).toContain(
      'await runDesktopStartupBoundary("local-runtime", startRuntime);',
    );
  });

  it("leaves none of the moved bodies behind", async () => {
    const { source } = await factoryBody();
    for (const fragment of [
      "function handleRuntimeExit",
      "LOCAL_RUNTIME_ALREADY_OWNED",
      "RUNTIME_START_TIMEOUT",
      "RUNTIME_PROCESS_NOT_STARTED",
      "RUNTIME_IDENTITY_MISMATCH",
      "RUNTIME_TASK_MANIFEST_MISMATCH",
      "RUNTIME_PROCESS_EXITED",
      "FAROL_PREVIEW_SCENARIO",
      "ELECTRON_RUN_AS_NODE",
    ])
      expect(source).not.toContain(fragment);
  });
});
