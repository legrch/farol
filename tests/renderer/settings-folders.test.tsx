import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ProductConfigurationCommand } from "../../src/pkg/product-settings/contract";
import { deferred } from "./fixture";
import { change, mount, readySettings } from "./setup-fixture";

// Pins the Setup "Workspaces" page (the Folders component) through the real
// renderer and controller with scripted configuration replies. No native
// filesystem, account or tunnel evidence.
const scratchId = "44444444-4444-4444-8444-444444444444";

function twoFolders() {
  const value = readySettings();
  const first = value.computer.workspaces[0]!;
  value.computer.workspaces.push({
    ...structuredClone(first),
    workspaceId: scratchId,
    root: "/approved/scratch",
    label: "Scratch",
  });
  return value;
}
function quiet(value = twoFolders()) {
  value.connectors.secureMcp.runtime = null;
  value.connectors.secureMcp.challenge = null;
  return value;
}
async function folders(value = readySettings()) {
  const h = await mount({ step: "folders", value });
  const row = (name: string) =>
    h.host.querySelector<HTMLElement>(
      `article[aria-label="Workspace ${name}"]`,
    )!;
  const sent = () =>
    vi
      .mocked(h.f.api.configure)
      .mock.calls.map(([command]) => command as ProductConfigurationCommand);
  return { ...h, row, sent };
}
const texts = (parent: Element, selector: string) =>
  [...parent.querySelectorAll(selector)].map((e) => e.textContent);

