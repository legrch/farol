import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function source(relative) {
  return fs.readFile(path.join(root, relative), "utf8");
}

describe("Watch Rail product contract", () => {
  it("keeps Settings in the bottom utility group", async () => {
    const html = await source("src/ui/shell.html");
    const primary = html.match(/<nav class="nav-primary"[\s\S]*?<\/nav>/u)?.[0];
    const utility = html.match(
      /<div class="nav-utility"[\s\S]*?<\/aside>/u,
    )?.[0];

    expect(primary).toContain('data-section="browser"');
    expect(primary).toContain('data-section="computer"');
    expect(primary).toContain('data-section="activity"');
    expect(primary).not.toContain('data-section="settings"');
    expect(utility).toContain('data-section="settings"');
    expect(utility).toContain('id="runtime-pill"');
    expect(utility).toContain('id="build-identity"');
  });

  it("removes hidden rail labels from layout and hides task chrome globally", async () => {
    const css = await source("src/ui/shell.css");

    expect(css).toMatch(
      /html\[data-sidebar="rail"\][\s\S]*?\.nav-label[\s\S]*?display:\s*none/u,
    );
    expect(css).toContain('html:not([data-section="browser"]) .task-bar');
    expect(css).toContain('html:not([data-section="browser"]) .dossier');
    expect(css).toContain('html:not([data-section="browser"]) .surface');
  });

  it("leaves only chat selection in the normal header and inspection in Activity", async () => {
    const [html, shell] = await Promise.all([
      source("src/ui/shell.html"),
      source("src/ui/shell.ts"),
    ]);
    for (const id of [
      "new-task",
      "browser-task-menu",
      "browser-sidebar-toggle",
      "task-menu-button",
    ]) {
      expect(html).toMatch(
        new RegExp(`<button[^>]*id="${id}"[^>]*\\bhidden\\b[^>]*>`, "u"),
      );
    }
    const tabs = shell.slice(
      shell.indexOf("function renderTabs()"),
      shell.indexOf("function renderBrowserStatus()"),
    );
    expect(tabs).not.toContain("task-tab-close");
    expect(tabs).not.toContain('kind: "task.close"');
    expect(html).toContain('id="activity-chats"');
    expect(shell).toContain('inspect.textContent = "Inspect"');
    expect(shell).toContain("inspect.dataset.taskId = task.taskId");
  });

  it("uses the current location instead of repeating the product in the window bar", async () => {
    const [html, shell] = await Promise.all([
      source("src/ui/shell.html"),
      source("src/ui/shell.ts"),
    ]);
    const header = html.slice(
      html.indexOf('<header class="window-bar'),
      html.indexOf('<header class="task-bar'),
    );
    expect(header).toContain('id="window-location"');
    expect(header).not.toContain("Developer Preview");
    expect(header).not.toContain("window-product-name");
    expect(shell).toContain(
      'required("#window-location").textContent = location',
    );
  });

  it("uses one Settings command and compact task action labels", async () => {
    const [html, shell, main] = await Promise.all([
      source("src/ui/shell.html"),
      source("src/ui/shell.ts"),
      source("src/apps/desktop/main.ts"),
    ]);

    expect(html).toContain("Finish demo <span>›</span>");
    expect(shell).toContain('"Review request <span>›</span>"');
    // S35-TA-16: the settings publish now carries provenance on the
    // envelope (`source: "settings-command"`), so the literal moved. The
    // claim this row makes is unchanged and is asserted more precisely:
    // exactly ONE publisher opens Settings as an owner command.
    expect(
      main.match(/publishShellAction\("open-settings", "settings-command"\)/gu),
    ).toHaveLength(1);
    expect(main).toContain('accelerator: "CommandOrControl+,"');
  });

  it("keeps folder administration in Settings and links back to Connections", async () => {
    const html = await source("src/ui/shell.html");
    const computer = html.slice(
      html.indexOf('data-panel="computer"'),
      html.indexOf('data-panel="activity"'),
    );
    const settings = html.slice(
      html.indexOf('data-panel="settings"'),
      html.indexOf('<dialog class="task-menu"'),
    );

    expect(computer).not.toContain('id="computer-name"');
    expect(computer).not.toContain('id="computer-workspaces"');
    expect(computer).not.toContain('id="add-workspace"');
    expect(computer).toContain('id="connections-open-chatgpt"');
    expect(settings).toContain('id="open-computer-settings"');
    expect(settings).toContain('id="computer-name"');
    expect(settings).toContain('id="computer-workspaces"');
    expect(settings).toContain('id="add-workspace"');
  });

  it("renders content-free context recovery states and locks destructive task actions", async () => {
    const [shell, presentation] = await Promise.all([
      source("src/ui/shell.ts"),
      source("src/ui/context-task-presentation.ts"),
    ]);

    expect(shell).toContain("contextTaskPresentation(task.context)");
    expect(shell).toContain("contextLocked");
    expect(presentation).toContain('"Preserving context"');
    expect(presentation).toContain('"Recovering from history"');
    expect(presentation).toContain('label: "Context outcome unknown"');
    expect(presentation).not.toMatch(/checkpointContent|activeConstraints/iu);
  });
});
