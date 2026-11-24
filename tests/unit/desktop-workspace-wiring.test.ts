import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The workspace host lives in apps/desktop/configuration/workspace.ts and is
// tested there with injected ports. Nothing else checks which main-process
// state each port reads, that the wrappers main keeps still reach the one
// owner, or that every consumer still gets them by their old names, so a
// swapped getter or a port left on a stale copy would pass every other test.
// This asserts the wiring as text; it executes nothing from main.ts.

const mainSource = path.resolve(
  import.meta.dirname,
  "../../src/apps/desktop/main.ts",
);

async function read(): Promise<{ source: string; flat: string; body: string }> {
  const source = await readFile(mainSource, "utf8");
  const begin = source.indexOf("function workspaceHost() {");
  expect(begin).toBeGreaterThanOrEqual(0);
  const body = source
    .slice(begin, source.indexOf("\n}\n", begin) + 2)
    .replace(/\s+/g, " ");
  return { source, flat: source.replace(/\s+/g, " "), body };
}

describe("workspace host wiring in main", () => {
  it("lends each main let as a late getter and keeps every let declared", async () => {
    const { source, body } = await read();
    for (const name of [
      "configuration",
      "window",
      "secureMcpConnectorRuntime",
    ]) {
      expect(body).toContain(`${name}: () => ${name},`);
      // A lent variable stays a `let` main owns, not a copy taken at creation.
      expect(source).toMatch(new RegExp(`\\nlet ${name}\\b`));
    }
  });

  it("shares the const owners and the function ports by reference", async () => {
    const { source, body } = await read();
    expect(body).toContain(
      " authorityTransitions, desktopAdmission, codexAgentOperationActive,",
    );
    expect(body).toContain(" workspaceCheckEvidence,");
    expect(body).toContain(" discoverExecutables,");
    expect(source).toMatch(/\nconst authorityTransitions\b/);
    expect(source).toMatch(/\nconst desktopAdmission\b/);
  });

  it("reaches the dialogs and the environment at the call, through main's own modules", async () => {
    const { body } = await read();
    expect(body).toContain(
      "showOpenDialog: (owner, options) => dialog.showOpenDialog(owner, options),",
    );
    expect(body).toContain(
      "showMessageBox: (owner, options) => dialog.showMessageBox(owner, options),",
    );
    // The live environment object, so a seam set after start is still seen.
    expect(body).toContain("env: process.env,");
  });

  it("builds the host lazily and caches it", async () => {
    const { source, body } = await read();
    expect(body).toContain("(workspaceHostCache ??= createWorkspaceHost({");
    expect(source).toContain("let workspaceHostCache");
  });

  it("keeps thin wrappers that delegate to the one host under the old names", async () => {
    const { flat } = await read();
    expect(flat).toContain(
      "function measuredRootIdentity( root: string, ): Promise<WorkspaceRootIdentity | null> { return workspaceHost().measuredRootIdentity(root); }",
    );
    expect(flat).toContain(
      "function withdrawDriftedWorkspaceChecksAtLaunch(): Promise<boolean> { return workspaceHost().withdrawDriftedWorkspaceChecksAtLaunch(); }",
    );
    expect(flat).toContain("return workspaceHost().selectedWorkspace(); }");
    expect(flat).toContain(
      'function reverifyDiscoveredCandidate( kind: "codex" | "tunnel-client", requestedPath: string, ): Promise<DiscoveryCandidate | "stale" | "declined"> { return workspaceHost().reverifyDiscoveredCandidate(kind, requestedPath); }',
    );
  });

  it("no longer owns the selection, the drift scan or the confirmation dialog", async () => {
    const { source } = await read();
    for (const moved of [
      "FAROL_WORKSPACE_ROOT_DRIFT",
      "FAROL_WORKSPACE_ROOT_OBSERVED",
      "FAROL_E2E_CANCEL_WORKSPACE_PICKER",
      "Choose a workspace",
      "classifyWorkspaceRootDrift",
      "UNTRUSTED_CANDIDATE_DIALOG",
      "reverifyDiscoveredCandidateImpl",
      "lstat(root, { bigint: true })",
    ])
      expect(source).not.toContain(moved);
  });

  it("still lends the wrappers to every consumer by their old names", async () => {
    const { flat } = await read();
    // The Computer step takes the selection and the measurement.
    expect(flat).toContain(" selectedWorkspace, measuredRootIdentity,");
    // The Codex and tunnel-client verification takes the reverification.
    expect(flat).toContain(
      " reverifyDiscoveredCandidate, discoverExecutables,",
    );
    // The launch scan is awaited once before the app resumes.
    expect(flat).toContain(
      "const driftSettled = await withdrawDriftedWorkspaceChecksAtLaunch();",
    );
  });

  it("keeps the pending pick in main, beside the wrappers' consumer", async () => {
    const { source } = await read();
    expect(source).toMatch(/\nlet pendingWorkspacePick\b/);
  });
});
