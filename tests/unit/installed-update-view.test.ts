import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createInstalledUpdateView } from "../../src/ui/installed-update-view";
import {
  InstalledUpdateViewSchema,
  type InstalledUpdateView,
} from "../../src/modules/release/contract/installed-update";

// A small DOM fixture for the existing Node test environment. IDs and initial
// visibility come from the actual shell; this is not a browser layout test.
const html = fs.readFileSync(
  new URL("../../src/ui/shell.html", import.meta.url),
  "utf8",
);
class ElementFixture {
  hidden = false;
  disabled = false;
  textContent = "";
  title = "";
  dataset: Record<string, string> = {};
  readonly focus = vi.fn();
  private readonly clicks: (() => void)[] = [];
  addEventListener(type: string, listener: () => void): void {
    if (type === "click") this.clicks.push(listener);
  }
  click(): void {
    // Exercise the handler guard even for a synthetic event on a disabled node.
    for (const listener of this.clicks) listener();
  }
}

function fixture() {
  const nodes = new Map<string, ElementFixture>();
  for (const match of html.matchAll(
    /<[^>]+\bid="(installed-update-[^"]+)"[^>]*>/gu,
  )) {
    const id = match[1]!;
    expect(nodes.has(id)).toBe(false);
    const node = new ElementFixture();
    node.hidden = /\shidden(?:\s|>)/u.test(match[0]);
    node.disabled = /\sdisabled(?:\s|>)/u.test(match[0]);
    nodes.set(id, node);
  }
  const browserFocus = { id: "browser-composer" };
  const document = {
    activeElement: browserFocus,
    documentElement: { dataset: { section: "browser", sidebar: "full" } },
    getElementById: (id: string) => nodes.get(id) ?? null,
  };
  const onCommand = vi.fn();
  const view = createInstalledUpdateView(
    document as unknown as Document,
    onCommand,
  );
  function node(suffix: string): ElementFixture {
    const value = nodes.get(`installed-update-${suffix}`);
    if (!value) throw new Error(`Missing test element: ${suffix}`);
    return value;
  }
  return { view, node, nodes, document, browserFocus, onCommand };
}

const ready: InstalledUpdateView = {
  phase: "ready",
  version: "0.1.0-owner.beta.2",
  deferred: false,
  blockedBy: null,
};
const allControls = [
  "check",
  "restart",
  "later",
  "notice-restart",
  "notice-later",
  "recover",
  "rollback",
] as const;

