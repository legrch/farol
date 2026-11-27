import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SUPPORTED_PREVIOUS_RELEASES,
  UpdateCompatUsageError,
  checkUpdateCompatibility,
  expectedIdentity,
  formatUpdateCompatReport,
  parseUpdateCompatArguments,
  updateCompatExitCode,
} from "../../tooling/update-compat-check.mjs";

const temporary = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((target) => fs.rm(target, { recursive: true, force: true })),
  );
});

const artifact = {
  product: "Farol",
  bundleId: "io.github.legrch.farol",
  version: "0.5.31",
  buildVersion: "86",
  updateChannel: "github-stable",
  buildId: "b".repeat(64),
  sourceCommit: "c".repeat(40),
  sourceTreeDigest: "d".repeat(64),
  artifactSha256: "e".repeat(64),
  signing: { kind: "unsigned", reason: "stable-distribution" },
  notarized: false,
};
const identity = () => expectedIdentity(artifact);
const sha = (source) => createHash("sha256").update(source).digest("hex");

async function workspace() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "farol-compat-"));
  temporary.push(directory);
  const appPath = path.join(directory, "Farol.app");
  await fs.mkdir(path.join(appPath, "Contents/Resources/app"), {
    recursive: true,
  });
  const artifactFile = path.join(directory, "artifact.json");
  await fs.writeFile(artifactFile, JSON.stringify(artifact));
  const verifier = async (name, source) => {
    const file = path.join(directory, name);
    await fs.writeFile(file, source);
    return file;
  };
  return { directory, appPath, artifactFile, verifier };
}

const printing = (value) =>
  `process.stdout.write(${JSON.stringify(JSON.stringify(value))});`;
const accepting = printing(identity());
const refusing = `throw new Error("NATIVE_HELPER_IDENTITY_INVALID");`;
const releasesFor = (...sources) =>
  sources.map((source, index) => ({
    version: `0.5.${index + 1}`,
    buildVersion: String(index + 1),
    verifierSha256: sha(source),
  }));

const candidate = (box, extra = {}) => ({
  artifact,
  artifactFile: box.artifactFile,
  appPath: box.appPath,
  version: "0.5.31",
  buildVersion: "86",
  channel: "github-stable",
  ...extra,
});

