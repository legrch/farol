import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { selectBootIdentity, type BootIdentityPorts } from "./identity";

// Boot identity over a recording Electron app and a disposable app-data root.
// The environment selectors, identity table and failure writer are the real
// ones; only `app` paths, stderr and exit are recorders, so no Electron,
// installed profile or owner home is touched.

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function harness(env: Record<string, string | undefined>) {
  const appData = await mkdtemp(path.join(os.tmpdir(), "farol-identity-"));
  roots.push(appData);
  const paths: Record<string, string> = { appData };
  const sets: string[] = [];
  const written: string[] = [];
  const exits: number[] = [];
  const ports: BootIdentityPorts = {
    app: {
      getPath: (name) => paths[name] ?? "",
      setPath: (name, value) => {
        sets.push(name);
        paths[name] = value;
      },
      commandLine: { getSwitchValue: () => "" },
    },
    env,
    argv: [],
    stderr: { write: (message) => written.push(message) },
    exit: (code) => {
      exits.push(code);
      throw new Error(`EXIT:${code}`);
    },
  };
  return { appData, paths, sets, written, exits, ports };
}

describe("boot identity", () => {
  it("selects the production profile and pins both Electron paths to it", async () => {
    const h = await harness({});
    const identity = selectBootIdentity(h.ports);
    expect(identity.buildEnvironment).toBe("preview");
    expect(identity.runtimeEnvironment).toBe("preview");
    expect(identity.isolatedE2EHome).toBeUndefined();
    expect(h.sets).toEqual(["userData", "sessionData"]);
    expect(h.paths.userData).toBe(h.paths.sessionData);
    expect(h.paths.userData!.startsWith(h.appData)).toBe(true);
    expect(identity.activeDesktopIdentity.userData).toBe(h.paths.userData);
    expect(identity.activeDesktopIdentity.codexHome).toBe(
      path.join(h.paths.userData!, "farol-private", "codex-home"),
    );
    expect(identity.displayWindowTitle).toBe(
      [identity.displayProductName, identity.displayEdition]
        .filter(Boolean)
        .join(" · "),
    );
  });

  it("refuses an unknown build environment before choosing any path", async () => {
    const h = await harness({ FAROL_ENVIRONMENT: "staging" });
    expect(() => selectBootIdentity(h.ports)).toThrow(
      "DESKTOP_ENVIRONMENT_INVALID",
    );
    expect(h.sets).toEqual([]);
    expect(h.exits).toEqual([]);
  });

  it("ends startup through the failure writer for a retired profile marker", async () => {
    const h = await harness({ FAROL_PROFILE_MODE: "shared" });
    expect(() => selectBootIdentity(h.ports)).toThrow(/^EXIT:/u);
    expect(h.written.join("")).toContain("DESKTOP_PROFILE_SELECTION_INVALID");
    expect(h.exits).toHaveLength(1);
    expect(h.sets).toEqual([]);
  });
});
