import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The connector verification lives in apps/desktop/connector/verify.ts and is
// tested there with injected ports. Nothing else checks which main-process
// state each port reads, that the wrappers main keeps still reach the one
// owner, or that every consumer still gets them by their old names, so a swapped
// getter or a port left on a stale copy would pass every other test. This
// asserts the wiring as text; it executes nothing from main.ts.

const mainSource = path.resolve(
  import.meta.dirname,
  "../../src/apps/desktop/main.ts",
);

async function read(): Promise<{ source: string; flat: string; body: string }> {
  const source = await readFile(mainSource, "utf8");
  const begin = source.indexOf("function connectorVerify() {");
  expect(begin).toBeGreaterThanOrEqual(0);
  const body = source
    .slice(begin, source.indexOf("\n}\n", begin) + 2)
    .replace(/\s+/g, " ");
  return { source, flat: source.replace(/\s+/g, " "), body };
}

describe("connector verify wiring in main", () => {
  it("lends each main let as a late getter and keeps every let declared", async () => {
    const { source, body } = await read();
    for (const name of [
      "configuration",
      "chatGptRoute",
      "secureMcpConnectorRuntime",
      "desktopGoCore",
      "window",
      "selectedTaskId",
    ]) {
      expect(body).toContain(`${name}: () => ${name},`);
      // A lent variable stays a `let` main owns, not a copy taken at creation.
      expect(source).toMatch(new RegExp(`\\nlet ${name}\\b`));
    }
  });

  it("shares the const owners and the function ports by reference", async () => {
    const { source, body } = await read();
    expect(body).toContain(
      " desktopAdmission, buildIdentity, runtimeEnvironment, randomUUID, statePaths,",
    );
    expect(body).toContain(
      " randomUUID, statePaths, configurationFailure, embeddedBrowserEnabled, chatGptTaskAdmissionReady,",
    );
    expect(body).toContain(
      " connectorCheck, connectorConnection, currentConnectionStatus, connectorVerificationProof, connectorAppVerificationAttemptExists, confirmSeparateAppVerificationAttempt, prepareConnectorAppVerificationAttempt, prepareConnectorCheckDocument, waitForConnectorAppReceipt, }",
    );
    for (const owner of ["desktopAdmission", "buildIdentity"])
      expect(source).toMatch(new RegExp(`\\nconst ${owner}\\b`));
    // The boot identity fixes the runtime environment once, at import time.
    expect(source).toMatch(
      /\nconst \{[^}]*\bruntimeEnvironment,[^}]*\} = selectBootIdentity\(/,
    );
    for (const fn of [
      "statePaths",
      "configurationFailure",
      "embeddedBrowserEnabled",
      "chatGptTaskAdmissionReady",
      "connectorCheck",
    ])
      expect(source).toMatch(new RegExp(`\\nfunction ${fn}\\(`));
    // The effectful steps are the modules' own, never a copy in main.
    expect(source).toContain(
      'import { connectorVerificationProof } from "./connector-verification-proof";',
    );
    expect(source).toContain(
      'import { prepareConnectorCheckDocument } from "../../../apps/desktop/bridge/connector-check-readiness";',
    );
  });

  it("reaches the dialog through main's own module and no longer takes stderr or the environment", async () => {
    const { body } = await read();
    expect(body).toContain(
      "showMessageBox: (owner, options) => dialog.showMessageBox(owner, options),",
    );
    // The startup maintenance report and its stderr and environment ports
    // are retired; the verification no longer receives them.
    expect(body).not.toContain("writeStderr");
    expect(body).not.toContain("env: process.env");
  });

  it("builds the verification lazily and caches it", async () => {
    const { source, body } = await read();
    expect(body).toContain("(connectorVerifyCache ??= createConnectorVerify({");
    expect(source).toContain("let connectorVerifyCache");
  });

  it("keeps thin wrappers that delegate to the one verification under the old names", async () => {
    const { flat } = await read();
    expect(flat).toContain(
      "function verifySecureMcpApp( separate?: SeparateAppVerificationScope, ): Promise<ProductConfigurationResult> { return connectorVerify().verifySecureMcpApp(separate); }",
    );
  });

  it("no longer owns the verification's sequence, its refusals or its report", async () => {
    const { source } = await read();
    for (const moved of [
      '"FAROL_STARTUP_MAINTENANCE:"',
      "FAROL_CONNECTOR_CHECK_PREFLIGHT",
      "FAROL_CONNECTOR_CHECK_TIMING",
      "farol_connector_verify",
      "Test this connection in ChatGPT",
      "CONNECTOR_APP_TARGET_REQUIRED",
      "CONNECTOR_APP_VERIFICATION_BEFORE_SUBMIT_FAILED",
      "CONNECTOR_APP_VERIFICATION_ALREADY_ATTEMPTED",
      "CONNECTOR_APP_VERIFICATION_OWNER_CONSENT_REQUIRED",
      "recordSecureMcpAppPending",
      "clearSecureMcpAppPendingBeforeSubmit",
    ])
      expect(source).not.toContain(moved);
  });

  it("still lends the wrappers to every consumer by their old names", async () => {
    const { flat } = await read();
    // The configuration connector takes the verification.
    expect(flat).toContain(" verifySecureMcpApp,");
    // Startup no longer runs a preserving maintenance, so nothing in main
    // reports its observations.
    expect(flat).not.toContain("reportMaintenanceObservation");
  });
});