describe("update compatibility check", () => {
  it("ships a reviewed list with a digest for every supported release", () => {
    expect(SUPPORTED_PREVIOUS_RELEASES.map((entry) => entry.version)).toEqual([
      "0.5.29",
    ]);
    for (const entry of SUPPORTED_PREVIOUS_RELEASES)
      expect(entry.verifierSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("expects the installed updater's identity from the artifact", () => {
    expect(identity()).toMatchObject({
      signing: "unsigned",
      notarized: false,
      updateChannel: "github-stable",
    });
  });

  it("runs every supported verifier, reports each and fails on a refusal", async () => {
    const box = await workspace();
    const old = await box.verifier("old.mjs", accepting);
    const older = await box.verifier("older.mjs", refusing);
    const outcome = await checkUpdateCompatibility({
      ...candidate(box),
      verifiers: [old, older],
      releases: releasesFor(accepting, refusing),
    });
    expect(outcome.results).toEqual([
      { verifier: old, release: "0.5.1", ok: true, reason: null },
      {
        verifier: older,
        release: "0.5.2",
        ok: false,
        reason: "NATIVE_HELPER_IDENTITY_INVALID",
      },
    ]);
    expect(outcome.skipped).toEqual([]);
    const report = formatUpdateCompatReport(outcome, "Farol 0.5.31");
    expect(report).toContain(`PASS     ${old}`);
    expect(report).toContain(
      `REFUSED  ${older}  NATIVE_HELPER_IDENTITY_INVALID`,
    );
    expect(report).toContain("1 of 2");
    expect(updateCompatExitCode(outcome, false)).toBe(1);
  });

  it("passes the exact argument order the installed updater uses", async () => {
    const box = await workspace();
    const echo = await box.verifier("echo.mjs", accepting);
    const calls = [];
    const outcome = await checkUpdateCompatibility({
      ...candidate(box),
      verifiers: [echo],
      releases: releasesFor(accepting),
      runtime: "/runtime/node",
      run: (command, args, options) => {
        calls.push({ command, args, env: options.env });
        return { status: 0, stdout: JSON.stringify(identity()) };
      },
    });
    expect(outcome.results[0].ok).toBe(true);
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

  it("passes only when every listed release is covered and accepted", async () => {
    const box = await workspace();
    const outcome = await checkUpdateCompatibility({
      ...candidate(box),
      verifiers: [await box.verifier("a.mjs", accepting)],
      releases: releasesFor(accepting),
    });
    expect(formatUpdateCompatReport(outcome, "Farol 0.5.31")).toContain(
      "UPDATE COMPATIBILITY PASSED",
    );
    expect(updateCompatExitCode(outcome, false)).toBe(0);
  });

  it("refuses a verifier whose digest is not a supported release", async () => {
    const box = await workspace();
    const stranger = await box.verifier("stranger.mjs", accepting);
    const outcome = await checkUpdateCompatibility({
      ...candidate(box),
      verifiers: [stranger],
      releases: releasesFor(refusing),
    });
    expect(outcome.results[0]).toMatchObject({
      ok: false,
      reason: "UPDATE_COMPAT_VERIFIER_UNKNOWN",
    });
    expect(outcome.skipped).toEqual(["0.5.1"]);
  });

  it("refuses the candidate's own verifier by path and by copied bytes", async () => {
    const box = await workspace();
    const own = path.join(
      box.appPath,
      "Contents/Resources/app/update-package.mjs",
    );
    await fs.writeFile(own, accepting);
    const copy = await box.verifier("copy.mjs", accepting);
    const outcome = await checkUpdateCompatibility({
      ...candidate(box),
      verifiers: [own, copy],
      // Even if the digest were listed, the candidate's own bytes never count.
      releases: releasesFor(accepting),
    });
    expect(outcome.results.map((entry) => entry.reason)).toEqual([
      "UPDATE_COMPAT_VERIFIER_IS_CANDIDATE",
      "UPDATE_COMPAT_VERIFIER_IS_CANDIDATE",
    ]);
    expect(updateCompatExitCode(outcome, false)).toBe(1);
  });

  it("refuses a missing verifier and a non-file", async () => {
    const box = await workspace();
    const outcome = await checkUpdateCompatibility({
      ...candidate(box),
      verifiers: [path.join(box.directory, "absent.mjs"), box.directory],
      releases: releasesFor(accepting),
    });
    expect(outcome.results.map((entry) => entry.reason)).toEqual([
      "UPDATE_COMPAT_VERIFIER_MISSING",
      "UPDATE_COMPAT_VERIFIER_INVALID",
    ]);
  });

  it("refuses missing coverage, and a partial run is reported but never exits 0", async () => {
    const box = await workspace();
    const outcome = await checkUpdateCompatibility({
      ...candidate(box),
      verifiers: [await box.verifier("a.mjs", accepting)],
      releases: releasesFor(accepting, refusing),
    });
    expect(outcome.results[0].ok).toBe(true);
    expect(outcome.skipped).toEqual(["0.5.2"]);
    const strict = formatUpdateCompatReport(outcome, "Farol 0.5.31", false);
    expect(strict).toContain(
      "REFUSED  release 0.5.2  UPDATE_COMPAT_RELEASE_NOT_COVERED",
    );
    expect(strict).toContain("UPDATE COMPATIBILITY FAILED");
    expect(updateCompatExitCode(outcome, false)).toBe(1);
    const partial = formatUpdateCompatReport(outcome, "Farol 0.5.31", true);
    expect(partial).toContain("SKIPPED  release 0.5.2");
    expect(partial).toContain("UPDATE COMPATIBILITY PARTIAL");
    expect(partial).not.toContain("PASSED");
    expect(updateCompatExitCode(outcome, true)).toBe(3);
  });

  it("refuses an identity that differs from the candidate's artifact", async () => {
    const box = await workspace();
    const { buildId: _omitted, ...missing } = identity();
    const variants = [
      { ...identity(), updateChannel: "github-owner-beta" },
      { ...identity(), sourceCommit: "f".repeat(40) },
      { ...identity(), notarized: true },
      { ...identity(), signing: "signed" },
      missing,
      { ...identity(), extra: 1 },
    ];
    const sources = variants.map(printing);
    const files = [];
    for (const [index, source] of sources.entries())
      files.push(await box.verifier(`v${index}.mjs`, source));
    const silent = await box.verifier("silent.mjs", "");
    const outcome = await checkUpdateCompatibility({
      ...candidate(box),
      verifiers: [...files, silent],
      releases: releasesFor(...sources, ""),
    });
    expect(outcome.results.map((entry) => entry.reason)).toEqual([
      "UPDATE_COMPAT_IDENTITY_MISMATCH:updateChannel",
      "UPDATE_COMPAT_IDENTITY_MISMATCH:sourceCommit",
      "UPDATE_COMPAT_IDENTITY_MISMATCH:notarized",
      "UPDATE_COMPAT_IDENTITY_MISMATCH:signing",
      "UPDATE_COMPAT_IDENTITY_FIELDS_INVALID",
      "UPDATE_COMPAT_IDENTITY_FIELDS_INVALID",
      "UPDATE_COMPAT_IDENTITY_INVALID",
    ]);
  });

  it("reports a verifier that exits without a named error", async () => {
    const box = await workspace();
    const quiet = await box.verifier("quiet.mjs", "process.exit(3);");
    const { results } = await checkUpdateCompatibility({
      ...candidate(box),
      verifiers: [quiet],
      releases: releasesFor("process.exit(3);"),
    });
    expect(results[0]).toMatchObject({
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

  it("parses repeated verifiers and --allow-partial, and rejects bad options", () => {
    expect(
      parseUpdateCompatArguments([
        "--verifier",
        "a.mjs",
        "--allow-partial",
        "--verifier",
        "b.mjs",
        "--channel",
        "github-stable",
      ]),
    ).toEqual({
      verifiers: ["a.mjs", "b.mjs"],
      allowPartial: true,
      channel: "github-stable",
    });
    for (const bad of [
      ["--verifier"],
      ["--bogus", "x", "--verifier", "a"],
      ["--verifier", "a", "--channel", "x", "--channel", "y"],
      ["--verifier", "a", "--allow-partial", "--allow-partial"],
    ])
      expect(() => parseUpdateCompatArguments(bad)).toThrow(
        UpdateCompatUsageError,
      );
    expect(() => parseUpdateCompatArguments([])).toThrow(
      "UPDATE_COMPAT_NO_VERIFIER",
    );
    expect(() => parseUpdateCompatArguments(["--allow-partial"])).toThrow(
      "UPDATE_COMPAT_NO_VERIFIER",
    );
  });
});
