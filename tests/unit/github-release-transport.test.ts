import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  createGithubUpdateTransport,
  type HttpsResponse,
  type OpenHttps,
} from "../../src/modules/release/infra/native/github-update-transport";
import { GITHUB_RELEASES_API } from "../../src/modules/release/domain/github-release-contract";

// All responses are scripted in memory. No test makes a GitHub or other network request.
const asset =
  "https://github.com/legrch/farol-releases/releases/download/v0.1.1/Farol-0.1.1-darwin-arm64.zip";
const manifestAsset =
  "https://github.com/legrch/farol-releases/releases/download/v0.1.1/farol-release.json";
const cdn =
  "https://release-assets.githubusercontent.com/opaque?signature=fixture";
const roots: string[] = [];

async function privateRoot(): Promise<string> {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "farol-github-transport-")),
  );
  roots.push(root);
  return root;
}

afterEach(async () => {
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
    ok: true as const,
    value: {
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

describe("GitHub HTTPS transport", () => {
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
    expect(await instance.verifyPackage(result.value.handle)).toMatchObject({
      ok: true,
    });
    expect(verifyPackage).toHaveBeenCalledWith(result.value.handle);
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
        "http://github.com/legrch/farol-releases/releases/download/v1/file.zip",
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
    expect(await readdir(path.join(root, "github-updates"))).toEqual([]);
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
    expect(await readdir(path.join(root, "github-updates"))).toEqual([]);
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
    expect(await readdir(path.join(root, "github-updates"))).toEqual([]);
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
    expect(await readdir(stage)).toEqual([]);
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
      await instance.verifyPackage(path.join(root, "outside.zip")),
    ).toMatchObject({ ok: false, reason: "invalid_handle" });
    const stage = path.join(root, "github-updates");
    const fake = path.join(stage, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.zip");
    await writeFile(path.join(root, "outside.zip"), "other", { mode: 0o600 });
    await symlink(path.join(root, "outside.zip"), fake);
    expect(await instance.verifyPackage(fake)).toMatchObject({
      ok: false,
      reason: "invalid_handle",
    });
    expect(verifyPackage).not.toHaveBeenCalled();
  });
});
