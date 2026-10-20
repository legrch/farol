import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyDependencyPlan,
  main,
  planDependencyActions,
  readDependencyState,
} from "../../tooling/dev.mjs";
import { packageTreeDigest } from "../../tooling/dependency-digests.mjs";

// Synthetic package trees only: no npm, network, Electron, Go, or real profile.
// Explicit platform arguments exercise selection, not native platform acceptance.
const owned = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "farol-dev-deps-"));
  owned.push(root);
  const packages = {};
  const reviewed = {};
  for (const name of ["esbuild", "@esbuild/darwin-arm64", "zod"]) {
    const key = `node_modules/${name}`;
    const directory = path.join(root, key);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "index.js"),
      "export const value = 1;\n",
    );
    packages[key] = { version: "1.0.0", integrity: "sha512-fixture" };
    reviewed[key] = {
      version: "1.0.0",
      treeSha256: packageTreeDigest(directory),
    };
  }
  fs.mkdirSync(path.join(root, "tooling"));
  const lock = JSON.stringify({ packages });
  fs.writeFileSync(path.join(root, "package-lock.json"), lock);
  fs.writeFileSync(path.join(root, "node_modules/.package-lock.json"), lock);
  const manifest = path.join(root, "tooling/dependency-digests.json");
  fs.writeFileSync(manifest, JSON.stringify({ schema: 1, packages: reviewed }));
  return {
    root,
    manifest,
    reviewed,
    inspect: () => readDependencyState(root, "darwin", "arm64"),
  };
}
afterEach(() => {
  for (const root of owned.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("Dev dependency bytes", () => {
  it("accepts exact locked and reviewed synthetic inputs", () => {
    expect(fixture().inspect()).toEqual({ ok: true, reasons: [] });
  });

  it("detects an added .DS_Store despite identical lock metadata without changing trust", () => {
    const f = fixture();
    const before = fs.readFileSync(f.manifest);
    fs.writeFileSync(
      path.join(f.root, "node_modules/zod/.DS_Store"),
      "synthetic Finder metadata",
    );
    expect(f.inspect()).toEqual({
      ok: false,
      reasons: [
        "node_modules/zod does not match reviewed bytes (bytes-differ)",
      ],
    });
    expect(fs.readFileSync(f.manifest).equals(before)).toBe(true);
    expect(fs.existsSync(path.join(f.root, "node_modules/zod/.DS_Store"))).toBe(
      true,
    );
  });

  it("detects changed package content with unchanged metadata", () => {
    const f = fixture();
    fs.writeFileSync(
      path.join(f.root, "node_modules/zod/index.js"),
      "different source",
    );
    expect(f.inspect().reasons).toContain(
      "node_modules/zod does not match reviewed bytes (bytes-differ)",
    );
  });

  it("detects missing package content with unchanged metadata", () => {
    const f = fixture();
    fs.unlinkSync(path.join(f.root, "node_modules/zod/index.js"));
    expect(f.inspect().ok).toBe(false);
  });

  it("retains executable-bit sensitivity", () => {
    const f = fixture();
    fs.chmodSync(path.join(f.root, "node_modules/zod/index.js"), 0o700);
    expect(f.inspect().ok).toBe(false);
  });

  it("does not trust a symlinked package root", () => {
    const f = fixture();
    const original = path.join(f.root, "node_modules/zod");
    const moved = path.join(f.root, "moved-zod");
    fs.renameSync(original, moved);
    fs.symlinkSync(moved, original);
    expect(f.inspect().reasons).toContain(
      "node_modules/zod does not match reviewed bytes (unreadable)",
    );
  });

  it("does not require a foreign esbuild platform package", () => {
    const f = fixture();
    f.reviewed["node_modules/@esbuild/linux-arm64"] = {
      version: "1.0.0",
      treeSha256: "0".repeat(64),
    };
    fs.writeFileSync(
      f.manifest,
      JSON.stringify({ schema: 1, packages: f.reviewed }),
    );
    expect(f.inspect().ok).toBe(true);
  });

  it("requires a reviewed current-platform compiler", () => {
    const f = fixture();
    delete f.reviewed["node_modules/@esbuild/darwin-arm64"];
    fs.writeFileSync(
      f.manifest,
      JSON.stringify({ schema: 1, packages: f.reviewed }),
    );
    expect(f.inspect().reasons).toContain(
      "node_modules/@esbuild/darwin-arm64 does not match reviewed bytes (not-reviewed)",
    );
  });

  it("refuses an escaping manifest key rather than reading outside packages", () => {
    const f = fixture();
    f.reviewed["node_modules/../outside"] = { treeSha256: "0".repeat(64) };
    fs.writeFileSync(
      f.manifest,
      JSON.stringify({ schema: 1, packages: f.reviewed }),
    );
    expect(f.inspect).toThrow("DEV_DEPENDENCY_MANIFEST_INVALID");
  });

  it("refuses an escaping key even among ignored foreign compiler entries", () => {
    const f = fixture();
    for (const key of [
      "node_modules/@esbuild/../outside",
      "node_modules/@esbuild/..",
    ]) {
      f.reviewed[key] = { treeSha256: "0".repeat(64) };
      fs.writeFileSync(
        f.manifest,
        JSON.stringify({ schema: 1, packages: f.reviewed }),
      );
      expect(f.inspect).toThrow("DEV_DEPENDENCY_MANIFEST_INVALID");
      delete f.reviewed[key];
    }
  });

  it("retains metadata mismatch before any byte-based success", () => {
    const f = fixture();
    const file = path.join(f.root, "node_modules/.package-lock.json");
    const lock = JSON.parse(fs.readFileSync(file, "utf8"));
    lock.packages["node_modules/zod"].version = "0.0.1";
    fs.writeFileSync(file, JSON.stringify(lock));
    expect(f.inspect().ok).toBe(false);
    expect(f.inspect().reasons[0]).toContain("0.0.1");
  });
});

function plan(dependenciesOk = false, electronPresent = true) {
  return planDependencyActions({
    dependencyState: {
      ok: dependenciesOk,
      reasons: dependenciesOk ? [] : ["byte drift"],
    },
    electronPresent,
  });
}

describe("Dev preparation uses post-install facts", () => {
  it("restores Electron removed by npm ci despite its stale pre-install presence", async () => {
    const calls = [];
    let present = true;
    const result = await applyDependencyPlan(plan(), {
      runNpmCi: () => {
        calls.push("npm");
        present = false;
        return 0;
      },
      runElectronInstall: () => {
        calls.push("electron");
        present = true;
        return 0;
      },
      electronPresent: () => present,
      verifyDependencies: () => {
        calls.push("verify");
        return { ok: true, reasons: [] };
      },
    });
    expect(result).toBe(0);
    expect(calls).toEqual(["npm", "electron", "verify"]);
  });

  it("does not repeat Electron installation when npm already supplied it", async () => {
    let present = false;
    const calls = [];
    expect(
      await applyDependencyPlan(plan(false, false), {
        runNpmCi: () => {
          present = true;
          calls.push("npm");
          return 0;
        },
        runElectronInstall: () => {
          calls.push("electron");
          return 0;
        },
        electronPresent: () => present,
        verifyDependencies: () => ({ ok: true, reasons: [] }),
      }),
    ).toBe(0);
    expect(calls).toEqual(["npm"]);
  });

  it("does not loop or bless an npm success with unresolved byte drift", async () => {
    const calls = [];
    const messages = [];
    expect(
      await applyDependencyPlan(plan(), {
        runNpmCi: () => {
          calls.push("npm");
          return 0;
        },
        runElectronInstall: () => {
          calls.push("electron");
          return 0;
        },
        electronPresent: () => true,
        verifyDependencies: () => ({ ok: false, reasons: ["still different"] }),
        log: (line) => messages.push(line),
      }),
    ).toBe(1);
    expect(calls).toEqual(["npm"]);
    expect(messages.join("\n")).toContain("do not refresh expected digests");
  });

  it("does not treat an Electron install exit zero as proof of presence", async () => {
    let attempts = 0;
    expect(
      await applyDependencyPlan(plan(true, false), {
        runNpmCi: () => {
          throw Error("unexpected npm");
        },
        runElectronInstall: () => {
          attempts++;
          return 0;
        },
        electronPresent: () => false,
        verifyDependencies: () => ({ ok: true, reasons: [] }),
      }),
    ).toBe(1);
    expect(attempts).toBe(1);
  });

  it("preserves npm failure and does not attempt a successor", async () => {
    expect(
      await applyDependencyPlan(plan(), {
        runNpmCi: () => 7,
        runElectronInstall: () => {
          throw Error("unexpected successor");
        },
        electronPresent: () => {
          throw Error("unexpected observation");
        },
        verifyDependencies: () => {
          throw Error("unexpected verification");
        },
      }),
    ).toBe(7);
  });

  it("preserves Electron failure without claiming final verification", async () => {
    expect(
      await applyDependencyPlan(plan(true, false), {
        runNpmCi: () => {
          throw Error("unexpected npm");
        },
        runElectronInstall: () => 8,
        electronPresent: () => false,
        verifyDependencies: () => {
          throw Error("unexpected verification");
        },
      }),
    ).toBe(8);
  });

  it("checks current bytes without reinstalling already healthy inputs", async () => {
    let verified = 0;
    expect(
      await applyDependencyPlan(plan(true), {
        runNpmCi: () => {
          throw Error("unexpected npm");
        },
        runElectronInstall: () => {
          throw Error("unexpected Electron");
        },
        electronPresent: () => true,
        verifyDependencies: () => {
          verified++;
          return { ok: true, reasons: [] };
        },
      }),
    ).toBe(0);
    expect(verified).toBe(1);
  });

  it("keeps build and launch unreachable after a failed dependency repair", async () => {
    const calls = [];
    await main([], {
      pinned: true,
      currentNode: "24.20.0",
      getCurrentNpmVersion: () => "11.19.0",
      prepareBuild: async () => {
        calls.push("prepare");
      },
      ensureDependencies: () =>
        applyDependencyPlan(plan(), {
          runNpmCi: () => {
            calls.push("npm");
            return 0;
          },
          runElectronInstall: () => {
            throw Error("unexpected Electron");
          },
          electronPresent: () => true,
          verifyDependencies: () => ({ ok: false, reasons: ["unresolved"] }),
        }),
      runBuild: () => {
        calls.push("build");
        return 0;
      },
      launch: () => {
        calls.push("launch");
      },
      log: () => {},
      exit: (code) => {
        calls.push(`exit:${code}`);
      },
    });
    expect(calls).toEqual(["prepare", "npm", "exit:1"]);
  });
});
