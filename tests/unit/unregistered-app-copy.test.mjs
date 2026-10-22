import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  UNREGISTERED_COPY_SUFFIX,
  unregisteredAppCopyName,
} from "../e2e/lib/unregistered-app-copy.mjs";

const owned = [];

afterEach(async () => {
  for (const directory of owned.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe("unregistered app copy name", () => {
  it.each([
    ["Farol.app", `Farol${UNREGISTERED_COPY_SUFFIX}`],
    ["Farol.app", `Farol${UNREGISTERED_COPY_SUFFIX}`],
  ])("maps %s to a name that is not an application package", (name, copy) => {
    expect(unregisteredAppCopyName(name)).toBe(copy);
    expect(unregisteredAppCopyName(name).endsWith(".app")).toBe(false);
  });

  it.each(["Farol", ".app", "a/b.app", "Farol.app\0", "", undefined, 7])(
    "refuses %j, which does not name one app bundle",
    (name) => {
      expect(() => unregisteredAppCopyName(name)).toThrow(
        "UNREGISTERED_APP_COPY_NAME_INVALID",
      );
    },
  );

  it("keeps the bundle layout executable under the non-package name", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-unregistered-copy-")),
    );
    owned.push(root);
    const source = path.join(root, "Farol.app");
    await fs.mkdir(path.join(source, "Contents/MacOS"), { recursive: true });
    await fs.writeFile(
      path.join(source, "Contents/MacOS/launcher"),
      "#!/bin/sh\necho copied-launcher-ran\n",
      { mode: 0o755 },
    );
    const copy = path.join(root, unregisteredAppCopyName("Farol.app"));
    const cloned = spawnSync("/bin/cp", ["-cR", source, copy], {
      encoding: "utf8",
    });
    expect(cloned.status).toBe(0);
    const ran = spawnSync(path.join(copy, "Contents/MacOS/launcher"), {
      encoding: "utf8",
    });
    expect(ran.status).toBe(0);
    expect(ran.stdout).toBe("copied-launcher-ran\n");
  });
});

describe("mismatched-build e2e fixture", () => {
  it("copies the packaged app to a non-package path before executing it", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "tests/e2e/preview.e2e.mjs"),
      "utf8",
    );
    const start = source.indexOf("async function rejectMismatchedBuildLaunch");
    const end = source.indexOf("async function waitForPageState", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    expect(body).toContain("unregisteredAppCopyName(");
    // The mismatch itself is the point of the test and must stay.
    expect(body).toContain('manifest.sourceCommit = "f".repeat(40)');
    expect(body).toContain("INSTANCE_BUILD_IDENTITY_INVALID");
    // The executed copy must not be a `.app` path built from the layout name.
    expect(body).not.toMatch(
      /copiedApp\s*=\s*path\.join\(\s*temporary,\s*packageLayout\(/u,
    );
  });
});
