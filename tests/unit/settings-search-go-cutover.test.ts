import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { parse } from "@babel/parser";
import { describe, expect, it, vi } from "vitest";
import { BridgeError } from "../../apps/desktop/bridge/client";

// Execute the actual Settings command case with mocked transport/configuration.
// This is portable source composition evidence, not Electron/native acceptance.
const source = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
const tree = parse(source, { sourceType: "module", plugins: ["typescript"] });
const cases: Record<string, unknown>[] = [];
function visit(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  const node = value as Record<string, unknown>;
  if (
    node.type === "SwitchCase" &&
    (node.test as { value?: string } | null)?.value ===
      "computer.search-workspace"
  )
    cases.push(node);
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) child.forEach(visit);
    else if (child !== null && typeof child === "object") visit(child);
  }
}
visit(tree);
if (cases.length !== 1) throw Error("SETTINGS_SEARCH_COMPOSITION_MISSING");
const statements = cases[0]!.consequent as { start: number; end: number }[];
const body = source.slice(statements[0]!.start, statements.at(-1)!.end);

function fixture(mode: string) {
  let generation = 3;
  const legacy = vi.fn(() => {
    throw Error("INTERPRETER_MUST_NOT_LAUNCH");
  });
  const search = vi.fn(async () => {
    if (mode === "refused")
      throw new BridgeError("refused", "WORKSPACE_PATH_REFUSED");
    if (mode === "unknown") throw new BridgeError("unknown", "lost_read");
    if (mode === "stale") generation++;
    return {
      root: {
        path: "/synthetic",
        device: mode === "crossed" ? "9" : "1",
        inode: "2",
      },
      matches: [
        { path: "note.md", line: "1", text: "match", truncated: false },
      ],
      resultLimited: true,
      scanLimited: false,
    };
  });
  const snapshot = () => ({
    status: "ready",
    settings: { computer: { generation } },
  });
  const run = vm.runInNewContext(
    stripTypeScriptTypes(`(async function(command) ${body})`),
    {
      verifiedProductWorkspace: () => ({
        status: "verified",
        workspace: {
          workspaceId: "work",
          root: "/synthetic",
          rootIdentity: { device: "1", inode: "2" },
        },
      }),
      configuration: { snapshot },
      desktopGoCore:
        mode === "missing" ? null : { searchSettingsWorkspace: search },
      nativeWorkspace: { execute: legacy },
      configurationFailure: (code: string) => ({ ok: false, code }),
      workspaceReadFailure: (code: string) => ({ ok: false, code }),
      ProductConfigurationResultSchema: { parse: (value: unknown) => value },
      BridgeError,
    },
  ) as (
    command: object,
  ) => Promise<{ ok: boolean; code?: string; evidence?: unknown }>;
  return {
    run: () =>
      run({ workspaceId: "work", relativePath: ".", pattern: "match" }),
    search,
    legacy,
  };
}

describe("selected Settings search Go cutover", () => {
  it("calls Go once and maps decimal line transport without a Python helper", async () => {
    const f = fixture("ok");
    expect(await f.run()).toMatchObject({
      ok: true,
      evidence: {
        matches: [{ path: "note.md", line: 1 }],
        resultLimited: true,
        scanLimited: false,
      },
    });
    expect(f.search).toHaveBeenCalledExactlyOnceWith(3, "work", ".", "match");
    expect(f.legacy).not.toHaveBeenCalled();
  });
  it.each(["missing", "refused", "unknown", "stale", "crossed"])(
    "refuses %s without a legacy dispatch",
    async (mode) => {
      const f = fixture(mode);
      expect(await f.run()).toMatchObject({ ok: false });
      expect(f.search).toHaveBeenCalledTimes(mode === "missing" ? 0 : 1);
      expect(f.legacy).not.toHaveBeenCalled();
    },
  );
});
