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

  it("uses one Settings command and compact task action labels", async () => {
    const [html, shell, main] = await Promise.all([
      source("src/ui/shell.html"),
      source("src/ui/shell.ts"),
      source("src/apps/desktop/main.ts"),
    ]);

    expect(html).toContain("Finish demo <span>›</span>");
    expect(shell).toContain('"Review request <span>›</span>"');
    expect(main).toContain('publishShellAction("open-settings")');
    expect(main).toContain('accelerator: "CommandOrControl+,"');
  });

  it("keeps workspace authority on Computer and links to it from Settings", async () => {
    const html = await source("src/ui/shell.html");
    const computer = html.slice(
      html.indexOf('data-panel="computer"'),
      html.indexOf('data-panel="activity"'),
    );
    const settings = html.slice(
      html.indexOf('data-panel="settings"'),
      html.indexOf('<dialog class="task-menu"'),
    );

    expect(computer).toContain('id="computer-name"');
    expect(computer).toContain('id="computer-workspaces"');
    expect(computer).toContain('id="add-workspace"');
    expect(settings).toContain('id="open-computer-settings"');
    expect(settings).not.toContain('id="computer-name"');
    expect(settings).not.toContain('id="computer-workspaces"');
    expect(settings).not.toContain('id="add-workspace"');
  });
});
