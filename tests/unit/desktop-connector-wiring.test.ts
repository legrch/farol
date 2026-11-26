import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The connector supervisor lives in apps/desktop/connector/supervisor.ts and
// is tested there with injected ports. Nothing else checks which main-process
// state each port reads, so a swapped getter would pass every other test. This
// asserts the wiring as text; it executes nothing from main.ts.

const mainSource = path.resolve(
  import.meta.dirname,
  "../../src/apps/desktop/main.ts",
);
const dispatchSource = path.resolve(
  import.meta.dirname,
  "../../apps/desktop/configuration/dispatch.ts",
);

describe("connector supervisor wiring in main", () => {
  it("lends each port its own main-process owner", async () => {
    const source = await readFile(mainSource, "utf8");
    const begin = source.indexOf("} = connectorSupervisor({");
    expect(begin).toBeGreaterThanOrEqual(0);
    const body = source.slice(begin, source.indexOf("\n});\n", begin) + 1);
    for (const name of [
      "configuration",
      "secureMcpConnectorRuntime",
      "desktopGoCore",
      "window",
      "connectorStartInFlight",
      "authorityTransitions",
      "powerMonitor",
    ])
      expect(body).toContain(`\n  ${name}: () => ${name},\n`);
    // The last fence recovery lives in the context owner, read through its cell.
    expect(body).toContain(
      "\n  summaryFenceRecovery: () => contextHost.recovery.get(),\n",
    );
    for (const [name, expression] of Object.entries({
      quitInProgress: "desktopAdmission.quitInProgress",
      installedUpdateAdmission: "desktopAdmission.installedUpdateAdmission",
      connectorTaskAdmission: 'desktopAdmission.occupied("connector-task")',
      connectorTaskAdmissionPurpose:
        "desktopAdmission.connectorTaskAdmissionPurpose",
      configurationRequests: "desktopAdmission.configurationRequests",
      workspaceMutationAdmission:
        'desktopAdmission.occupied("workspace-mutation")',
      reserveConnectorTask:
        'desktopAdmission.reserveAdmitted("connector-task")',
    }))
      expect(body.replace(/\s+/g, " ")).toContain(
        `${name}: () => ${expression},`,
      );
    expect(body).toContain("\n  buildId: buildIdentity.buildId,\n");
    for (const name of [
      "codexAgentOperationActive",
      "operationsStore",
      "isolatedE2EHome",
      "computerMcpLifecycle",
      "stopAndConfirmComputerMcp",
      "reportConnectorTransport",
      "transitionRefusal",
      "configurationFailure",
    ])
      expect(body).toContain(`\n  ${name},\n`);
    // The start functions live in connector/start.ts and main builds them
    // lazily; each port forwards to the same lazily built instance.
    const flat = body.replace(/\s+/g, " ");
    expect(flat).toContain(
      "observeConnectorStart: (work) => connectorStart().observeConnectorStart(work),",
    );
    expect(flat).toContain(
      "startAdmittedSecureMcpConnector: (...args) => connectorStart().startAdmittedSecureMcpConnector(...args),",
    );
    expect(flat).toContain(
      "recordConnectorRuntime: (...args) => connectorStart().recordConnectorRuntime(...args),",
    );
  });

  it("lends the connector start each main-process owner, late for every let", async () => {
    const source = await readFile(mainSource, "utf8");
    const begin = source.indexOf("function connectorStart() {");
    expect(begin).toBeGreaterThanOrEqual(0);
    const body = source
      .slice(begin, source.indexOf("\n}\n", begin) + 2)
      .replace(/\s+/g, " ");
    // Each `let` in main is a getter (read afresh at every use) or a setter.
    for (const name of [
      "configuration",
      "connectorCredentialStore",
      "secureMcpConnectorRuntime",
      "desktopGoCore",
      "connectorStartCancellation",
    ])
      expect(body).toContain(`${name}: () => ${name},`);
    // The last fence recovery lives in the context owner, read through its cell.
    expect(body).toContain(
      "summaryFenceRecovery: () => contextHost.recovery.get(),",
    );
    expect(body).toContain(
      "setConnectorStartCancellation: (value) => { connectorStartCancellation = value; },",
    );
    expect(body).toContain(
      "setConnectorStartInFlight: (value) => { connectorStartInFlight = value; },",
    );
    // Each `const` owner is shared by reference, never copied.
    for (const name of [
      "desktopAdmission",
      "authorityTransitions",
      "buildIdentity",
      "directory",
      "installedUpdates",
      "connectorAttemptGeneration",
    ])
      expect(body).toContain(` ${name},`);
    // Main's own stop is lent directly: the start paths pass no arguments,
    // so its defaults still read the live owners at call time.
    expect(body).toContain(" stopAndConfirmComputerMcp,");
    expect(body).not.toContain("stopAndConfirmComputerMcp: (");
    expect(source).toContain("let connectorStartCache");
  });

  it("lends the connector check each main-process owner, late for every let", async () => {
    const source = await readFile(mainSource, "utf8");
    const begin = source.indexOf("function connectorCheck() {");
    expect(begin).toBeGreaterThanOrEqual(0);
    const body = source
      .slice(begin, source.indexOf("\n}\n", begin) + 2)
      .replace(/\s+/g, " ");
    // Each `let` in main is a getter, read afresh at every use across each await.
    for (const name of [
      "configuration",
      "secureMcpConnectorRuntime",
      "desktopGoCore",
      "chatGptRoute",
      "window",
      "selectedTaskId",
    ])
      expect(body).toContain(`${name}: () => ${name},`);
    // Each `const` owner is shared by reference, never copied.
    for (const name of [
      "liveTaskRoutes",
      "desktopAdmission",
      "buildIdentity",
      "connectorConnection",
      "currentConnectionStatus",
    ])
      expect(body).toContain(` ${name},`);
    expect(source).toContain("let connectorCheckCache");
    // Every caller reaches the check through the one lazily built instance.
    // The configuration dispatch holds the explicit check's call; main lends
    // it the accessor.
    expect(await readFile(dispatchSource, "utf8")).toContain(
      "connectorCheck().testConnectionCommand(",
    );
    expect(source).toContain("connectorCheck().checkSecureMcpAttachment(");
    expect(source).not.toMatch(
      /\n(?:async )?function (?:testConnectionCommand|checkSecureMcpAttachment)\(/,
    );
  });

  it("uses the supervisor's own state and functions, not a local copy", async () => {
    const source = await readFile(mainSource, "utf8");
    const begin = source.indexOf("// Connector supervision reads each owner");
    const names = source
      .slice(source.indexOf("const {", begin), source.indexOf("} =", begin))
      .match(/\w+/g)
      ?.slice(1);
    expect(names).toEqual([
      "connectorAttemptGeneration",
      "captureConnectorStop",
      "ownerStoppedCurrent",
      "completedOwnerStop",
      "connectionAdmissionInProgress",
      "connectorConnection",
      "captureConnectionStatus",
      "connectionStatusCurrent",
      "currentConnectionStatus",
      "observedConnectorHealth",
      "connectorTransportWatch",
      "connectorTransportTimer",
      "connectorStatusTimer",
      "startConnectorTransportWatch",
    ]);
    for (const name of names ?? []) {
      expect(source).not.toMatch(
        new RegExp(`\\n(?:async )?function ${name}\\(`),
      );
      expect(source).not.toMatch(new RegExp(`\\n(?:let|const) ${name}\\b`));
    }
    // Quit's claim steps close the watch, both timers and the connection the
    // supervisor holds: main lends them to the claim factory, which owns the
    // closing.
    const claim = source.slice(
      source.indexOf("onClaim: quitClaim({"),
      source.indexOf("preparationMs:"),
    );
    for (const name of [
      "connectorTransportWatch",
      "connectorTransportTimer",
      "connectorConnection",
      "connectorStatusTimer",
    ])
      expect(claim).toMatch(new RegExp(`\\n\\s+${name},\\n`));
    const claimSource = await readFile(
      path.resolve(import.meta.dirname, "../../apps/desktop/host/claim.ts"),
      "utf8",
    );
    expect(claimSource).toContain(
      "ports.connectorTransportWatch.current?.close()",
    );
    expect(claimSource).toContain(
      "clearInterval(ports.connectorTransportTimer.current);",
    );
    expect(claimSource).toContain(
      "clearInterval(ports.connectorStatusTimer.current);",
    );
    expect(claimSource).toContain("ports.connectorConnection.close()");
  });
});
