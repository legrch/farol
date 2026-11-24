import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The single-instance host lives in apps/desktop/host/instance.ts and is tested
// there with injected ports. Nothing else checks which main-process state each
// port reads, or that the lock request still runs where it must, so a swapped
// getter or a lock moved into a function would pass every other test. This
// asserts the wiring as text; it executes nothing from main.ts.

const mainSource = path.resolve(
  import.meta.dirname,
  "../../src/apps/desktop/main.ts",
);
const factorySource = path.resolve(
  import.meta.dirname,
  "../../apps/desktop/host/instance.ts",
);

async function factoryBody(): Promise<{ source: string; body: string }> {
  const source = await readFile(mainSource, "utf8");
  const header = "function instance() {";
  const begin = source.indexOf(header);
  expect(begin).toBeGreaterThanOrEqual(0);
  const body = source
    .slice(begin, source.indexOf("\n}\n", begin) + 2)
    .replace(/\s+/g, " ");
  return { source, body };
}

describe("single-instance host wiring in main", () => {
  it("lends each main let as a late getter and keeps every let declared", async () => {
    const { source, body } = await factoryBody();
    for (const name of ["runtimeStopping", "runtimeState", "window"])
      expect(body).toContain(` ${name}: () => ${name},`);
    expect(body).toContain(" startupRecovery: () => startupRecovery,");
    // The lets stay declared in main: Quit, status and startup read them too.
    for (const declaration of [
      "let runtimeStopping = false;",
      'let runtimeState: "starting" | "ready" | "offline" | "failed" = "starting";',
      "let window: BrowserWindow | null = null;",
      "let startupRecovery: StartupRecoveryWindow | null = null;",
    ])
      expect(source).toContain(declaration);
    expect(source).toContain("let instanceCache");
  });

  it("assigns no main variable from the host", async () => {
    const { body } = await factoryBody();
    // Every port is a getter or a shared owner; the host never writes back.
    expect(body).not.toMatch(/\(value\) =>/);
    expect(body).not.toMatch(/ set[A-Z]\w*:/);
  });

  it("shares each const owner and main helper by reference", async () => {
    const { source, body } = await factoryBody();
    for (const name of [
      "app",
      "desktopAdmission",
      "launchIdentity",
      "instanceRequest",
      "primaryStartup",
      "taskViewKinds",
      "expectedTasks",
      "ensureWindow",
      "recoverWindowOpenFailure",
      "writeInstanceAcknowledgement",
      "waitForInstanceAcknowledgement",
      "foreignAcknowledgementCount",
    ]) {
      expect(body).toContain(` ${name},`);
      // A shared owner must stay a const or a function, not become a lent `let`.
      expect(source).not.toMatch(new RegExp(`\\nlet ${name}\\b`));
    }
    expect(source).toContain("const instanceRequest = createInstanceRequest(");
    expect(source).toContain("const primaryStartup = new PrimaryStartup();");
    expect(source).toContain(
      'const taskViewKinds = new Map<string, "runtime" | "chatgpt">();',
    );
    expect(body).toContain(" stderr: process.stderr,");
  });

  it("requests the lock at the top level of main, after the host can be built", async () => {
    const { source } = await factoryBody();
    const lock =
      "\nconst primaryInstanceLock = app.requestSingleInstanceLock(instanceRequest);\n";
    // Column zero, so it runs when main.ts is imported and not from a function.
    expect(source.split(lock)).toHaveLength(2);
    const at = source.indexOf(lock);
    expect(at).toBeGreaterThan(source.indexOf("\nlet instanceCache"));
    expect(at).toBeGreaterThan(source.indexOf("\nasync function main("));
    // Nothing else in main requests or builds the lock.
    expect(source.match(/requestSingleInstanceLock/g)).toHaveLength(1);
    expect(source).not.toContain(
      "requestSingleInstanceLock(instanceRequest);\n  ",
    );
  });

  it("keeps the stage, the dev-reopen refusal, the secondary wait and the primary branch in this order", async () => {
    const { source } = await factoryBody();
    const tail = source.slice(source.indexOf("\nconst primaryInstanceLock"));
    expect(tail.replace(/\s+/g, " ")).toMatch(
      /^ const primaryInstanceLock = app\.requestSingleInstanceLock\(instanceRequest\); startupStage\(primaryInstanceLock \? "lock-primary" : "lock-secondary"\); if \( devReopenPrimaryRefused\(runtimeEnvironment, process\.argv, primaryInstanceLock\) \) \{ instance\(\)\.refuseDevReopen\(\); \} else if \(!primaryInstanceLock\) \{ instance\(\)\.settleSecondInstance\(\); \} else \{ const quitSignals = createGracefulQuitSignals\(/u,
    );
  });

  it("registers the second-instance listener where main always did", async () => {
    const { source } = await factoryBody();
    const main = source.slice(source.indexOf("\nasync function main("));
    const listen = main.indexOf("  instance().listenForSecondInstance();\n");
    expect(listen).toBeGreaterThanOrEqual(0);
    expect(main.indexOf('app.prependListener("before-quit"')).toBeLessThan(
      listen,
    );
    expect(listen).toBeLessThan(main.indexOf("const observeUpdateRelaunch"));
    expect(source.match(/listenForSecondInstance/g)).toHaveLength(1);
    expect(source).not.toContain('"second-instance"');
  });

  it("keeps only a thin readiness wrapper in main and the primary-started line", async () => {
    const { source } = await factoryBody();
    const header = "function isPrimaryReady(): boolean {";
    const begin = source.indexOf(header);
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(source.slice(begin, source.indexOf("\n}\n", begin) + 3)).toBe(
      `${header}\n  return instance().isPrimaryReady();\n}\n`,
    );
    // The primary still writes its own result line with the shared prefix.
    expect(source).toContain(
      '`${secondInstanceResultPrefix}${isPrimaryReady() ? "primary-started" : "reopen-failed"}\\n`',
    );
    expect(source).toContain(
      'import {\n  createInstance,\n  secondInstanceResultPrefix,\n} from "../../../apps/desktop/host/instance";',
    );
  });

  it("owns the result prefixes in the factory file, not in main", async () => {
    const { source } = await factoryBody();
    const factory = await readFile(factorySource, "utf8");
    expect(factory).toContain(
      'export const secondInstanceResultPrefix = "FAROL_SECOND_INSTANCE_RESULT:";',
    );
    expect(factory).toContain('"FAROL_SECOND_INSTANCE_ACK_FAILED:"');
    expect(source).not.toContain("FAROL_SECOND_INSTANCE_RESULT");
    expect(source).not.toContain("FAROL_SECOND_INSTANCE_ACK_FAILED");
    expect(source).not.toContain("secondInstanceAcknowledgementPrefix");
  });

  it("leaves none of the moved bodies behind", async () => {
    const { source } = await factoryBody();
    for (const fragment of [
      "function handleSecondInstance",
      "decideSecondInstance",
      "acknowledgementFailureCode",
      "secondInstanceRefusalMessage",
      "sameLaunchIdentity",
      "primaryStartupReady",
      "releaseSingleInstanceLock",
      "Quit/update owns admission",
      "A recovery window is available",
    ])
      expect(source).not.toContain(fragment);
  });
});
