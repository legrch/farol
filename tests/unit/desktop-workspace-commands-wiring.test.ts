import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The owner-workspace commands live in apps/desktop/configuration/files.ts and
// are tested there with injected ports. Nothing else checks which main-process
// state each port reads, that the wrappers main keeps still reach the one
// owner, or that every configuration factory still gets them by their old
// names, so a swapped getter or a port left on a stale copy would pass every
// other test. This asserts the wiring as text; it executes nothing from main.ts.

const mainSource = path.resolve(
  import.meta.dirname,
  "../../src/apps/desktop/main.ts",
);

function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

async function read(): Promise<{ source: string; flat: string; body: string }> {
  const source = await readFile(mainSource, "utf8");
  const begin = source.indexOf("function workspaceCommands() {");
  expect(begin).toBeGreaterThanOrEqual(0);
  const body = flat(source.slice(begin, source.indexOf("\n}\n", begin) + 2));
  return { source, flat: flat(source), body };
}

const wrapped = [
  "verifiedProductWorkspace",
  "selectedWorkspaceFile",
  "workspaceReadFailure",
  "codexAgentCheckWorkspace",
  "inspectOwnerWorkspace",
  "listOwnerWorkspace",
  "workspaceCommandFailure",
  "workspaceMutationFailure",
  "goWorkspaceEditResult",
] as const;

describe("workspace commands wiring in main", () => {
  it("lends each main let as a late getter and keeps every let declared", async () => {
    const { source, body } = await read();
    for (const name of ["configuration", "desktopGoCore", "window"]) {
      expect(body).toContain(`${name}: () => ${name},`);
      // A lent variable stays a `let` main owns, not a copy taken at creation.
      expect(source).toMatch(new RegExp(`\\nlet ${name}\\b`));
    }
  });

  it("lends the compiled declaration as a getter and keeps it a const", async () => {
    const { source, body } = await read();
    expect(body).toContain("compiledGoCore: () => compiledGoCore,");
    expect(source).toMatch(/\nconst compiledGoCore\b/);
  });

  it("shares the const owners and the function port by reference", async () => {
    const { source, body } = await read();
    expect(body).toContain(" configurationFailure, ");
    expect(body).toContain(" nativeWorkspace, ");
    expect(source).toMatch(/\nconst nativeWorkspace\b/);
    expect(source).toMatch(/\nfunction configurationFailure\(/);
  });

  it("reaches the dialog and the environment at the call, through main's own modules", async () => {
    const { body } = await read();
    expect(body).toContain(
      "showOpenDialog: (owner, options) => dialog.showOpenDialog(owner, options),",
    );
    // The live environment object, so a seam set after start is still seen.
    expect(body).toContain("env: process.env,");
  });

  it("builds the owner lazily and caches it", async () => {
    const { source, body } = await read();
    expect(body).toContain(
      "(workspaceCommandsCache ??= createWorkspaceCommands({",
    );
    expect(source).toContain("let workspaceCommandsCache");
  });

  it("keeps a thin wrapper under each old name that delegates to the one owner", async () => {
    const { flat: text } = await read();
    for (const name of wrapped) {
      expect(text).toMatch(
        new RegExp(
          `function ${name}\\(.{0,400}? \\{ return workspaceCommands\\(\\)\\.${name}\\(`,
        ),
      );
    }
  });

  it("no longer owns the bodies it moved", async () => {
    const { source } = await read();
    for (const moved of [
      "FAROL_E2E_WORKSPACE_FILE",
      "securityScopedBookmarks",
      "go-settings-inspect",
      "root-recheck",
      "go-unavailable",
      "new GoSettingsListWorkspace",
      "WORKSPACE_COMMAND_APPROVAL_REQUIRED",
      "WORKSPACE_WRITE_APPROVAL_REQUIRED",
      "WORKSPACE_MUTATION_IN_PROGRESS",
      "WORKSPACE_SEARCH_TIMEOUT",
      "verifiedWorkspaceOf",
    ])
      expect(source).not.toContain(moved);
  });

  it("builds the verification authority in the desktop composition and wires it from main", async () => {
    const { source } = await read();
    expect(source).toContain(
      "const verificationWorkspaceAction =\n  createVerificationWorkspaceAction(nativeWorkspace);",
    );
    const authority = await readFile(
      path.resolve(
        import.meta.dirname,
        "../../src/apps/desktop/verification.ts",
      ),
      "utf8",
    );
    expect(authority).toMatch(
      /\n  return function verificationWorkspaceAction\(/,
    );
  });

  it("still lends the wrappers to every consumer by their old names", async () => {
    const { flat: text } = await read();
    // The Computer step takes all of them.
    expect(text).toContain(
      " selectedWorkspace, measuredRootIdentity, inspectOwnerWorkspace, buildIdentity: () => buildIdentity, workspaceReadFailure,",
    );
    expect(text).toContain(
      " verifiedProductWorkspace, listOwnerWorkspace, desktopGoCore: () => desktopGoCore, compiledGoCore: () => compiledGoCore, discoverWorkspaceGitMetadata, verificationWorkspaceAction,",
    );
    expect(text).toContain(
      " selectedWorkspaceFile, goWorkspaceEditResult, statePaths, workspaceMutationFailure, workspaceCommandFailure, }));",
    );
    // The Codex host check lists through the Go-aware selection.
    expect(text).toContain(" codexAgentCheckWorkspace, tempPath:");
    // The ChatGPT task step reads the picked file and its failures.
    expect(text).toContain(
      " selectedChatGptAttachmentPaths, selectedWorkspaceFile, workspaceReadFailure,",
    );
  });
});
