import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decideSecondInstance,
  readBuildLaunchIdentity,
  waitForInstanceAcknowledgement,
  writeInstanceAcknowledgement,
  type InstanceRequest,
  type LaunchIdentity,
} from "../../src/apps/desktop/single-instance";

const roots: string[] = [];
const primary: LaunchIdentity = {
  sourceCommit: "a".repeat(40),
  sourceTreeDigest: "b".repeat(64),
};

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

function request(identity: LaunchIdentity): InstanceRequest {
  return {
    schema: "farol.next.single-instance/1",
    nonce: "c".repeat(32),
    ...identity,
  };
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
        request({ ...primary, sourceCommit: "d".repeat(40) }),
      ),
    ).toEqual({ nonce: "c".repeat(32), status: "identity-mismatch" });
    expect(decideSecondInstance(primary, { nonce: "c".repeat(32) })).toBeNull();
  });

  it("binds the runtime identity to the exact build manifest", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-instance-build-"),
    );
    roots.push(root);
    await fs.writeFile(
      path.join(root, "build-manifest.json"),
      `${JSON.stringify({
        schema: 3,
        sourceCommit: primary.sourceCommit,
        sourceTreeDigest: primary.sourceTreeDigest,
        dirty: false,
        inputExact: true,
      })}\n`,
    );
    expect(readBuildLaunchIdentity(root)).toEqual(primary);
    await fs.writeFile(
      path.join(root, "build-manifest.json"),
      `${JSON.stringify({
        schema: 3,
        sourceCommit: primary.sourceCommit,
        sourceTreeDigest: primary.sourceTreeDigest,
        dirty: true,
        inputExact: true,
      })}\n`,
    );
    expect(() => readBuildLaunchIdentity(root)).toThrow(
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
