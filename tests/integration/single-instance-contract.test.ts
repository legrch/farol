import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { BuildIdentity } from "../../src/pkg/build-info/identity";
import {
  createInstanceRequest,
  decideSecondInstance,
  readBuildLaunchIdentity,
  sameLaunchIdentity,
  secondInstanceRefusalMessage,
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

function request(
  identity: LaunchIdentity,
): Extract<InstanceRequest, { schema: "farol.next.single-instance/2" }> {
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

function goCoreDeclaration() {
  return {
    schema: "farol-core-artifact/1",
    build: {
      buildId,
      sourceSHA: primary.sourceCommit,
      sourceTreeDigest: primary.sourceTreeDigest,
      platform: { goos: "darwin", goarch: "arm64" },
    },
    binary: { path: "farol-backend", size: 128, sha256: "a".repeat(64) },
  };
}

describe("Farol Next single-instance identity", () => {
  it("explains a verified background-only refusal without claiming an identity failure", () => {
    const hidden = createInstanceRequest(primary, true);
    const acknowledgement = {
      ...request(primary),
      nonce: hidden.nonce,
      status: "reopen-failed" as const,
    };
    expect(secondInstanceRefusalMessage(hidden, acknowledgement)).toBe(
      "Farol Next refused the background launch because this exact candidate is already running. Quit it before starting a hidden instance.",
    );
    const verificationFailure =
      "Farol Next refused the second launch because the running build could not be verified as this exact candidate.";
    expect(secondInstanceRefusalMessage(hidden, null)).toBe(
      "Farol Next could not confirm background-only admission with the running instance. Quit it before starting a hidden instance.",
    );
    expect(
      secondInstanceRefusalMessage(hidden, {
        ...acknowledgement,
        sourceCommit: "d".repeat(40),
      }),
    ).toBe(verificationFailure);
    expect(
      secondInstanceRefusalMessage(
        createInstanceRequest(primary),
        acknowledgement,
      ),
    ).toBe(verificationFailure);
  });

  it("uses a distinct background request version while ordinary requests stay on version 2", () => {
    const ordinary = createInstanceRequest(primary);
    const hidden = createInstanceRequest(primary, true);
    expect(ordinary.schema).toBe("farol.next.single-instance/2");
    expect(hidden.schema).toBe("farol.next.single-instance/3");
    // Frozen older-consumer contract: its strict v2 request never accepted
    // unknown intent fields. This is protocol evidence, not a live old primary.
    const olderRequest = z.strictObject({
      schema: z.literal("farol.next.single-instance/2"),
      nonce: z.string(),
      environment: z.enum(["preview", "dev"]),
      sourceCommit: z.string(),
      sourceTreeDigest: z.string(),
      inputLedgerSha256: z.string(),
    });
    expect(olderRequest.safeParse(ordinary).success).toBe(true);
    expect(olderRequest.safeParse(hidden).success).toBe(false);
    expect(
      decideSecondInstance(primary, { ...hidden, schema: ordinary.schema }),
    ).toBeNull();
  });

  it("keeps the acknowledgement format at version 2 for background requests", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-instance-v3-"));
    roots.push(root);
    const hidden = createInstanceRequest(primary, true);
    await writeInstanceAcknowledgement(root, hidden, "reopen-failed", primary);
    const acknowledgement = await waitForInstanceAcknowledgement(root, hidden, {
      timeoutMs: 50,
      pollMs: 1,
    });
    expect(acknowledgement).toMatchObject({
      schema: "farol.next.single-instance/2",
      nonce: hidden.nonce,
      status: "reopen-failed",
    });
    expect(acknowledgement).not.toHaveProperty("backgroundOnly");
  });

  it("reports unconfirmed background admission when an older primary publishes no acknowledgement", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-instance-old-v2-"),
    );
    roots.push(root);
    const hidden = createInstanceRequest(primary, true);
    const acknowledgement = await waitForInstanceAcknowledgement(root, hidden, {
      timeoutMs: 20,
      pollMs: 1,
    });
    expect(acknowledgement).toBeNull();
    expect(secondInstanceRefusalMessage(hidden, acknowledgement)).toBe(
      "Farol Next could not confirm background-only admission with the running instance. Quit it before starting a hidden instance.",
    );
  });

  it("refuses a background-only second launch without reopening", () => {
    const candidate = createInstanceRequest(primary, true);
    expect(candidate).toHaveProperty("backgroundOnly", true);
    expect(decideSecondInstance(primary, candidate)).toEqual({
      nonce: candidate.nonce,
      status: "reopen-failed",
    });
    expect(
      decideSecondInstance(primary, {
        ...candidate,
        sourceCommit: "d".repeat(40),
      }),
    ).toEqual({
      nonce: candidate.nonce,
      status: "identity-mismatch",
    });
  });

  it("keeps ordinary reopen requests compatible and refuses malformed background intent", () => {
    const ordinary = createInstanceRequest(primary);
    expect(ordinary).not.toHaveProperty("backgroundOnly");
    expect(decideSecondInstance(primary, ordinary)?.status).toBe("reopened");
    for (const backgroundOnly of [false, "true", null, 1]) {
      expect(
        decideSecondInstance(primary, { ...ordinary, backgroundOnly }),
      ).toBeNull();
    }
    for (const backgroundOnly of [false, "true", null, 1, undefined]) {
      expect(
        decideSecondInstance(primary, {
          ...ordinary,
          schema: "farol.next.single-instance/3",
          backgroundOnly,
        }),
      ).toBeNull();
    }
  });

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
    expect(() =>
      readBuildLaunchIdentity(root, "owner-preview", dirty.runtime),
    ).toThrow("INSTANCE_BUILD_IDENTITY_INVALID");
  });

  it.each(["preview", "dev", "owner-preview"] as const)(
    "admits the Go builder's schema 4 identity for %s startup",
    async (environment) => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "farol-go-instance-"),
      );
      roots.push(root);
      const fixture = await writeBuildFixture(root, {
        dirty: false,
        inputExact: true,
      });
      const file = path.join(root, "build-manifest.json");
      const manifest = JSON.parse(await fs.readFile(file, "utf8"));
      await fs.writeFile(
        file,
        JSON.stringify({ ...manifest, schema: 4, core: goCoreDeclaration() }),
      );
      expect(
        readBuildLaunchIdentity(root, environment, fixture.runtime),
      ).toEqual({
        ...primary,
        environment,
      });
    },
  );

  it.each<[string, Record<string, unknown>]>([
    ["missing core", { schema: 4 }],
    ["invalid core", { schema: 4, core: { schema: "farol-core-artifact/1" } }],
    ["future schema", { schema: 5, core: goCoreDeclaration() }],
    ["legacy core mismatch", { schema: 3, core: goCoreDeclaration() }],
    ...["buildId", "sourceSHA", "sourceTreeDigest"].map(
      (field): [string, Record<string, unknown>] => [
        `foreign core ${field}`,
        {
          schema: 4,
          core: {
            ...goCoreDeclaration(),
            build: {
              ...goCoreDeclaration().build,
              [field]: "f".repeat(field === "sourceSHA" ? 40 : 64),
            },
          },
        },
      ],
    ),
    [
      "inexact Go input ledger",
      { schema: 4, core: goCoreDeclaration(), inputExact: false },
    ],
  ])("rejects %s before Go instance admission", async (_reason, invalid) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-go-instance-bad-"),
    );
    roots.push(root);
    const fixture = await writeBuildFixture(root, {
      dirty: false,
      inputExact: true,
    });
    const file = path.join(root, "build-manifest.json");
    const manifest = JSON.parse(await fs.readFile(file, "utf8"));
    await fs.writeFile(file, JSON.stringify({ ...manifest, ...invalid }));
    for (const environment of ["preview", "dev"] as const) {
      expect(() =>
        readBuildLaunchIdentity(root, environment, fixture.runtime),
      ).toThrow("INSTANCE_BUILD_IDENTITY_INVALID");
    }
  });

  it("keeps Go startup bound to a clean runtime and exact input ledger", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-go-instance-inputs-"),
    );
    roots.push(root);
    const file = path.join(root, "build-manifest.json");
    for (const dirty of [true, false]) {
      const fixture = await writeBuildFixture(root, {
        dirty,
        inputExact: true,
      });
      const manifest = JSON.parse(await fs.readFile(file, "utf8"));
      await fs.writeFile(
        file,
        JSON.stringify({ ...manifest, schema: 4, core: goCoreDeclaration() }),
      );
      if (!dirty)
        await fs.writeFile(path.join(root, "input-manifest.json"), "changed");
      expect(() =>
        readBuildLaunchIdentity(root, "dev", fixture.runtime),
      ).toThrow("INSTANCE_BUILD_IDENTITY_INVALID");
    }
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
    expect(() =>
      readBuildLaunchIdentity(root, "owner-preview", dirty.runtime),
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
