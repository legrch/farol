import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  UpdateCompatUsageError,
  checkUpdateCompatibility,
  formatUpdateCompatReport,
  parseUpdateCompatArguments,
} from "../../tooling/update-compat-check.mjs";

const temporary = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((target) => fs.rm(target, { recursive: true, force: true })),
  );
});

async function workspace() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "farol-compat-"));
  temporary.push(directory);
  const appPath = path.join(directory, "Farol.app");
  await fs.mkdir(path.join(appPath, "Contents/Resources/app"), {
    recursive: true,
  });
  const artifactFile = path.join(directory, "artifact.json");
  await fs.writeFile(artifactFile, "{}");
  const verifier = async (name, source) => {
    const file = path.join(directory, name);
    await fs.writeFile(file, source);
    return file;
  };
  return { directory, appPath, artifactFile, verifier };
}

const accepting = `process.stdout.write(JSON.stringify({ updateChannel: process.argv[6], args: process.argv.slice(3) }));`;
const refusing = `throw new Error("NATIVE_HELPER_IDENTITY_INVALID");`;

const candidate = (box, extra = {}) => ({
  artifactFile: box.artifactFile,
  appPath: box.appPath,
  version: "0.5.31",
  buildVersion: "86",
  channel: "github-stable",
  ...extra,
});

describe("update compatibility check", () => {
  it("runs every previous verifier with the candidate's identity and reports each", async () => {
    const box = await workspace();
    const old = await box.verifier("old.mjs", accepting);
    const older = await box.verifier("older.mjs", refusing);
    const results = await checkUpdateCompatibility({
      ...candidate(box),
      verifiers: [old, older],
    });
    expect(results).toEqual([
      { verifier: old, ok: true, reason: null },
      {
        verifier: older,
        ok: false,
        reason: "NATIVE_HELPER_IDENTITY_INVALID",
      },
    ]);
    const report = formatUpdateCompatReport(results, "Farol 0.5.31");
    expect(report).toContain(`PASS     ${old}`);
    expect(report).toContain(
      `REFUSED  ${older}  NATIVE_HELPER_IDENTITY_INVALID`,
    );
    expect(report).toContain("UPDATE COMPATIBILITY FAILED");
    expect(report).toContain("1 of 2");
  });

  it("passes the exact argument order the installed updater uses", async () => {
    const box = await workspace();
    const echo = await box.verifier("echo.mjs", accepting);
    const calls = [];
    const results = await checkUpdateCompatibility({
      ...candidate(box),
      verifiers: [echo],
      runtime: "/runtime/node",
      run: (command, args, options) => {
        calls.push({ command, args, env: options.env });
        return {
          status: 0,
          stdout: JSON.stringify({ updateChannel: "github-stable" }),
        };
      },
    });
    expect(results[0].ok).toBe(true);
    expect(calls).toEqual([
      {
        command: "/runtime/node",
        args: [
          echo,
          box.artifactFile,
          box.appPath,
          "0.5.31",
          "86",
          "github-stable",
        ],
        env: {
          PATH: "/usr/bin:/bin",
          ELECTRON_RUN_AS_NODE: "1",
          ELECTRON_NO_ASAR: "1",
        },
      },
    ]);
  });

  it("passes when every verifier accepts", async () => {
    const box = await workspace();
    const results = await checkUpdateCompatibility({
      ...candidate(box),
      verifiers: [
        await box.verifier(
          "a.mjs",
          `process.stdout.write(JSON.stringify({ updateChannel: "github-stable" }));`,
        ),
      ],
    });
    expect(formatUpdateCompatReport(results, "Farol 0.5.31")).toContain(
      "UPDATE COMPATIBILITY PASSED",
    );
  });

  it("refuses a verifier that accepts but measures another channel or prints no identity", async () => {
    const box = await workspace();
    const wrong = await box.verifier(
      "wrong.mjs",
      `process.stdout.write(JSON.stringify({ updateChannel: "github-owner-beta" }));`,
    );
    const silent = await box.verifier("silent.mjs", "");
    const results = await checkUpdateCompatibility({
      ...candidate(box),
      verifiers: [wrong, silent],
    });
    expect(results.map((entry) => entry.reason)).toEqual([
      "UPDATE_COMPAT_IDENTITY_CHANNEL_INVALID",
      "UPDATE_COMPAT_IDENTITY_CHANNEL_INVALID",
    ]);
  });

  it("refuses a missing verifier, a non-file and the candidate's own verifier", async () => {
    const box = await workspace();
    const own = path.join(
      box.appPath,
      "Contents/Resources/app/update-package.mjs",
    );
    await fs.writeFile(own, accepting);
    const results = await checkUpdateCompatibility({
      ...candidate(box),
      verifiers: [path.join(box.directory, "absent.mjs"), box.directory, own],
    });
    expect(results.map((entry) => entry.reason)).toEqual([
      "UPDATE_COMPAT_VERIFIER_MISSING",
      "UPDATE_COMPAT_VERIFIER_INVALID",
      "UPDATE_COMPAT_VERIFIER_IS_CANDIDATE",
    ]);
  });

  it("reports a verifier that exits without a named error", async () => {
    const box = await workspace();
    const quiet = await box.verifier("quiet.mjs", "process.exit(3);");
    const [result] = await checkUpdateCompatibility({
      ...candidate(box),
      verifiers: [quiet],
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "UPDATE_COMPAT_VERIFIER_EXIT:3",
    });
  });

  it("refuses to run without a verifier or with an unknown channel", async () => {
    const box = await workspace();
    await expect(
      checkUpdateCompatibility({ ...candidate(box), verifiers: [] }),
    ).rejects.toThrow("UPDATE_COMPAT_NO_VERIFIER");
    await expect(
      checkUpdateCompatibility({
        ...candidate(box, { channel: "local-preview-only" }),
        verifiers: ["x"],
      }),
    ).rejects.toThrow("UPDATE_COMPAT_CHANNEL_INVALID");
  });

  it("parses repeated verifiers and rejects unknown or repeated options", () => {
    expect(
      parseUpdateCompatArguments([
        "--verifier",
        "a.mjs",
        "--verifier",
        "b.mjs",
        "--channel",
        "github-stable",
      ]),
    ).toEqual({
      verifiers: ["a.mjs", "b.mjs"],
      channel: "github-stable",
    });
    for (const bad of [
      ["--verifier"],
      ["--bogus", "x", "--verifier", "a"],
      ["--verifier", "a", "--channel", "x", "--channel", "y"],
    ])
      expect(() => parseUpdateCompatArguments(bad)).toThrow(
        UpdateCompatUsageError,
      );
    expect(() => parseUpdateCompatArguments([])).toThrow(
      "UPDATE_COMPAT_NO_VERIFIER",
    );
  });
});
