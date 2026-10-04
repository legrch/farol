import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const names = [
  "requestQuickSwitcher",
  "requestSidebarToggle",
  "requestUpdates",
  "requestSettings",
  "closeShellOverlay",
] as const;

// Execute the actual small native publisher callbacks with injected window/IO
// ports. These source fixtures prove no Electron window, updater or native focus.
async function publishers(applying: boolean, admitWhileOpening = false) {
  const source = await readFile(
    path.resolve(import.meta.dirname, "../../src/apps/desktop/main.ts"),
    "utf8",
  );
  const callbacks = names.map((name) => {
    const signature = `function ${name}(): void {`;
    const begin = source.indexOf(signature);
    if (begin < 0) throw Error(`NATIVE_PUBLISHER_MISSING:${name}`);
    const end = source.indexOf("\nfunction ", begin + signature.length);
    if (end < 0) throw Error(`NATIVE_PUBLISHER_BOUNDARY_MISSING:${name}`);
    return source.slice(begin, end).replace(signature, `function ${name}() {`);
  });
  const effects: string[] = [];
  const publications: unknown[][] = [];
  let opening: Promise<void> | undefined;
  const context: Record<string, unknown> = {
    installedUpdateAdmission: applying,
    setupOpen: false,
    shellOverlay: "task-menu",
    sidebarMode: "overlay",
    window: {
      isDestroyed: () => false,
      webContents: { focus: () => effects.push("focus") },
    },
    applyLayout: () => effects.push("layout"),
    focusForLayout: () => effects.push("focus"),
    publishShellAction: (...args: unknown[]) => publications.push(args),
    ensureWindow: async () => {
      effects.push("open");
      if (admitWhileOpening) context.installedUpdateAdmission = true;
    },
    containWindowOpenFailure: (run: () => Promise<void>) => {
      opening = run();
      return opening;
    },
    recoverWindowOpenFailure: () => {
      throw Error("UNEXPECTED_RECOVERY");
    },
  };
  const exports = vm.runInNewContext(
    `${callbacks.join("\n")}\n({${names.join(",")}})`,
    context,
  ) as Record<(typeof names)[number], () => void>;
  return {
    effects,
    publications,
    context,
    async invoke(name: (typeof names)[number]) {
      exports[name]();
      await opening;
    },
  };
}

describe("native applying-update presentation ownership", () => {
  it.each(names)(
    "refuses %s before native presentation or publication",
    async (name) => {
      const host = await publishers(true);
      await host.invoke(name);
      expect(host.effects).toEqual([]);
      expect(host.publications).toEqual([]);
      expect(host.context.shellOverlay).toBe("task-menu");
      expect(host.context.sidebarMode).toBe("overlay");
    },
  );
  it.each(names)("keeps %s usable before applying admission", async (name) => {
    const host = await publishers(false);
    await host.invoke(name);
    expect(host.publications).toHaveLength(1);
  });
  it("does not publish Updates when admission changes during window opening", async () => {
    const host = await publishers(false, true);
    await host.invoke("requestUpdates");
    expect(host.effects).toEqual(["open"]);
    expect(host.publications).toEqual([]);
  });
});
