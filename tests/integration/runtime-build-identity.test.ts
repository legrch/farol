import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRuntimeBuildIdentity } from "../../src/apps/desktop/build-identity";
import {
  BuildIdentitySchema,
  canonicalBuildIdentityPayload,
  type BuildIdentity,
} from "../../src/pkg/build-info/identity";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

function identity(): BuildIdentity {
  const unsigned = {
    schema: 1,
    product: "Farol Next Preview",
    version: "0.1.0-preview.0",
    bundleId: "local.farol.next.preview",
    updateChannel: "local-preview-only",
    builtAt: "2026-09-16T10:00:00.000Z",
    sourceCommit: "a".repeat(40),
    sourceTreeDigest: "b".repeat(64),
    sourceDirty: false,
    buildId: "0".repeat(64),
  } as const;
  return BuildIdentitySchema.parse({
    ...unsigned,
    buildId: createHash("sha256")
      .update(canonicalBuildIdentityPayload(unsigned))
      .digest("hex"),
  });
}

async function writeIdentity(value: unknown): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-next-runtime-build-"),
  );
  roots.push(root);
  await fs.writeFile(
    path.join(root, "build-identity.json"),
    `${JSON.stringify(value)}\n`,
  );
  return root;
}

describe("runtime build identity", () => {
  it("reads the exact self-verifying build record", async () => {
    const expected = identity();
    expect(readRuntimeBuildIdentity(await writeIdentity(expected))).toEqual(
      expected,
    );
  });

  it("fails closed when a displayed field is changed", async () => {
    const changed = { ...identity(), builtAt: "2026-09-16T11:00:00.000Z" };
    const root = await writeIdentity(changed);
    expect(() => readRuntimeBuildIdentity(root)).toThrow(
      "RUNTIME_BUILD_IDENTITY_INVALID",
    );
  });

  it("refuses a symlinked build record", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-runtime-build-link-"),
    );
    roots.push(root);
    const target = path.join(root, "actual.json");
    await fs.writeFile(target, `${JSON.stringify(identity())}\n`);
    await fs.symlink(target, path.join(root, "build-identity.json"));

    expect(() => readRuntimeBuildIdentity(root)).toThrow(
      "RUNTIME_BUILD_IDENTITY_INVALID",
    );
  });
});