describe("Setup Folders page", () => {
  it("shows the empty state with a primary add button", async () => {
    const h = await folders({
      ...readySettings(),
      computer: { ...readySettings().computer, workspaces: [] },
    });
    const region = h.host.querySelector(".setup-workspaces")!;
    expect(region.getAttribute("aria-label")).toBe("Approved workspaces");
    expect(region.children).toHaveLength(0);
    const add = h.button("+ Add workspace")!;
    expect(add.className).toBe("primary");
    expect(add.disabled).toBe(false);
    expect(h.host.textContent).toContain("Add a workspace to continue.");
    expect(h.host.textContent).toContain(
      "Commands lets ChatGPT run Git, tests and builds in approved workspaces, including Git history, hooks and your Git configuration. ChatGPT manages action confirmations; Farol enforces your approved access. Command access is shared by all workspaces.",
    );
    expect(h.host.textContent).not.toContain("Select Commands to enable");
    expect(h.host.textContent).not.toContain("earlier access policy");
    expect(h.host.textContent).not.toContain("allows Git checks only");
  });

  it("renders a checked row with its path, access, commands and Re-check", async () => {
    const h = await folders();
    const row = h.row("project");
    expect(row.className).toBe("setup-workspace-row");
    expect(row.querySelector(".workspace-row-path strong")?.textContent).toBe(
      "project",
    );
    expect(row.querySelector(".workspace-row-path p")?.className).toBe(
      "description",
    );
    expect(row.querySelector(".workspace-row-path p")?.textContent).toBe(
      "/approved/project",
    );
    const access = row.querySelector<HTMLSelectElement>(
      'select[aria-label="Access for project"]',
    )!;
    expect(access.className).toBe("field");
    expect(access.value).toBe("read");
    expect(access.disabled).toBe(false);
    expect(texts(access, "option")).toEqual(["Read only", "Read & write"]);
    expect([...access.querySelectorAll("option")].map((o) => o.value)).toEqual([
      "read",
      "write",
    ]);
    const commands = row.querySelector<HTMLInputElement>(
      'input[aria-label="Commands for project"]',
    )!;
    expect(commands.type).toBe("checkbox");
    expect(commands.checked).toBe(false);
    expect(commands.disabled).toBe(false);
    expect(row.querySelector("label.workspace-commands")?.textContent).toBe(
      "Commands",
    );
    const result = row.querySelector(".workspace-row-result")!;
    expect(result.getAttribute("role")).toBe("status");
    expect(texts(result, "span")).toEqual(["✓ Works"]);
    expect(result.querySelector("span")?.className).toBe("setup-success");
    expect(texts(result, "button")).toEqual(["Re-check"]);
    expect(result.querySelector("button")?.className).toBe("text-button");
    expect(row.querySelector('[role="note"]')).toBeNull();
    expect(texts(row, "button")).toEqual(["Re-check", "Remove project"]);
    expect(h.button("+ Add workspace")!.className).toBe("subtle");
    expect(h.host.textContent).not.toContain("Add a workspace to continue.");
  });

  it("renders one row per folder in saved order", async () => {
    const h = await folders(twoFolders());
    expect(
      texts(h.host, ".setup-workspace-row .workspace-row-path strong"),
    ).toEqual(["project", "scratch"]);
    expect(h.row("scratch").querySelector("p")?.textContent).toBe(
      "/approved/scratch",
    );
    expect(h.button("Remove scratch")).toBeTruthy();
    expect(h.button("Remove project")).toBeTruthy();
  });

  it("offers Check access and the unchecked message when the saved check is missing", async () => {
    const value = readySettings();
    value.computer.workspaces[0]!.accessCheck = null;
    const h = await folders(value);
    const result = h.row("project").querySelector(".workspace-row-result")!;
    expect(texts(result, "span")).toEqual([
      "Workspace access has not passed its check.",
    ]);
    expect(texts(result, "button")).toEqual(["Check access"]);
    expect(result.textContent).not.toContain("✓ Works");
    expect(h.host.textContent).not.toContain("Re-check");
  });

  it("treats a check from another build as unchecked", async () => {
    const value = readySettings();
    value.computer.workspaces[0]!.accessCheck = {
      ...value.computer.workspaces[0]!.accessCheck!,
      buildId: "9".repeat(64),
    };
    const h = await folders(value);
    expect(h.row("project").textContent).toContain(
      "Workspace access has not passed its check.",
    );
    expect(h.row("project").textContent).not.toContain("✓ Works");
  });

  it("shows the writable-by-others note only on a checked folder that carries it", async () => {
    const value = twoFolders();
    value.computer.workspaces[0]!.accessCheck = {
      ...value.computer.workspaces[0]!.accessCheck!,
      writableByOthers: true,
    };
    const h = await folders(value);
    const note = h.row("project").querySelector('p[role="note"]')!;
    expect(note.className).toBe("description workspace-row-note");
    expect(note.textContent).toBe(
      "Other users of this Mac can change files in this folder.",
    );
    expect(h.row("scratch").querySelector('[role="note"]')).toBeNull();
    expect(h.host.querySelectorAll('[role="note"]')).toHaveLength(1);
  });

  it("hides the note when the flagged folder is not currently checked", async () => {
    const value = readySettings();
    value.computer.workspaces[0]!.accessCheck = {
      ...value.computer.workspaces[0]!.accessCheck!,
      buildId: "9".repeat(64),
      writableByOthers: true,
    };
    const h = await folders(value);
    expect(h.host.querySelector('[role="note"]')).toBeNull();
  });

  it.each([
    [
      "workspace commands with every Git history approved",
      { commands: "workspace", filePolicy: "approved-roots-v1", git: true },
      { checked: true, notes: [] as string[] },
    ],
    [
      "workspace commands without Git history approval",
      { commands: "workspace", filePolicy: "approved-roots-v1", git: false },
      {
        checked: false,
        notes: [
          "Select Commands to enable Git and user settings for the approved workspaces.",
        ],
      },
    ],
    [
      "workspace commands under an earlier file policy",
      { commands: "workspace", filePolicy: "", git: false },
      {
        checked: false,
        notes: [
          "Commands are not enabled by this profile’s earlier access policy. Select Commands above to approve command access and check your workspaces in one step.",
        ],
      },
    ],
    [
      "verification commands",
      { commands: "verification", filePolicy: "approved-roots-v1", git: true },
      {
        checked: false,
        notes: [
          "This profile currently allows Git checks only. Select Commands to allow workspace commands.",
        ],
      },
    ],
  ])("explains the command state: %s", async (_name, plan, expected) => {
    const value = readySettings();
    value.computer.commands = plan.commands as "workspace" | "verification";
    value.computer.filePolicy = plan.filePolicy as "" | "approved-roots-v1";
    value.computer.workspaces[0]!.gitHistoryApproved = plan.git;
    const h = await folders(value);
    const box = h.host.querySelector<HTMLInputElement>(
      'input[aria-label="Commands for project"]',
    )!;
    expect(box.checked).toBe(expected.checked);
    const descriptions = texts(h.host, "p.description").filter(
      (t) =>
        t?.startsWith("Select Commands") ||
        t?.startsWith("Commands are not enabled") ||
        t?.startsWith("This profile currently"),
    );
    expect(descriptions).toEqual(expected.notes);
  });

  it("marks the command notes that are announced as status", async () => {
    const value = readySettings();
    value.computer.commands = "workspace";
    value.computer.filePolicy = "approved-roots-v1";
    value.computer.workspaces[0]!.gitHistoryApproved = false;
    const h = await folders(value);
    const note = [...h.host.querySelectorAll("p.description")].find((p) =>
      p.textContent?.startsWith("Select Commands"),
    )!;
    expect(note.getAttribute("role")).toBe("status");
  });

  it("sends the verify command from Re-check", async () => {
    const h = await folders(quiet());
    const reply = vi.fn(async (_command: ProductConfigurationCommand) => ({
      ok: true as const,
      snapshot: h.configuration(),
    }));
    h.reply(reply);
    const button = [...h.row("scratch").querySelectorAll("button")].find(
      (b) => b.textContent === "Re-check",
    )!;
    await act(async () => button.click());
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    const first = reply.mock
      .calls[0]![0] as unknown as ProductConfigurationCommand;
    expect(first).toMatchObject({
      kind: "computer.verify-workspace",
      workspaceId: scratchId,
    });
  });

  it("sends the verify command from Check access", async () => {
    const value = quiet();
    value.computer.workspaces[1]!.accessCheck = null;
    const h = await folders(value);
    const reply = vi.fn(async (_command: ProductConfigurationCommand) => ({
      ok: true as const,
      snapshot: h.configuration(),
    }));
    h.reply(reply);
    await h.click("Check access");
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(reply.mock.calls[0]![0]).toMatchObject({
      kind: "computer.verify-workspace",
      workspaceId: scratchId,
    });
  });

  it("sends the access change for the edited folder", async () => {
    const h = await folders(quiet());
    const reply = vi.fn(async (_command: ProductConfigurationCommand) => ({
      ok: true as const,
      snapshot: h.configuration(),
    }));
    h.reply(reply);
    const select = h
      .row("scratch")
      .querySelector<HTMLSelectElement>(
        'select[aria-label="Access for scratch"]',
      )!;
    await change(select, "write");
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(reply.mock.calls[0]![0]).toMatchObject({
      kind: "computer.update-access",
      workspaceId: scratchId,
      access: "write",
    });
  });

  it("sends the commands change when the checkbox is selected", async () => {
    const h = await folders(quiet(readySettings()));
    const reply = vi.fn(async (_command: ProductConfigurationCommand) => ({
      ok: true as const,
      snapshot: h.configuration(),
    }));
    h.reply(reply);
    const box = h.host.querySelector<HTMLInputElement>(
      'input[aria-label="Commands for project"]',
    )!;
    await act(async () => box.click());
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(reply.mock.calls[0]![0]).toEqual({
      kind: "computer.update-file-policy",
      filePolicy: "approved-roots-v1",
    });
  });

  it("sends the commands change when the checkbox is cleared", async () => {
    const value = quiet(readySettings());
    value.computer.commands = "workspace";
    value.computer.filePolicy = "approved-roots-v1";
    value.computer.workspaces[0]!.gitHistoryApproved = true;
    const h = await folders(value);
    const reply = vi.fn(async (_command: ProductConfigurationCommand) => ({
      ok: true as const,
      snapshot: h.configuration(),
    }));
    h.reply(reply);
    const box = h.host.querySelector<HTMLInputElement>(
      'input[aria-label="Commands for project"]',
    )!;
    expect(box.checked).toBe(true);
    await act(async () => box.click());
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(reply.mock.calls[0]![0]).toEqual({
      kind: "computer.update-commands",
      commands: "none",
    });
  });

  it("sends the remove command for the chosen folder", async () => {
    const h = await folders(twoFolders());
    const reply = vi.fn(async (_command: ProductConfigurationCommand) => ({
      ok: false as const,
      error: "WORKSPACE_NOT_FOUND",
      snapshot: h.configuration(),
    }));
    h.reply(reply);
    await h.click("Remove scratch");
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(reply.mock.calls[0]![0]).toMatchObject({
      kind: "computer.remove-workspace",
      workspaceId: scratchId,
    });
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it("starts the folder picker from Add workspace and shows the busy label", async () => {
    const h = await folders();
    const pending = deferred<unknown>();
    h.reply(async (command) => {
      expect(command.kind).toBe("computer.choose-workspace");
      return pending.promise;
    });
    await h.click("+ Add workspace");
    await vi.waitFor(() =>
      expect(h.button("Checking workspace…")?.disabled).toBe(true),
    );
    expect(h.button("+ Add workspace")).toBeUndefined();
    for (const control of h.host.querySelectorAll<HTMLElement>(
      ".setup-workspace-row select, .setup-workspace-row input",
    ))
      expect((control as HTMLInputElement).disabled).toBe(true);
    for (const b of h.row("project").querySelectorAll("button"))
      expect(b.disabled).toBe(true);
    await act(async () =>
      pending.resolve({ ok: true, snapshot: h.configuration() }),
    );
    await vi.waitFor(() =>
      expect(h.button("+ Add workspace")?.disabled).toBe(false),
    );
  });

  it("stops a live connection before re-checking a folder", async () => {
    const h = await folders();
    const reply = vi.fn(async (_command: ProductConfigurationCommand) => ({
      ok: true as const,
      snapshot: h.configuration(),
    }));
    h.reply(reply);
    await h.click("Re-check");
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(reply.mock.calls[0]![0]).toEqual({ kind: "connector.stop" });
  });

  it("fences every control after a removal whose outcome is unknown", async () => {
    const h = await folders(quiet());
    h.reply(async () => {
      throw Error("scripted lost removal acknowledgement");
    });
    await h.click("Remove scratch");
    await vi.waitFor(() =>
      expect(h.host.textContent).toContain(
        "The last action could not be confirmed. Refresh its saved result before continuing; do not repeat it.",
      ),
    );
    for (const name of ["project", "scratch"]) {
      const row = h.row(name);
      expect(row.textContent).not.toContain("✓ Works");
      expect(row.querySelector<HTMLSelectElement>("select")!.disabled).toBe(
        true,
      );
      expect(row.querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
      expect(texts(row, "button")).toEqual(["Check access", `Remove ${name}`]);
      for (const b of row.querySelectorAll("button"))
        expect(b.disabled).toBe(true);
    }
    expect(h.button("+ Add workspace")!.disabled).toBe(true);
  });
});
