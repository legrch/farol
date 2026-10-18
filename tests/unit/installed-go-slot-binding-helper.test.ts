import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installedGoSlotBindingHelper } from "../../apps/desktop/installed-slot-binding-helper";
import { BridgeError } from "../../apps/desktop/bridge/client.ts";
import type { BuildIdentity } from "../../src/pkg/build-info/identity";

// Constructed native-header bytes and independent fixture expectations only.
// Nothing is executed; these fixtures do not attest Go provenance or installation.
let root: string;
let bytes: Buffer;
const build = {
  buildId: "a".repeat(64),
  sourceCommit: "b".repeat(40),
  sourceTreeDigest: "c".repeat(64),
  sourceDirty: false,
} as BuildIdentity;
function artifact() {
  return {
    schema: "farol-core-artifact/1",
    build: {
      buildId: build.buildId,
      sourceSHA: build.sourceCommit,
      sourceTreeDigest: build.sourceTreeDigest,
      platform: {
        goos: process.platform,
        goarch: process.arch === "x64" ? "amd64" : process.arch,
      },
    },
    binary: {
      path: "farol-backend",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}
beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "farol-binding-resource-")),
  );
  bytes = Buffer.alloc(128);
  if (process.platform === "darwin") {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(process.arch === "arm64" ? 0x0100000c : 0x01000007, 4);
    bytes.writeUInt32LE(2, 12);
  } else if (process.platform === "linux") {
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(bytes);
    bytes.writeUInt16LE(2, 16);
    bytes.writeUInt16LE(process.arch === "arm64" ? 183 : 62, 18);
    bytes.writeUInt32LE(1, 20);
  } else throw Error("unsupported fixture platform");
  fs.writeFileSync(path.join(root, "farol-backend"), bytes, { mode: 0o755 });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it("qualifies only the compiled backend from the original held immutable image", async () => {
  const compiledArtifact = artifact();
  const recheck = vi.fn(async () => undefined);
  const beforeEffect = vi.fn();
  const input = {
    compiledArtifact,
    build: { ...build },
    directory: root,
    recheck,
    beforeEffect,
  };
  const selected = installedGoSlotBindingHelper(input);
  input.directory = "/other";
  compiledArtifact.binary.sha256 = "f".repeat(64);
  input.build.buildId = "f".repeat(64);
  expect(await selected.qualify()).toBe(path.join(root, "farol-backend"));
  expect(selected.buildId).toBe(build.buildId);
  expect(Object.isFrozen(selected)).toBe(true);
  expect(recheck).toHaveBeenCalledTimes(2);
  expect(beforeEffect).toHaveBeenCalledTimes(3);
});

it.each(["build", "commit", "tree", "dirty", "binary-path"])(
  "rejects crossed trusted %s before resource IO",
  (fault) => {
    const compiledArtifact = artifact();
    const expected = { ...build };
    if (fault === "build") expected.buildId = "d".repeat(64);
    if (fault === "commit") expected.sourceCommit = "d".repeat(40);
    if (fault === "tree") expected.sourceTreeDigest = "d".repeat(64);
    if (fault === "dirty") expected.sourceDirty = true;
    if (fault === "binary-path") compiledArtifact.binary.path = "other";
    const recheck = vi.fn(async () => undefined);
    expect(() =>
      installedGoSlotBindingHelper({
        compiledArtifact,
        build: expected,
        directory: root,
        recheck,
        beforeEffect() {},
      }),
    ).toThrow("UPDATE_SLOT_BINDING_GO_BUILD_MISMATCH");
    expect(recheck).not.toHaveBeenCalled();
  },
);

it.each([
  "changed-bytes",
  "text-shim",
  "hardlink",
  "redirect",
  "image-custody",
])("refuses %s without producing an executable capability", async (fault) => {
  const compiledArtifact = artifact();
  const file = path.join(root, "farol-backend");
  const recheck = vi.fn(async () => undefined);
  const selected = installedGoSlotBindingHelper({
    compiledArtifact,
    build,
    directory: root,
    recheck,
    beforeEffect() {},
  });
  if (fault === "changed-bytes") {
    bytes[127] = 1;
    fs.writeFileSync(file, bytes);
  }
  if (fault === "text-shim")
    fs.writeFileSync(file, "#!/usr/bin/python3\n".padEnd(bytes.length, " "));
  if (fault === "hardlink") fs.linkSync(file, path.join(root, "alias"));
  if (fault === "redirect") {
    fs.renameSync(file, file + ".original");
    fs.symlinkSync(file + ".original", file);
  }
  if (fault === "image-custody")
    recheck.mockRejectedValueOnce(Error("IMAGE_CHANGED"));
  await expect(selected.qualify()).rejects.toThrow();
});

it("refuses a cancelled host fence before inspecting the image", async () => {
  const recheck = vi.fn(async () => undefined);
  const selected = installedGoSlotBindingHelper({
    compiledArtifact: artifact(),
    build,
    directory: root,
    recheck,
    beforeEffect() {
      throw Error("CLOSED_ADMISSION");
    },
  });
  await expect(selected.qualify()).rejects.toThrow("CLOSED_ADMISSION");
  expect(recheck).not.toHaveBeenCalled();
});

it("preserves bridge refusal classification through the direct shared verifier", async () => {
  const selected = installedGoSlotBindingHelper({
    compiledArtifact: artifact(),
    build,
    directory: root,
    recheck: async () => undefined,
    beforeEffect() {},
  });
  bytes[127] = 1;
  fs.writeFileSync(path.join(root, "farol-backend"), bytes);
  const result = selected.qualify();
  await expect(result).rejects.toBeInstanceOf(BridgeError);
  await expect(result).rejects.toMatchObject({
    state: "refused",
    code: "core_artifact_digest_mismatch",
    message: "core_artifact_digest_mismatch",
  });
});

it("retains custody callback order around the exact byte inspection", async () => {
  const events: string[] = [];
  const open = fs.openSync;
  const inspect = vi.spyOn(fs, "openSync").mockImplementation((...args) => {
    events.push("inspect");
    return open(...args);
  });
  try {
    const selected = installedGoSlotBindingHelper({
      compiledArtifact: artifact(),
      build,
      directory: root,
      recheck: async () => {
        events.push("recheck");
      },
      beforeEffect() {
        events.push("beforeEffect");
      },
    });
    await selected.qualify();
    expect(events).toEqual([
      "beforeEffect",
      "recheck",
      "beforeEffect",
      "inspect",
      "recheck",
      "beforeEffect",
    ]);
  } finally {
    inspect.mockRestore();
  }
});
