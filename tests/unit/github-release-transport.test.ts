import { afterEach, describe, expect, it, vi } from "vitest";
const race = vi.hoisted(() => ({
  afterMetadata: null as null | ((file: unknown) => Promise<void>),
  onRead: null as null | ((file: unknown) => Promise<"short" | void>),
  onSync: null as null | ((file: unknown) => Promise<void>),
  onClose: null as null | ((file: unknown) => Promise<void>),
  ownerUid: null as number | null,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const info = await actual.lstat(...args);
      await race.afterMetadata?.(args[0]);
      return race.ownerUid === null ||
        typeof args[0] !== "string" ||
        !args[0].endsWith(".zip")
        ? info
        : Object.assign(Object.create(Object.getPrototypeOf(info)), info, {
            uid: args[1]?.bigint ? BigInt(race.ownerUid) : race.ownerUid,
          });
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args);
      return new Proxy(file, {
        get(target, property) {
          if (property === "stat")
            return async (...options: Parameters<typeof file.stat>) => {
              const info = await target.stat(...options);
              await race.afterMetadata?.(args[0]);
              return info;
            };
          if (property === "read")
            return async (
              buffer: Buffer,
              offset: number,
              length: number,
              position: number,
            ) => {
              if ((await race.onRead?.(args[0])) === "short")
                return { bytesRead: 0, buffer };
              return target.read(buffer, offset, length, position);
            };
          if (property === "sync")
            return async () => {
              await race.onSync?.(args[0]);
              await target.sync();
            };
          if (property === "close")
            return async () => {
              await target.close();
              await race.onClose?.(args[0]);
            };
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { PackageVerificationError } from "../../src/modules/release/infra/native/update-package-verifier";
import { tmpdir } from "node:os";
import {
  createGithubUpdateTransport,
  type HttpsResponse,
  type OpenHttps,
} from "../../src/modules/release/infra/native/github-update-transport";
import {
  GITHUB_RELEASES_API,
  type ReleaseManifest,
} from "../../src/modules/release/domain/github-release-contract";

// All responses are scripted in memory. No test makes a GitHub or other network request.
const asset =
  "https://github.com/legrch/farol/releases/download/v0.1.1/Farol-0.1.1-darwin-arm64.zip";
const manifestAsset =
  "https://github.com/legrch/farol/releases/download/v0.1.1/farol-release.json";
const cdn =
  "https://release-assets.githubusercontent.com/opaque?signature=fixture";
const manifest = {
  schema: "farol.github-release/1",
  version: "0.1.1",
} as ReleaseManifest;
const roots: string[] = [];
const archiveManifest = (bytes: Buffer): ReleaseManifest => ({
  ...manifest,
  archiveSize: bytes.length,
  archiveSha256: createHash("sha256").update(bytes).digest("hex"),
});

async function privateRoot(): Promise<string> {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "farol-github-transport-")),
  );
  roots.push(root);
  return root;
}
async function expectEmptySlot(directory: string): Promise<void> {
  const names = await readdir(directory);
  expect(names).toHaveLength(1);
  expect((await lstat(path.join(directory, names[0]!))).size).toBe(0);
}

afterEach(async () => {
  race.afterMetadata = null;
  race.onRead = null;
  race.onSync = null;
  race.onClose = null;
  race.ownerUid = null;
  for (const root of roots.splice(0)) {
    await chmod(root, 0o700).catch(() => undefined);
    await chmod(path.join(root, "github-updates"), 0o700).catch(
      () => undefined,
    );
    await rm(root, { recursive: true, force: true });
  }
});

function response(
  statusCode: number,
  chunks: readonly Uint8Array[] = [],
  headers: Record<string, string> = {},
  complete = true,
): HttpsResponse {
  return {
    statusCode,
    headers,
    body: {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk;
      },
    },
    complete: () => complete,
    destroy: vi.fn(),
  };
}

function scripted(...replies: HttpsResponse[]): OpenHttps {
  const next = [...replies];
  return vi.fn(async () => {
    const reply = next.shift();
    if (!reply) throw new Error("unexpected network request");
    return reply;
  });
}

function transport(root: string, openHttps: OpenHttps) {
  const verifyPackage = vi.fn(async () => ({
    identity: {
      product: "Farol Next Preview",
      bundleId: "local.farol.next.preview",
      version: "0.1.1",
      buildVersion: "2",
      updateChannel: "github-stable",
      buildId: "a".repeat(64),
      sourceCommit: "b".repeat(40),
      sourceTreeDigest: "c".repeat(64),
      artifactSha256: "d".repeat(64),
      signing: "unsigned",
      notarized: false,
    },
    stagedAppPath: "/fixture/stage/Farol Next Preview.app",
    stagingRoot: "/fixture/stage",
  }));
  return {
    instance: createGithubUpdateTransport({
      privateStateDirectory: root,
      openHttps,
      verifyPackage,
    }),
    verifyPackage,
  };
}

describe("GitHub release feed URL policy (pure scripted responses)", () => {
  it("reads only the new catalogue and its pinned manifest redirect", async () => {
    const openHttps = scripted(
      response(200, [Buffer.from("[]")]),
      response(302, [], { location: cdn }),
      response(200, [Buffer.from('{"repository":"legrch/farol"}')]),
    );
    const { instance } = transport("/unused-source-fixture", openHttps);
    expect(await instance.fetchJson(GITHUB_RELEASES_API, 1024)).toMatchObject({
      ok: true,
      value: { value: [], finalUrl: GITHUB_RELEASES_API, redirects: [] },
    });
    expect(await instance.fetchJson(manifestAsset, 1024)).toMatchObject({
      ok: true,
      value: {
        value: { repository: "legrch/farol" },
        finalUrl: cdn,
        redirects: [manifestAsset, cdn],
      },
    });
    expect(vi.mocked(openHttps).mock.calls.map(([url]) => url)).toEqual([
      "https://api.github.com/repos/legrch/farol/releases?per_page=100",
      manifestAsset,
      cdn,
    ]);
  });

  it.each([
    "https://api.github.com/repos/legrch/farol-releases/releases?per_page=100",
    "https://api.github.com/repos/legrch/farol/releases/latest",
    "https://api.github.com/repos/other/farol/releases?per_page=100",
    "https://github.com/legrch/farol-releases/releases/download/v0.1.1/farol-release.json",
    "https://github.com/legrch/farol-releases/releases/download/v0.1.1/Farol-0.1.1-darwin-arm64.zip",
    "https://github.com/other/farol/releases/download/v0.1.1/file.zip",
    "https://github.com/legrch/other/releases/download/v0.1.1/file.zip",
    "https://github.com/legrch/farol/releases/download/v0.1.1/file.zip?override=old",
  ])("refuses retired and foreign URLs before any IO (%s)", async (url) => {
    const openHttps = scripted();
    const { instance } = transport("/unused-source-fixture", openHttps);
    expect(await instance.fetchJson(url, 1024)).toMatchObject({
      ok: false,
      reason: "invalid_url",
    });
    expect(await instance.download(url, 1024)).toMatchObject({
      ok: false,
      reason: "invalid_url",
    });
    expect(openHttps).not.toHaveBeenCalled();
  });

  it("refuses a new-feed redirect back to the old asset repository", async () => {
    const openHttps = scripted(
      response(302, [], {
        location: manifestAsset.replace("/farol/", "/farol-releases/"),
      }),
    );
    const { instance } = transport("/unused-source-fixture", openHttps);
    expect(await instance.fetchJson(manifestAsset, 1024)).toMatchObject({
      ok: false,
      reason: "redirect",
    });
    expect(openHttps).toHaveBeenCalledTimes(1);
  });
});

describe("GitHub HTTPS transport", () => {
  it.each(["opening", "streaming", "uncertain-cleanup"] as const)(
    "cancels the owned %s request and confirms partial-byte cleanup before returning",
    async (phase) => {
      const root = await privateRoot();
      let reached!: () => void;
      const started = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let release!: () => void;
      let seenSignal: AbortSignal | undefined;
      const network: OpenHttps = vi.fn(
        async (_url, _headers, _timeout, signal) => {
          seenSignal = signal;
          const stopped = new Promise<never>((_resolve, reject) => {
            release = () => reject(new Error("fixture cancelled"));
            signal?.addEventListener("abort", release, { once: true });
          });
          if (phase === "opening") {
            reached();
            return stopped;
          }
          return {
            ...response(200),
            body: {
              async *[Symbol.asyncIterator]() {
                yield Buffer.from("partial");
                reached();
                await stopped;
              },
            },
            complete: () => false,
          };
        },
      );
      if (phase === "uncertain-cleanup")
        race.onClose = async () => {
          throw new Error("fixture close unknown");
        };
      const { instance } = transport(root, network);
      const downloading = instance.download(asset, 100);
      await started;
      instance.cancelPending?.();
      const cancelledByTransport = seenSignal?.aborted === true;
      // Also settle the scripted response on RED; this test never leaves an open file.
      release();
      const result = await downloading;
      expect(cancelledByTransport).toBe(true);
      expect(result).toMatchObject({
        ok: false,
        certainty: phase === "uncertain-cleanup" ? "unknown" : "known",
      });
      if (phase !== "opening")
        await expectEmptySlot(path.join(root, "github-updates"));
      expect(await instance.fetchJson(GITHUB_RELEASES_API, 100)).toMatchObject({
        ok: false,
      });
      expect(network).toHaveBeenCalledTimes(1);
    },
  );

  it("reclaims matching retained bytes in a cold transport and reuses the empty slot", async () => {
    const root = await privateRoot();
    const bytes = Buffer.from("retained archive");
    const first = await transport(
      root,
      scripted(response(200, [bytes])),
    ).instance.download(asset, bytes.length);
    if (!first.ok) throw new Error("fixture download failed");
    const network = scripted(response(200, [Buffer.from("NEW")]));
    const cold = transport(root, network);
    expect(
      await cold.instance.reclaimRetained(
        first.value.handle,
        archiveManifest(bytes),
      ),
    ).toMatchObject({
      ok: true,
    });
    expect(network).not.toHaveBeenCalled();
    await expectEmptySlot(path.dirname(first.value.handle));
    expect(cold.verifyPackage).not.toHaveBeenCalled();
    expect(await cold.instance.download(asset, 3)).toMatchObject({
      ok: true,
      value: { handle: first.value.handle },
    });
  });

  it("rejects absent, malformed, wrong hash, wrong size and oversized manifests without mutation", async () => {
    const root = await privateRoot();
    const bytes = Buffer.from("retained archive");
    const first = await transport(
      root,
      scripted(response(200, [bytes])),
    ).instance.download(asset, bytes.length);
    if (!first.ok) throw new Error("fixture download failed");
    const cold = transport(root, scripted()).instance;
    const good = archiveManifest(bytes);
    const stage = path.dirname(first.value.handle);
    expect(
      await cold.reclaimRetained(
        path.join(stage, "00000000-0000-0000-0000-000000000000.zip"),
        good,
      ),
    ).toMatchObject({ ok: false, certainty: "known" });
    expect(
      await cold.reclaimRetained(path.join(stage, "not-a-uuid.zip"), good),
    ).toMatchObject({ ok: false, certainty: "known" });
    expect(
      await cold.reclaimRetained(first.value.handle, {
        ...good,
        archiveSha256: "0".repeat(64),
      }),
    ).toMatchObject({ ok: false, certainty: "known" });
    expect(
      await cold.reclaimRetained(first.value.handle, {
        ...good,
        archiveSize: bytes.length - 1,
      }),
    ).toMatchObject({ ok: false, certainty: "known" });
    expect(
      await cold.reclaimRetained(first.value.handle, {
        ...good,
        archiveSize: 2_147_483_649,
      }),
    ).toMatchObject({ ok: false, certainty: "known" });
    expect(await readFile(first.value.handle)).toEqual(bytes);
  });

  it("rejects special, unowned, public and aliased retained handles", async () => {
    const root = await privateRoot();
    const bytes = Buffer.from("retained archive");
    const first = await transport(
      root,
      scripted(response(200, [bytes])),
    ).instance.download(asset, bytes.length);
    if (!first.ok) throw new Error("fixture download failed");
    const good = archiveManifest(bytes);
    const cold = transport(root, scripted()).instance;
    const outside = path.join(root, "outside.zip");
    await writeFile(outside, bytes, { mode: 0o600 });
    await rename(first.value.handle, first.value.handle + ".saved");
    await symlink(outside, first.value.handle);
    expect(await cold.reclaimRetained(first.value.handle, good)).toMatchObject({
      ok: false,
    });
    await unlink(first.value.handle);
    await mkdir(first.value.handle);
    expect(await cold.reclaimRetained(first.value.handle, good)).toMatchObject({
      ok: false,
    });
    await rm(first.value.handle, { recursive: true });
    await link(first.value.handle + ".saved", first.value.handle);
    expect(await cold.reclaimRetained(first.value.handle, good)).toMatchObject({
      ok: false,
    });
    await unlink(first.value.handle + ".saved");
    await chmod(first.value.handle, 0o644);
    expect(await cold.reclaimRetained(first.value.handle, good)).toMatchObject({
      ok: false,
    });
    await chmod(first.value.handle, 0o600);
    race.ownerUid = process.getuid!() + 1;
    expect(await cold.reclaimRetained(first.value.handle, good)).toMatchObject({
      ok: false,
    });
    race.ownerUid = null;
    expect(await readFile(first.value.handle)).toEqual(bytes);
  });

  it("treats an already empty owned handle as completed reclamation without writing", async () => {
    const root = await privateRoot();
    const bytes = Buffer.from("retained archive");
    const firstTransport = transport(
      root,
      scripted(response(200, [bytes])),
    ).instance;
    const first = await firstTransport.download(asset, bytes.length);
    if (!first.ok) throw new Error("fixture download failed");
    expect(await firstTransport.discard(first.value.handle)).toMatchObject({
      ok: true,
    });
    const cold = transport(root, scripted()).instance;
    race.onRead = async () => {
      throw new Error("unexpected read");
    };
    race.onSync = async () => {
      throw new Error("unexpected sync");
    };
    expect(
      await cold.reclaimRetained(first.value.handle, archiveManifest(bytes)),
    ).toMatchObject({ ok: true });
    await expectEmptySlot(path.dirname(first.value.handle));
  });

  it("preserves a replacement installed between metadata check and open", async () => {
    const root = await privateRoot();
    const bytes = Buffer.from("retained archive");
    const first = await transport(
      root,
      scripted(response(200, [bytes])),
    ).instance.download(asset, bytes.length);
    if (!first.ok) throw new Error("fixture download failed");
    race.afterMetadata = async (file) => {
      if (file !== first.value.handle) return;
      race.afterMetadata = null;
      await rename(first.value.handle, first.value.handle + ".original");
      await writeFile(first.value.handle, bytes, { mode: 0o600 });
    };
    expect(
      await transport(root, scripted()).instance.reclaimRetained(
        first.value.handle,
        archiveManifest(bytes),
      ),
    ).toMatchObject({ ok: false, certainty: "unknown" });
    expect(await readFile(first.value.handle)).toEqual(bytes);
    expect(await readFile(first.value.handle + ".original")).toEqual(bytes);
  });

  it("reports unknown for a short read or a replacement during bounded reading", async () => {
    const root = await privateRoot();
    const bytes = Buffer.from("retained archive");
    const first = await transport(
      root,
      scripted(response(200, [bytes])),
    ).instance.download(asset, bytes.length);
    if (!first.ok) throw new Error("fixture download failed");
    const cold = transport(root, scripted()).instance;
    race.onRead = async () => "short";
    expect(
      await cold.reclaimRetained(first.value.handle, archiveManifest(bytes)),
    ).toMatchObject({ ok: false, certainty: "unknown" });
    race.onRead = async (file) => {
      if (file !== first.value.handle) return;
      race.onRead = null;
      await rename(first.value.handle, first.value.handle + ".original");
      await writeFile(first.value.handle, bytes, { mode: 0o600 });
    };
    expect(
      await cold.reclaimRetained(first.value.handle, archiveManifest(bytes)),
    ).toMatchObject({ ok: false, certainty: "unknown" });
    expect(await readFile(first.value.handle)).toEqual(bytes);
    expect(await readFile(first.value.handle + ".original")).toEqual(bytes);
  });

  it("never reports successful reclamation after sync or close fails", async () => {
    for (const failing of ["sync", "close"] as const) {
      const root = await privateRoot();
      const bytes = Buffer.from("retained archive");
      const first = await transport(
        root,
        scripted(response(200, [bytes])),
      ).instance.download(asset, bytes.length);
      if (!first.ok) throw new Error("fixture download failed");
      const cold = transport(root, scripted()).instance;
      const fault = async (file: unknown) => {
        if (file === first.value.handle) throw new Error("injected failure");
      };
      if (failing === "sync") race.onSync = fault;
      else race.onClose = fault;
      expect(
        await cold.reclaimRetained(first.value.handle, archiveManifest(bytes)),
      ).toMatchObject({ ok: false, certainty: "unknown" });
      race.onSync = null;
      race.onClose = null;
      await expectEmptySlot(path.dirname(first.value.handle));
    }
  });

  it("never deletes a replacement installed after the cleanup metadata check", async () => {
    const root = await privateRoot();
    const { instance } = transport(
      root,
      scripted(response(200, [Buffer.from("ZIP")])),
    );
    const result = await instance.download(asset, 3);
    if (!result.ok) throw new Error("fixture download failed");
    race.afterMetadata = async (file) => {
      if (file !== result.value.handle) return;
      race.afterMetadata = null;
      await rename(result.value.handle, result.value.handle + ".original");
      await writeFile(result.value.handle, "replacement", { mode: 0o600 });
    };
    expect(await instance.discard(result.value.handle)).toMatchObject({
      ok: false,
      certainty: "unknown",
    });
    expect(await readFile(result.value.handle, "utf8")).toBe("replacement");
  });
  it("discards only an unchanged archive issued by this transport", async () => {
    const root = await privateRoot();
    const { instance } = transport(
      root,
      scripted(
        response(200, [Buffer.from("ZIP")]),
        response(200, [Buffer.from("NEW")]),
      ),
    );
    const result = await instance.download(asset, 3);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const foreign = path.join(root, "outside.zip");
    await writeFile(foreign, "keep");
    expect(await instance.discard(foreign)).toMatchObject({
      ok: false,
      reason: "invalid_handle",
    });
    expect(await readFile(foreign, "utf8")).toBe("keep");
    expect(await instance.discard(result.value.handle)).toMatchObject({
      ok: true,
    });
    await expectEmptySlot(path.dirname(result.value.handle));
    const again = await instance.download(asset, 3);
    expect(again).toMatchObject({
      ok: true,
      value: { handle: result.value.handle },
    });
    expect(await readFile(result.value.handle, "utf8")).toBe("NEW");
    expect(await instance.discard(result.value.handle)).toMatchObject({
      ok: true,
    });
    await expectEmptySlot(path.dirname(result.value.handle));
  });
  it("preserves a replaced archive and reports unknown cleanup", async () => {
    const root = await privateRoot();
    const { instance } = transport(
      root,
      scripted(response(200, [Buffer.from("ZIP")])),
    );
    const result = await instance.download(asset, 3);
    if (!result.ok) throw new Error("fixture download failed");
    await unlink(result.value.handle);
    await writeFile(result.value.handle, "replacement", { mode: 0o600 });
    expect(await instance.discard(result.value.handle)).toMatchObject({
      ok: false,
      reason: "stage_cleanup",
      certainty: "unknown",
    });
    expect(await readFile(result.value.handle, "utf8")).toBe("replacement");
  });
  it("does not downgrade a failed extraction cleanup to a retryable mismatch", async () => {
    const root = await privateRoot();
    const { instance, verifyPackage } = transport(
      root,
      scripted(response(200, [Buffer.from("ZIP")])),
    );
    const result = await instance.download(asset, 3);
    if (!result.ok) throw new Error("fixture download failed");
    verifyPackage.mockRejectedValue(
      new PackageVerificationError("cleanup_unknown"),
    );
    expect(
      await instance.verifyPackage(result.value.handle, manifest),
    ).toMatchObject({
      ok: false,
      certainty: "unknown",
      reason: "stage_cleanup",
    });
    expect(await readFile(result.value.handle, "utf8")).toBe("ZIP");
  });
  it("reports retained verification capacity without claiming a bad archive", async () => {
    const root = await privateRoot();
    const { instance, verifyPackage } = transport(
      root,
      scripted(response(200, [Buffer.from("ZIP")])),
    );
    const result = await instance.download(asset, 3);
    if (!result.ok) throw new Error("fixture download failed");
    verifyPackage.mockRejectedValue(
      new PackageVerificationError("stage_capacity"),
    );
    expect(await instance.verifyPackage(result.value.handle, manifest)).toEqual(
      {
        ok: false,
        kind: "interrupted",
        reason: "stage_capacity",
        certainty: "known",
      },
    );
    expect(await readFile(result.value.handle, "utf8")).toBe("ZIP");
    expect(verifyPackage).toHaveBeenCalledTimes(1);
  });
  it("fetches bounded pinned API JSON without credentials", async () => {
    const root = await privateRoot();
    const openHttps = scripted(
      response(200, [Buffer.from('[{"tag_name":"v0.1.1"}]')]),
    );
    const { instance } = transport(root, openHttps);
    expect(await instance.fetchJson(GITHUB_RELEASES_API, 1024)).toMatchObject({
      ok: true,
      value: {
        value: [{ tag_name: "v0.1.1" }],
        finalUrl: GITHUB_RELEASES_API,
        redirects: [],
      },
    });
    expect(openHttps).toHaveBeenCalledTimes(1);
    const [url, headers, timeout] = vi.mocked(openHttps).mock.calls[0]!;
    expect(url).toBe(GITHUB_RELEASES_API);
    expect(timeout).toBe(30_000);
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain(
      "authorization",
    );
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain(
      "cookie",
    );
  });

  it("accepts one pinned asset-to-CDN redirect and rejects API, foreign or repeated redirects", async () => {
    const root = await privateRoot();
    const good = transport(
      root,
      scripted(
        response(302, [], { location: cdn }),
        response(200, [Buffer.from("{}")]),
      ),
    ).instance;
    expect(await good.fetchJson(manifestAsset, 1024)).toMatchObject({
      ok: true,
      value: { value: {}, finalUrl: cdn, redirects: [manifestAsset, cdn] },
    });
    const apiRedirect = transport(
      root,
      scripted(response(302, [], { location: cdn })),
    ).instance;
    expect(
      await apiRedirect.fetchJson(GITHUB_RELEASES_API, 1024),
    ).toMatchObject({
      ok: false,
      reason: "redirect",
      certainty: "known",
    });
    const foreign = transport(
      root,
      scripted(response(302, [], { location: "https://evil.example/asset" })),
    ).instance;
    expect(await foreign.download(asset, 1024)).toMatchObject({
      ok: false,
      reason: "redirect",
    });
    const repeated = transport(
      root,
      scripted(
        response(302, [], { location: cdn }),
        response(302, [], { location: cdn }),
      ),
    ).instance;
    expect(await repeated.download(asset, 1024)).toMatchObject({
      ok: false,
      reason: "redirect",
    });
  });

  it("stages and hashes the measured archive in a private nofollow file", async () => {
    const root = await privateRoot();
    const bytes = Buffer.from("fixture ZIP bytes");
    const { instance, verifyPackage } = transport(
      root,
      scripted(
        response(302, [], { location: cdn }),
        response(200, [bytes.subarray(0, 4), bytes.subarray(4)], {
          "content-length": String(bytes.length),
        }),
      ),
    );
    const result = await instance.download(asset, bytes.length);
    expect(result).toMatchObject({
      ok: true,
      value: {
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        finalUrl: cdn,
        redirects: [asset, cdn],
      },
    });
    if (!result.ok) return;
    expect(path.dirname(result.value.handle)).toBe(
      path.join(root, "github-updates"),
    );
    expect(await readFile(result.value.handle)).toEqual(bytes);
    expect((await lstat(result.value.handle)).mode & 0o077).toBe(0);
    expect((await lstat(path.dirname(result.value.handle))).mode & 0o077).toBe(
      0,
    );
    expect(
      await instance.verifyPackage(result.value.handle, manifest),
    ).toMatchObject({
      ok: true,
    });
    expect(verifyPackage).toHaveBeenCalledWith(result.value.handle, manifest);
    const recoveryClient = scripted();
    const recovered = transport(root, recoveryClient);
    expect(
      await recovered.instance.verifyPackage(result.value.handle, manifest),
    ).toMatchObject({
      ok: true,
      value: {
        stagedAppPath: "/fixture/stage/Farol Next Preview.app",
        stagingRoot: "/fixture/stage",
      },
    });
    expect(recovered.verifyPackage).toHaveBeenCalledWith(
      result.value.handle,
      manifest,
    );
    expect(recoveryClient).not.toHaveBeenCalled();
  });

  it("rejects foreign inputs without opening a socket", async () => {
    const root = await privateRoot();
    const openHttps = scripted();
    const { instance } = transport(root, openHttps);
    expect(
      await instance.fetchJson(
        "https://api.github.com/repos/other/repo/releases",
        100,
      ),
    ).toMatchObject({ ok: false, reason: "invalid_url" });
    expect(
      await instance.download(
        "http://github.com/legrch/farol/releases/download/v1/file.zip",
        100,
      ),
    ).toMatchObject({ ok: false, reason: "invalid_url" });
    expect(openHttps).not.toHaveBeenCalled();
  });

  it("bounds content length and measured streaming bytes, removing partial stages", async () => {
    const root = await privateRoot();
    const announced = transport(
      root,
      scripted(response(200, [], { "content-length": "999" })),
    ).instance;
    expect(await announced.download(asset, 4)).toMatchObject({
      ok: false,
      kind: "oversize",
      reason: "limit",
    });
    const streamed = transport(
      root,
      scripted(response(200, [Buffer.from("ab"), Buffer.from("cde")])),
    ).instance;
    expect(await streamed.download(asset, 4)).toMatchObject({
      ok: false,
      kind: "oversize",
      reason: "limit",
    });
    await expectEmptySlot(path.join(root, "github-updates"));
    const json = transport(
      root,
      scripted(response(200, [Buffer.from("12345")])),
    ).instance;
    expect(await json.fetchJson(GITHUB_RELEASES_API, 4)).toMatchObject({
      ok: false,
      kind: "oversize",
    });
  });

  it("classifies incomplete streams and transport failures without retry", async () => {
    const root = await privateRoot();
    const incomplete = transport(
      root,
      scripted(response(200, [Buffer.from("partial")], {}, false)),
    ).instance;
    expect(await incomplete.download(asset, 100)).toMatchObject({
      ok: false,
      kind: "interrupted",
      certainty: "known",
    });
    await expectEmptySlot(path.join(root, "github-updates"));
    const openHttps = vi.fn(async () => {
      throw new Error("offline");
    });
    const failed = transport(root, openHttps).instance;
    expect(await failed.fetchJson(GITHUB_RELEASES_API, 100)).toMatchObject({
      ok: false,
      kind: "network_failure",
      certainty: "known",
    });
    expect(openHttps).toHaveBeenCalledTimes(1);
    const rateLimited = transport(root, scripted(response(429))).instance;
    expect(await rateLimited.fetchJson(GITHUB_RELEASES_API, 100)).toMatchObject(
      { ok: false, reason: "http_status" },
    );
  });

  it("rejects a completed response whose declared length differs from measured bytes", async () => {
    const root = await privateRoot();
    const json = transport(
      root,
      scripted(response(200, [Buffer.from("{}")], { "content-length": "3" })),
    ).instance;
    expect(await json.fetchJson(GITHUB_RELEASES_API, 100)).toMatchObject({
      ok: false,
      kind: "interrupted",
      reason: "content_length",
    });
    const archive = transport(
      root,
      scripted(response(200, [Buffer.from("ab")], { "content-length": "3" })),
    ).instance;
    expect(await archive.download(asset, 100)).toMatchObject({
      ok: false,
      kind: "interrupted",
      reason: "content_length",
    });
    await expectEmptySlot(path.join(root, "github-updates"));
  });

  it("reports unknown when the staged path changes before readback", async () => {
    const root = await privateRoot();
    const stage = path.join(root, "github-updates");
    const outside = path.join(root, "outside.zip");
    await writeFile(outside, "foreign", { mode: 0o600 });
    const altered: HttpsResponse = {
      ...response(200),
      body: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from("archive");
          const [name] = await readdir(stage);
          if (!name) throw new Error("missing stage");
          const handle = path.join(stage, name);
          await unlink(handle);
          await symlink(outside, handle);
        },
      },
    };
    const instance = transport(root, scripted(altered)).instance;
    expect(await instance.download(asset, 100)).toMatchObject({
      ok: false,
      certainty: "unknown",
      reason: "private_state",
    });
    expect(await readdir(stage)).toHaveLength(1);
    expect(await readFile(outside, "utf8")).toBe("foreign");
  });

  it("rejects symlink state and forged or symlink staged handles", async () => {
    const root = await privateRoot();
    const link = path.join(root, "linked-state");
    await symlink(root, link);
    const blocked = transport(
      link,
      scripted(response(200, [Buffer.from("abc")])),
    ).instance;
    expect(await blocked.download(asset, 100)).toMatchObject({
      ok: false,
      reason: "private_state",
    });
    const { instance, verifyPackage } = transport(root, scripted());
    expect(
      await instance.verifyPackage(path.join(root, "outside.zip"), manifest),
    ).toMatchObject({ ok: false, reason: "invalid_handle" });
    const stage = path.join(root, "github-updates");
    const fake = path.join(stage, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.zip");
    await writeFile(path.join(root, "outside.zip"), "other", { mode: 0o600 });
    await symlink(path.join(root, "outside.zip"), fake);
    expect(await instance.verifyPackage(fake, manifest)).toMatchObject({
      ok: false,
      reason: "invalid_handle",
    });
    expect(verifyPackage).not.toHaveBeenCalled();
  });
});