describe("installed update view", () => {
  it("shows an available candidate without claiming it was downloaded", () => {
    const f = fixture();
    const available = InstalledUpdateViewSchema.parse({
      phase: "available",
      version: "0.2.0-owner.beta.5",
      deferred: false,
    });
    f.view.render(available);
    expect(f.node("summary").textContent).toContain("available to download");
    expect(f.node("restart").hidden).toBe(true);
    expect(f.node("check").textContent).toBe("Download Update");
    f.node("check").click();
    f.node("check").click();
    expect(f.onCommand.mock.calls).toEqual([["download"]]);
  });

  it("distinguishes the measured installed build from a downloaded successor", () => {
    const f = fixture();
    f.view.render({ ...ready, version: "0.2.0-owner.beta.4" });
    f.view.setInstalledIdentity("0.2.0-owner.beta.3", "17");
    expect(f.node("summary").textContent).toContain(
      "Installed: Farol 0.2.0-owner.beta.3 (build 17)",
    );
    expect(f.node("summary").textContent).toContain(
      "Farol 0.2.0-owner.beta.4 is ready to install",
    );
    expect(f.node("notice-copy").textContent).toBe(
      f.node("summary").textContent,
    );
    expect(f.onCommand).not.toHaveBeenCalled();
  });
  it.each([
    ["UPDATE_BROWSER_BUSY", "active ChatGPT response"],
    ["UPDATE_BROWSER_DRAFT", "unsent ChatGPT draft"],
    ["UPDATE_BROWSER_STATE_UNKNOWN", "could not confirm that ChatGPT is idle"],
    ["UPDATE_BROWSER_RELEASE_UNCONFIRMED", "Quit Farol and reopen it"],
  ])(
    "explains fresh browser refusal %s without dispatching or hiding the offer",
    (code, reason) => {
      const f = fixture();
      f.view.render({ ...ready, blockedBy: code });
      expect(f.node("summary").textContent).toContain(reason);
      expect(f.node("notice").hidden).toBe(false);
      expect(f.node("notice-restart").disabled).toBe(true);
      expect(f.node("check").disabled).toBe(
        code === "UPDATE_BROWSER_STATE_UNKNOWN" ||
          code === "UPDATE_BROWSER_RELEASE_UNCONFIRMED",
      );
      expect(f.onCommand).not.toHaveBeenCalled();
    },
  );
  it("does not present a browser-state refusal as an invitation to repeat Update", () => {
    const f = fixture();
    f.view.render({ ...ready, blockedBy: "UPDATE_BROWSER_STATE_UNKNOWN" });
    expect(f.node("summary").textContent).toContain(
      "review this result in Diagnostics",
    );
    expect(f.node("summary").textContent).not.toContain("check again");
    expect(f.node("restart").disabled).toBe(true);
    expect(f.node("check").disabled).toBe(true);
    expect(f.node("check").textContent).toBe("Update blocked");
    f.node("check").click();
    expect(f.onCommand).not.toHaveBeenCalled();
  });
  it("exposes only measured recovery or rollback and never dispatches while rendering", () => {
    const f = fixture();
    f.view.render({
      phase: "recovery",
      version: "0.1.1-owner.beta.1",
      blockedBy: null,
    });
    expect(f.node("recover").hidden).toBe(false);
    expect(f.node("rollback").hidden).toBe(true);
    expect(f.onCommand).not.toHaveBeenCalled();
    f.node("recover").click();
    f.node("recover").click();
    expect(f.onCommand.mock.calls).toEqual([["recover"]]);
    f.view.render({
      phase: "idle",
      checkedAt: null,
      rollbackVersion: "0.1.0-owner.beta.1",
    });
    f.node("rollback").click();
    f.node("rollback").click();
    expect(f.onCommand.mock.calls).toEqual([["recover"], ["rollback"]]);
  });
  it("keeps local rollback visible after a known network failure, with no automatic action", () => {
    const f = fixture();
    const state = InstalledUpdateViewSchema.parse({
      phase: "failed",
      code: "UPDATE_NETWORK_FAILURE",
      recoveryRequired: false,
      rollbackVersion: "0.1.0-owner.beta.1",
    });
    f.view.render(state);
    expect(f.node("rollback").hidden).toBe(false);
    expect(f.node("rollback").disabled).toBe(false);
    expect(f.node("summary").textContent).toContain(
      "previous accepted version",
    );
    expect(f.node("summary").textContent).toContain("couldn’t");
    expect(f.onCommand).not.toHaveBeenCalled();
    f.node("rollback").click();
    f.node("rollback").click();
    expect(f.onCommand.mock.calls).toEqual([["rollback"]]);
    expect(
      InstalledUpdateViewSchema.safeParse({ ...state, recoveryRequired: true })
        .success,
    ).toBe(false);
    f.view.render({
      phase: "failed",
      code: "UPDATE_HANDOFF_UNKNOWN",
      recoveryRequired: true,
    });
    expect(f.node("rollback").hidden).toBe(true);
    f.node("rollback").click();
    expect(f.onCommand).toHaveBeenCalledTimes(1);
  });

  it("starts passive and keeps idle checks in Preferences without a rail notice", () => {
    const f = fixture();
    for (const name of allControls) f.node(name).click();
    expect(f.onCommand).not.toHaveBeenCalled();
    f.view.render({ phase: "idle", checkedAt: null });
    expect(f.node("notice").hidden).toBe(true);
    expect(f.node("check").textContent).toBe("Check for Updates…");
    expect(f.node("check").disabled).toBe(false);
    expect(f.node("restart").hidden).toBe(true);
    expect(f.node("later").hidden).toBe(true);
    expect(html).toMatch(
      /data-settings-page="preferences"\s+aria-labelledby="installed-update-title"/u,
    );
    expect(html.indexOf('id="installed-update-notice"')).toBeLessThan(
      html.indexOf("</aside>"),
    );
    f.node("check").click();
    f.node("check").click();
    expect(f.onCommand.mock.calls).toEqual([["check"]]);
  });

  for (const phase of ["checking", "downloading"] as const) {
    it(`keeps ${phase} nonmodal with commands disabled`, () => {
      const f = fixture();
      f.view.render({ phase });
      expect(f.node("notice").hidden).toBe(true);
      for (const name of allControls) {
        expect(f.node(name).disabled).toBe(true);
        f.node(name).click();
      }
      expect(f.node("summary").textContent).toContain(
        phase === "checking" ? "Checking" : "background",
      );
      expect(f.onCommand).not.toHaveBeenCalled();
    });
  }

  for (const prefix of ["", "notice-"]) {
    it(`dispatches restart once from the ${prefix || "Preferences "}controls`, () => {
      const f = fixture();
      f.view.render(ready);
      f.view.render(ready);
      expect(f.node("notice").hidden).toBe(false);
      expect(f.node("summary").textContent).toContain("0.1.0-owner.beta.2");
      expect(f.node(`${prefix}restart`).disabled).toBe(false);
      f.node(`${prefix}restart`).click();
      f.node(`${prefix}restart`).click();
      expect(f.onCommand.mock.calls).toEqual([["restart"]]);
    });

    it(`defers Later from ${prefix || "Preferences "}and keeps the update discoverable`, () => {
      const f = fixture();
      f.view.render(ready);
      f.node(`${prefix}later`).click();
      expect(f.onCommand.mock.calls).toEqual([["later"]]);
      expect(f.node("notice").hidden).toBe(false);
      expect(f.node("restart").hidden).toBe(false);
      expect(f.node("restart").disabled).toBe(false);
      f.view.render({ ...ready, deferred: true });
      expect(f.node("notice").hidden).toBe(false);
      expect(f.node("restart").disabled).toBe(false);
      f.node("notice-restart").click();
      expect(f.onCommand.mock.calls).toEqual([["later"], ["restart"]]);
      f.node("restart").click();
      expect(f.onCommand.mock.calls).toEqual([["later"], ["restart"]]);
    });
  }

  for (const [code, text] of [
    ["UPDATE_CONNECTOR_ACTIVE", "Disconnect the active connector"],
    ["UPDATE_TASK_ROUTE_NEEDS_DRAIN", "current task to finish"],
    ["UPDATE_WORK_PENDING", "Finish or cancel active work"],
    ["UPDATE_STATE_UNREADABLE", "couldn’t read"],
    ["UNKNOWN_REASON", "can’t restart safely"],
  ]) {
    it(`explains ${code} and blocks restart while allowing Later`, () => {
      const f = fixture();
      f.view.render({ ...ready, blockedBy: code! });
      expect(f.node("summary").textContent).toContain(text);
      expect(f.node("summary").textContent).not.toContain(code);
      for (const name of ["restart", "notice-restart"]) {
        expect(f.node(name).disabled).toBe(true);
        f.node(name).click();
      }
      expect(f.onCommand).not.toHaveBeenCalled();
      expect(f.node("later").disabled).toBe(false);
      f.node("later").click();
      expect(f.onCommand.mock.calls).toEqual([["later"]]);
    });
  }

  it("requires recovery without offering restart or a new check", () => {
    const f = fixture();
    f.view.render({
      phase: "failed",
      code: "UPDATE_STATE_UNREADABLE",
      recoveryRequired: true,
    });
    expect(f.node("summary").textContent).toContain("recovery");
    expect(f.node("summary").textContent).toContain("Diagnostics");
    expect(f.node("notice").hidden).toBe(false);
    for (const name of allControls) {
      expect(f.node(name).disabled).toBe(true);
      f.node(name).click();
    }
    expect(f.onCommand).not.toHaveBeenCalled();
  });

  it("allows a manual check after a failure that needs no recovery", () => {
    const f = fixture();
    f.view.render({
      phase: "failed",
      code: "NETWORK_FAILURE",
      recoveryRequired: false,
    });
    expect(f.node("notice").hidden).toBe(true);
    expect(f.node("check").disabled).toBe(false);
    expect(f.node("restart").disabled).toBe(true);
    expect(f.onCommand).not.toHaveBeenCalled();
    f.node("check").click();
    expect(f.onCommand.mock.calls).toEqual([["check"]]);
  });

  it("offers an explicit recheck after a known work blocker without enabling Restart", () => {
    const f = fixture();
    f.view.render({
      ...ready,
      deferred: true,
      blockedBy: "UPDATE_WORK_PENDING",
    });
    expect(f.node("restart").disabled).toBe(true);
    expect(f.node("check").disabled).toBe(false);
    expect(f.node("check").textContent).toBe("Check again");
    f.node("check").click();
    expect(f.onCommand.mock.calls).toEqual([["check"]]);
  });

  it("disables every control while applying", () => {
    const f = fixture();
    f.view.render({ phase: "applying", version: "0.1.0-owner.beta.2" });
    expect(f.node("summary").textContent).toContain("Installing");
    for (const name of allControls) {
      expect(f.node(name).disabled).toBe(true);
      f.node(name).click();
    }
    expect(f.onCommand).not.toHaveBeenCalled();
  });

  it("explains why an installed owner beta is required", () => {
    const f = fixture();
    f.view.render({ phase: "unavailable", code: "UPDATE_UNAVAILABLE" });
    expect(f.node("summary").textContent).toContain(
      "installed Farol owner beta",
    );
    expect(f.node("notice").hidden).toBe(true);
    expect(f.node("check").disabled).toBe(true);
    expect(f.node("summary").textContent).not.toContain("UPDATE_UNAVAILABLE");
  });

  it("does not echo paths, markup, or stack traces from display fields", () => {
    const f = fixture();
    const unsafe = "/Users/owner/private/file\nError: stack <img src=x>";
    f.view.render({ ...ready, version: unsafe });
    expect(f.node("summary").textContent).toContain("The update");
    expect(f.node("summary").textContent).not.toContain(unsafe);
    f.view.render({ phase: "failed", code: unsafe, recoveryRequired: true });
    expect(f.node("summary").textContent).not.toContain(unsafe);
  });

  it("keeps a recovered deferred update visible in the sidebar without taking focus", () => {
    const f = fixture();
    f.view.render({ ...ready, deferred: true });
    expect(f.node("notice").hidden).toBe(false);
    expect(f.node("notice-copy").textContent).toContain("Saved for later");
    expect(f.node("notice-restart").disabled).toBe(false);
    expect(f.node("notice-later").disabled).toBe(true);
    expect(f.document.activeElement).toBe(f.browserFocus);
    expect(f.onCommand).not.toHaveBeenCalled();
  });

  it("preserves focus and navigation across every render", () => {
    const f = fixture();
    const states: InstalledUpdateView[] = [
      { phase: "idle", checkedAt: 1 },
      { phase: "checking" },
      { phase: "downloading" },
      ready,
      { ...ready, deferred: true },
      { phase: "applying", version: ready.version },
      {
        phase: "failed",
        code: "UPDATE_STATE_UNREADABLE",
        recoveryRequired: true,
      },
      { phase: "unavailable", code: "UPDATE_UNAVAILABLE" },
    ];
    for (const state of states) f.view.render(state);
    expect(f.document.activeElement).toBe(f.browserFocus);
    expect(f.document.documentElement.dataset).toEqual({
      section: "browser",
      sidebar: "full",
    });
    for (const element of f.nodes.values())
      expect(element.focus).not.toHaveBeenCalled();
    expect(f.onCommand).not.toHaveBeenCalled();
  });
});
