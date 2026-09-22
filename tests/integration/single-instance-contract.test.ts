import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildIdentity } from "../../src/pkg/build-info/identity";
import {
  decideSecondInstance,
  readBuildLaunchIdentity,
  sameLaunchIdentity,
  waitForInstanceAcknowledgement,
  writeInstanceAcknowledgement,
  type InstanceRequest,
  type LaunchIdentity,
} from "../../src/apps/desktop/single-instance";

const roots: string[] = [];
const cleanInputLedger = Buffer.from("[]\n");
const cleanInputLedgerSha256 = createHash("sha256")
  .update(cleanInputLedger)
  .digest("hex");
const primary: LaunchIdentity = {
  environment: "preview",
  sourceCommit: "a".repeat(40),
  sourceTreeDigest: "b".repeat(64),
  inputLedgerSha256: cleanInputLedgerSha256,
};
const buildId = "e".repeat(64);

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

function request(identity: LaunchIdentity): InstanceRequest {
  return {
    schema: "farol.next.single-instance/2",
    nonce: "c".repeat(32),
    ...identity,
  };
}

function runtimeIdentity(sourceDirty: boolean): BuildIdentity {
  return {
    schema: 1,
    product: "Farol Next Preview",
    version: "0.1.0-preview.0",
    bundleId: "local.farol.next.preview",
    updateChannel: "local-preview-only",
    builtAt: new Date(0).toISOString(),
    sourceCommit: primary.sourceCommit,
    sourceTreeDigest: primary.sourceTreeDigest,
    sourceDirty,
    buildId,
  };
}

async function writeBuildFixture(
  root: string,
  input: Readonly<{
    dirty: boolean;
    inputExact: boolean;
    inputLedger?: Buffer;
  }>,
): Promise<{ runtime: BuildIdentity; inputLedgerSha256: string }> {
  const inputLedger = input.inputLedger ?? cleanInputLedger;
  const inputLedgerSha256 = createHash("sha256")
    .update(inputLedger)
    .digest("hex");
  await fs.writeFile(path.join(root, "input-manifest.json"), inputLedger);
  await fs.writeFile(
    path.join(root, "build-manifest.json"),
    `${JSON.stringify({
      schema: 3,
      buildId,
      sourceCommit: primary.sourceCommit,
      sourceTreeDigest: primary.sourceTreeDigest,
      dirty: input.dirty,
      inputExact: input.inputExact,
      inputLedgerSha256,
    })}\n`,
  );
  return { runtime: runtimeIdentity(input.dirty), inputLedgerSha256 };
}

describe("Farol Next single-instance identity", () => {
  it("reopens only the exact running build", () => {
    expect(decideSecondInstance(primary, request(primary))).toEqual({
      nonce: "c".repeat(32),
      status: "reopened",
    });
    expect(
      decideSecondInstance(
        primary,
        request({
          ...primary,
          sourceCommit: "d".repeat(40),
        }),
      ),
    ).toEqual({ nonce: "c".repeat(32), status: "identity-mismatch" });
    expect(decideSecondInstance(primary, { nonce: "c".repeat(32) })).toBeNull();
  });

  it("binds the runtime identity to the exact build manifest", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-instance-build-"),
    );
    roots.push(root);
    const clean = await writeBuildFixture(root, {
      dirty: false,
      inputExact: true,
    });
    expect(readBuildLaunchIdentity(root, "preview", clean.runtime)).toEqual(
      primary,
    );
    const dirty = await writeBuildFixture(root, {
      dirty: true,
      inputExact: true,
    });
    expect(() =>
      readBuildLaunchIdentity(root, "preview", dirty.runtime),
    ).toThrow("INSTANCE_BUILD_IDENTITY_INVALID");
  });

  it("admits dirty build inputs only for an explicit DEV launch", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-dev-instance-build-"),
    );
    roots.push(root);
    const inputLedger = Buffer.from(
      `${JSON.stringify([
        {
          kind: "source",
          path: "src/apps/desktop/main.ts",
          sha256: "d".repeat(64),
          exact: false,
        },
      ])}\n`,
    );
    const dirty = await writeBuildFixture(root, {
      dirty: true,
      inputExact: false,
      inputLedger,
    });

    expect(readBuildLaunchIdentity(root, "dev", dirty.runtime)).toEqual({
      ...primary,
      environment: "dev",
      inputLedgerSha256: dirty.inputLedgerSha256,
    });
    expect(() =>
      readBuildLaunchIdentity(root, "preview", dirty.runtime),
    ).toThrow("INSTANCE_BUILD_IDENTITY_INVALID");
  });

  it("does not let two dirty input sets impersonate one DEV instance", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-dev-instance-inputs-"),
    );
    roots.push(root);
    const firstFixture = await writeBuildFixture(root, {
      dirty: true,
      inputExact: false,
      inputLedger: Buffer.from('[{"path":"first"}]\n'),
    });
    const first = readBuildLaunchIdentity(root, "dev", firstFixture.runtime);
    const secondFixture = await writeBuildFixture(root, {
      dirty: true,
      inputExact: false,
      inputLedger: Buffer.from('[{"path":"second"}]\n'),
    });
    const second = readBuildLaunchIdentity(root, "dev", secondFixture.runtime);

    expect(first.sourceCommit).toBe(second.sourceCommit);
    expect(first.sourceTreeDigest).toBe(second.sourceTreeDigest);
    expect(first.inputLedgerSha256).not.toBe(second.inputLedgerSha256);
    expect(sameLaunchIdentity(first, second)).toBe(false);
  });

  it("rejects a DEV manifest whose recorded input digest is not present", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-dev-instance-tampered-"),
    );
    roots.push(root);
    const dirty = await writeBuildFixture(root, {
      dirty: true,
      inputExact: false,
      inputLedger: Buffer.from('[{"path":"before"}]\n'),
    });
    await fs.writeFile(
      path.join(root, "input-manifest.json"),
      '[{"path":"after"}]\n',
    );

    expect(() => readBuildLaunchIdentity(root, "dev", dirty.runtime)).toThrow(
      "INSTANCE_BUILD_IDENTITY_INVALID",
    );
  });

  it("round-trips one nonce-bound acknowledgement and consumes it", async () => {
    const userData = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-instance-ack-"),
    );
    roots.push(userData);
    const second = request(primary);
    await writeInstanceAcknowledgement(userData, second, "reopened");
    await expect(
      waitForInstanceAcknowledgement(userData, second, {
        timeoutMs: 250,
        pollMs: 5,
      }),
    ).resolves.toEqual({ ...second, status: "reopened" });
    await expect(
      waitForInstanceAcknowledgement(userData, second, {
        timeoutMs: 20,
        pollMs: 5,
      }),
    ).resolves.toBeNull();
  });

  it("publishes only a complete acknowledgement while a reader is polling", async () => {
    const userData = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-instance-atomic-"),
    );
    roots.push(userData);
    const second = request(primary);
    let releasePublication: (() => void) | undefined;
    const publicationReleased = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    let announcePublished: (() => void) | undefined;
    const published = new Promise<void>((resolve) => {
      announcePublished = resolve;
    });
    const writer = writeInstanceAcknowledgement(
      userData,
      second,
      "reopened",
      primary,
      {
        afterAtomicPublish: async () => {
          announcePublished?.();
          await publicationReleased;
        },
      },
    );
    await published;
    const reader = waitForInstanceAcknowledgement(userData, second, {
      timeoutMs: 500,
      pollMs: 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    releasePublication?.();
    await writer;
    await expect(reader).resolves.toEqual({ ...second, status: "reopened" });
  });
});
