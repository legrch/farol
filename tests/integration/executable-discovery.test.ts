import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  discoverExecutables,
  REVIEWED_TUNNEL_CLIENT_DIGESTS,
  type CodesignInspection,
  type DiscoveryCodesign,
  type DiscoveryFs,
  type DiscoveryHash,
  type DiscoveryLstatResult,
  type HashOutcome,
  type ReviewedTunnelClientDigests,
} from "../../src/apps/desktop/executable-discovery";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CODEX_CHATGPT_APP = "/Applications/ChatGPT.app/Contents/Resources/codex";
const CODEX_CODEX_APP = "/Applications/Codex.app/Contents/Resources/codex";
const CODEX_HOMEBREW_ARM = "/opt/homebrew/bin/codex";
const CODEX_HOMEBREW_INTEL = "/usr/local/bin/codex";

const TUNNEL_HOMEBREW_ARM_BIN = "/opt/homebrew/bin/tunnel-client";
const TUNNEL_HOMEBREW_ARM_LIBEXEC =
  "/opt/homebrew/opt/tunnel-client/libexec/tunnel-client";
const TUNNEL_HOMEBREW_INTEL_BIN = "/usr/local/bin/tunnel-client";
const TUNNEL_HOMEBREW_INTEL_LIBEXEC =
  "/usr/local/opt/tunnel-client/libexec/tunnel-client";

function nvmVersionsRoot(home: string): string {
  return path.join(home, ".nvm", "versions", "node");
}

function reviewedBuildPath(home: string, sha256: string): string {
  return path.join(
    home,
    ".local",
    "libexec",
    "agent-commons",
    "secure-mcp-tunnel",
    "builds",
    sha256,
    "tunnel-client",
  );
}

type Route =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "real"; target: string }>
  | Readonly<{ kind: "loop" }>
  | Readonly<{ kind: "dir"; entries: readonly string[] }>;

function enoent(): Error {
  return Object.assign(new Error("ENOENT"), { code: "ENOENT" });
}

function eloop(): Error {
  return Object.assign(new Error("ELOOP"), { code: "ELOOP" });
}

/**
 * A fully in-memory, access-recording fake of the injectable `DiscoveryFs`
 * port. It never touches the real filesystem for a routed path, so a test
 * can assert exactly which paths discovery attempted (`touched`) and prove
 * no recursive or unbounded scan happened — a fixed candidate list plus at
 * most one-level directory listings, per the discovery contract.
 */
function buildFakeFs(routes: Readonly<Record<string, Route>>): {
  fs: DiscoveryFs;
  touched: string[];
} {
  const touched: string[] = [];
  const fs: DiscoveryFs = {
    async lstat(targetPath): Promise<DiscoveryLstatResult> {
      touched.push(targetPath);
      const route = routes[targetPath];
      if (!route || route.kind === "missing") throw enoent();
      if (route.kind === "dir") {
        return {
          isFile: () => false,
          isSymbolicLink: () => false,
          isDirectory: () => true,
        };
      }
      // "real" and "loop" both present as a symlink to lstat.
      return {
        isFile: () => false,
        isSymbolicLink: () => true,
        isDirectory: () => false,
      };
    },
    async realpath(targetPath): Promise<string> {
      touched.push(targetPath);
      const route = routes[targetPath];
      if (!route || route.kind === "missing") throw enoent();
      if (route.kind === "loop") throw eloop();
      if (route.kind === "real") return route.target;
      throw new Error("not a resolvable file route");
    },
    async readdir(targetPath): Promise<readonly string[]> {
      touched.push(targetPath);
      const route = routes[targetPath];
      if (!route || route.kind !== "dir") throw enoent();
      return route.entries;
    },
  };
  return { fs, touched };
}

function fakeCodesign(
  byCanonicalPath: Readonly<Record<string, CodesignInspection>>,
): DiscoveryCodesign {
  return {
    async verifyAndInspect(executablePath) {
      const inspection = byCanonicalPath[executablePath];
      if (!inspection)
        throw new Error(`no codesign fixture for ${executablePath}`);
      return inspection;
    },
  };
}

function fakeHash(
  byCanonicalPath: Readonly<Record<string, HashOutcome>>,
): DiscoveryHash {
  return async (canonicalPath) => {
    const outcome = byCanonicalPath[canonicalPath];
    if (!outcome) throw new Error(`no hash fixture for ${canonicalPath}`);
    return outcome;
  };
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

/** A small real file on disk, so the *default* hash implementation runs end to end. */
async function realFileFixture(
  bytes = "#!/bin/sh\nexit 0\n",
): Promise<{ target: string; sha256: string; size: number }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-discovery-"));
  roots.push(root);
  const target = path.join(root, "payload");
  await fs.writeFile(target, bytes, { mode: 0o755 });
  const stat = await fs.stat(target);
  return {
    target,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: stat.size,
  };
}

describe("executable discovery — nothing installed", () => {
  it("returns no candidates for tunnel-client and reports every fixed path searched", async () => {
    const home = "/fake-home-empty";
    const { fs: fakeFsPort } = buildFakeFs({});

    const result = await discoverExecutables("tunnel-client", {
      fs: fakeFsPort,
      home,
      arch: "arm64",
    });

    expect(result.candidates).toEqual([]);
    expect(result.searched).toEqual([
      TUNNEL_HOMEBREW_ARM_BIN,
      TUNNEL_HOMEBREW_ARM_LIBEXEC,
      TUNNEL_HOMEBREW_INTEL_BIN,
      TUNNEL_HOMEBREW_INTEL_LIBEXEC,
      reviewedBuildPath(home, REVIEWED_TUNNEL_CLIENT_DIGESTS.arm64.sha256),
    ]);
  });

  it("returns no candidates for codex and reports the fixed paths and the nvm listing root", async () => {
    const home = "/fake-home-empty";
    const { fs: fakeFsPort } = buildFakeFs({});

    const result = await discoverExecutables("codex", {
      fs: fakeFsPort,
      home,
      arch: "arm64",
    });

    expect(result.candidates).toEqual([]);
    expect(result.searched).toEqual([
      nvmVersionsRoot(home),
      CODEX_CHATGPT_APP,
      CODEX_CODEX_APP,
      CODEX_HOMEBREW_ARM,
      CODEX_HOMEBREW_INTEL,
    ]);
  });
});

describe("executable discovery — tunnel-client trust", () => {
  it("offers a candidate whose digest matches the reviewed build for this architecture", async () => {
    const fixture = await realFileFixture();
    const home = "/fake-home-reviewed";
    const reviewedDigests: ReviewedTunnelClientDigests = {
      arm64: { sha256: fixture.sha256, bytes: fixture.size },
      x86_64: REVIEWED_TUNNEL_CLIENT_DIGESTS.x86_64,
    };
    const { fs: fakeFsPort } = buildFakeFs({
      [TUNNEL_HOMEBREW_ARM_BIN]: { kind: "real", target: fixture.target },
    });

    const result = await discoverExecutables("tunnel-client", {
      fs: fakeFsPort,
      home,
      arch: "arm64",
      reviewedTunnelClientDigests: reviewedDigests,
    });

    expect(result.candidates).toEqual([
      {
        requestedPath: TUNNEL_HOMEBREW_ARM_BIN,
        path: fixture.target,
        source: "homebrew",
        bytes: fixture.size,
        sha256: fixture.sha256,
        origin: "reviewed-digest",
        verdict: "offer",
      },
    ]);
  });

  it("never executes a candidate and marks a digest mismatch as needs-owner-choice", async () => {
    const fixture = await realFileFixture("#!/bin/sh\necho not-reviewed\n");
    const home = "/fake-home-mismatch";
    const codesignSpy = fakeCodesign({}); // throws if ever called — tunnel-client never inspects signatures
    const { fs: fakeFsPort } = buildFakeFs({
      [TUNNEL_HOMEBREW_ARM_BIN]: { kind: "real", target: fixture.target },
    });

    const result = await discoverExecutables("tunnel-client", {
      fs: fakeFsPort,
      home,
      arch: "arm64",
      codesign: codesignSpy,
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.verdict).toBe("needs-owner-choice");
    expect(result.candidates[0]?.origin).toBe("unknown");
    expect(result.candidates[0]?.sha256).toBe(fixture.sha256);
  });
});

describe("executable discovery — unsafe files are refused, never hashed further or executed", () => {
  it("refuses a directory in place of a file", async () => {
    const { fs: fakeFsPort } = buildFakeFs({
      [TUNNEL_HOMEBREW_ARM_BIN]: { kind: "dir", entries: [] },
    });

    const result = await discoverExecutables("tunnel-client", {
      fs: fakeFsPort,
      home: "/fake-home-refuse-1",
      arch: "arm64",
    });

    expect(result.candidates).toEqual([
      expect.objectContaining({
        requestedPath: TUNNEL_HOMEBREW_ARM_BIN,
        verdict: "refused",
        refusalReason: "not-a-regular-file",
      }),
    ]);
  });

  it("refuses a symlink loop without following it further", async () => {
    const { fs: fakeFsPort } = buildFakeFs({
      [TUNNEL_HOMEBREW_ARM_BIN]: { kind: "loop" },
    });

    const result = await discoverExecutables("tunnel-client", {
      fs: fakeFsPort,
      home: "/fake-home-refuse-2",
      arch: "arm64",
    });

    expect(result.candidates).toEqual([
      expect.objectContaining({
        requestedPath: TUNNEL_HOMEBREW_ARM_BIN,
        verdict: "refused",
        refusalReason: "symlink-loop",
      }),
    ]);
  });

  type HashFailure = Extract<HashOutcome, { ok: false }>;

  const hashRefusals: ReadonlyArray<{
    name: string;
    outcome: HashFailure;
  }> = [
    {
      name: "world-or-group-writable",
      outcome: { ok: false, reason: "world-or-group-writable", bytes: 42 },
    },
    { name: "wrong-owner", outcome: { ok: false, reason: "wrong-owner" } },
    {
      name: "oversize",
      outcome: { ok: false, reason: "oversize", bytes: 999_999_999 },
    },
    { name: "unreadable", outcome: { ok: false, reason: "unreadable" } },
  ];

  for (const { name, outcome } of hashRefusals) {
    it(`refuses a candidate that fails the ${name} safety check and never inspects its signature`, async () => {
      const canonical = `/canonical/${name}`;
      const { fs: fakeFsPort } = buildFakeFs({
        [CODEX_HOMEBREW_ARM]: { kind: "real", target: canonical },
      });
      const codesignSpy = fakeCodesign({}); // must never be called for a refused candidate

      const result = await discoverExecutables("codex", {
        fs: fakeFsPort,
        home: "/fake-home-refuse-hash",
        arch: "arm64",
        hash: fakeHash({ [canonical]: outcome }),
        codesign: codesignSpy,
      });

      expect(result.candidates).toEqual([
        expect.objectContaining({
          requestedPath: CODEX_HOMEBREW_ARM,
          path: canonical,
          verdict: "refused",
          refusalReason: outcome.reason,
        }),
      ]);
    });
  }
});

describe("executable discovery — codex signature trust", () => {
  it("never auto-offers when the signed path changes bytes during discovery", async () => {
    const canonical = "/canonical/codex-drift";
    const { fs: fakeFsPort } = buildFakeFs({
      [CODEX_HOMEBREW_ARM]: { kind: "real", target: canonical },
    });
    const hash = vi
      .fn<DiscoveryHash>()
      .mockResolvedValueOnce({
        ok: true,
        bytes: 42,
        sha256: "a".repeat(64),
      })
      .mockResolvedValueOnce({
        ok: true,
        bytes: 43,
        sha256: "b".repeat(64),
      });

    const result = await discoverExecutables("codex", {
      fs: fakeFsPort,
      home: "/fake-home-codex-drift",
      arch: "arm64",
      hash,
      codesign: fakeCodesign({
        [canonical]: { verified: true, trustedOpenAI: true },
      }),
    });

    expect(hash).toHaveBeenCalledTimes(2);
    expect(result.candidates[0]).toMatchObject({
      path: canonical,
      bytes: 43,
      sha256: "b".repeat(64),
      origin: "unknown",
      verdict: "refused",
      refusalReason: "changed-during-discovery",
    });
  });

  it("offers a codex binary signed by the OpenAI team", async () => {
    const fixture = await realFileFixture();
    const { fs: fakeFsPort } = buildFakeFs({
      [CODEX_HOMEBREW_ARM]: { kind: "real", target: fixture.target },
    });

    const result = await discoverExecutables("codex", {
      fs: fakeFsPort,
      home: "/fake-home-codex-offer",
      arch: "arm64",
      codesign: fakeCodesign({
        [fixture.target]: {
          verified: true,
          trustedOpenAI: true,
          teamIdentifier: "2DC432GLL2",
        },
      }),
    });

    expect(result.candidates).toEqual([
      {
        requestedPath: CODEX_HOMEBREW_ARM,
        path: fixture.target,
        source: "homebrew",
        bytes: fixture.size,
        sha256: fixture.sha256,
        origin: "signed-by-openai",
        verdict: "offer",
      },
    ]);
  });

  it("never auto-offers a binary signed by another team", async () => {
    const fixture = await realFileFixture();
    const { fs: fakeFsPort } = buildFakeFs({
      [CODEX_HOMEBREW_ARM]: { kind: "real", target: fixture.target },
    });

    const result = await discoverExecutables("codex", {
      fs: fakeFsPort,
      home: "/fake-home-codex-other-team",
      arch: "arm64",
      codesign: fakeCodesign({
        [fixture.target]: {
          verified: true,
          trustedOpenAI: false,
          teamIdentifier: "OTHERTEAM1234",
        },
      }),
    });

    expect(result.candidates[0]?.origin).toBe("signature-other-team");
    expect(result.candidates[0]?.verdict).toBe("needs-owner-choice");
  });

  it("never offers a binary whose TeamIdentifier text merely happens to match the OpenAI identifier if the -R requirement check itself did not pass", async () => {
    // A forged or coincidentally-matching display string must not be
    // sufficient on its own: `trustedOpenAI` (the actual
    // `codesign --verify --strict -R=...` outcome) is the only source of
    // truth classifyCodexOrigin consults for "signed-by-openai".
    const fixture = await realFileFixture();
    const { fs: fakeFsPort } = buildFakeFs({
      [CODEX_HOMEBREW_ARM]: { kind: "real", target: fixture.target },
    });

    const result = await discoverExecutables("codex", {
      fs: fakeFsPort,
      home: "/fake-home-codex-spoofed-text",
      arch: "arm64",
      codesign: fakeCodesign({
        [fixture.target]: {
          verified: true,
          trustedOpenAI: false,
          teamIdentifier: "2DC432GLL2",
        },
      }),
    });

    expect(result.candidates[0]?.origin).not.toBe("signed-by-openai");
    expect(result.candidates[0]?.verdict).toBe("needs-owner-choice");
  });

  it("never auto-offers an unsigned binary", async () => {
    const fixture = await realFileFixture();
    const { fs: fakeFsPort } = buildFakeFs({
      [CODEX_HOMEBREW_ARM]: { kind: "real", target: fixture.target },
    });

    const result = await discoverExecutables("codex", {
      fs: fakeFsPort,
      home: "/fake-home-codex-unsigned",
      arch: "arm64",
      codesign: fakeCodesign({
        [fixture.target]: { verified: false, trustedOpenAI: false },
      }),
    });

    expect(result.candidates[0]?.origin).toBe("unsigned");
    expect(result.candidates[0]?.verdict).toBe("needs-owner-choice");
  });
});

describe("executable discovery — codesign requirement string", () => {
  it("runs codesign --verify --strict with the OpenAI OU requirement, not just plain --verify --strict", async () => {
    const execFileMock = vi.mocked(execFile);
    execFileMock.mockImplementation(((...callArgs: unknown[]) => {
      const callback = callArgs[callArgs.length - 1] as (
        error: Error | null,
        stdout: string,
        stderr: string,
      ) => void;
      callback(null, "TeamIdentifier=2DC432GLL2\n", "");
      return {} as ReturnType<typeof execFile>;
    }) as unknown as typeof execFile);

    const canonical = "/canonical/codesign-requirement";
    const { fs: fakeFsPort } = buildFakeFs({
      [CODEX_HOMEBREW_ARM]: { kind: "real", target: canonical },
    });

    const result = await discoverExecutables("codex", {
      fs: fakeFsPort,
      home: "/fake-home-codesign-requirement",
      arch: "arm64",
      hash: fakeHash({
        [canonical]: { ok: true, bytes: 42, sha256: "a".repeat(64) },
      }),
    });

    const calls = execFileMock.mock.calls as unknown as ReadonlyArray<
      [string, readonly string[], unknown, unknown]
    >;
    const plainVerify = calls.find(
      ([, args]) =>
        args.includes("--verify") && !args.some((arg) => arg.startsWith("-R=")),
    );
    const requirementVerify = calls.find(([, args]) =>
      args.some((arg) => arg.startsWith("-R=")),
    );
    expect(plainVerify).toBeDefined();
    expect(requirementVerify).toBeDefined();
    expect(requirementVerify?.[1]).toEqual(
      expect.arrayContaining([
        "--verify",
        "--strict",
        '-R=anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"',
      ]),
    );
    // Reported TeamIdentifier stays for display even though it never
    // decides the verdict on its own.
    expect(result.candidates[0]?.origin).toBe("signed-by-openai");
    expect(result.candidates[0]?.verdict).toBe("offer");
  });
});

describe("executable discovery — ordering and dedupe", () => {
  it("orders offer candidates first and dedupes two seeds that resolve to the same file", async () => {
    const openaiSigned = await realFileFixture("#!/bin/sh\necho openai\n");
    const otherTeamSigned = await realFileFixture("#!/bin/sh\necho other\n");
    const { fs: fakeFsPort } = buildFakeFs({
      [CODEX_CHATGPT_APP]: { kind: "real", target: openaiSigned.target },
      [CODEX_CODEX_APP]: { kind: "real", target: openaiSigned.target }, // same file, must dedupe
      [CODEX_HOMEBREW_ARM]: { kind: "real", target: otherTeamSigned.target },
    });

    const result = await discoverExecutables("codex", {
      fs: fakeFsPort,
      home: "/fake-home-order",
      arch: "arm64",
      codesign: fakeCodesign({
        [openaiSigned.target]: {
          verified: true,
          trustedOpenAI: true,
          teamIdentifier: "2DC432GLL2",
        },
        [otherTeamSigned.target]: {
          verified: true,
          trustedOpenAI: false,
          teamIdentifier: "OTHERTEAM1234",
        },
      }),
    });

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]?.requestedPath).toBe(CODEX_CHATGPT_APP);
    expect(result.candidates[0]?.verdict).toBe("offer");
    expect(result.candidates[1]?.requestedPath).toBe(CODEX_HOMEBREW_ARM);
    expect(result.candidates[1]?.verdict).toBe("needs-owner-choice");
  });

  it("dedupes byte-identical trusted copies by reviewed digest", async () => {
    const first = await realFileFixture("#!/bin/sh\necho same\n");
    const copy = await realFileFixture("#!/bin/sh\necho same\n");
    const { fs: fakeFsPort } = buildFakeFs({
      [CODEX_CHATGPT_APP]: { kind: "real", target: first.target },
      [CODEX_HOMEBREW_ARM]: { kind: "real", target: copy.target },
    });

    const result = await discoverExecutables("codex", {
      fs: fakeFsPort,
      home: "/fake-home-digest-dedupe",
      arch: "arm64",
      codesign: fakeCodesign({
        [first.target]: { verified: true, trustedOpenAI: true },
        [copy.target]: { verified: true, trustedOpenAI: true },
      }),
    });

    expect(first.target).not.toBe(copy.target);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.requestedPath).toBe(CODEX_CHATGPT_APP);
  });

  it("keeps the strongest validation when byte-identical paths disagree", async () => {
    const first = await realFileFixture("#!/bin/sh\necho same\n");
    const copy = await realFileFixture("#!/bin/sh\necho same\n");
    const { fs: fakeFsPort } = buildFakeFs({
      [CODEX_CHATGPT_APP]: { kind: "real", target: first.target },
      [CODEX_HOMEBREW_ARM]: { kind: "real", target: copy.target },
    });

    const result = await discoverExecutables("codex", {
      fs: fakeFsPort,
      home: "/fake-home-digest-strongest",
      arch: "arm64",
      codesign: fakeCodesign({
        [first.target]: { verified: false, trustedOpenAI: false },
        [copy.target]: { verified: true, trustedOpenAI: true },
      }),
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      requestedPath: CODEX_HOMEBREW_ARM,
      verdict: "offer",
      origin: "signed-by-openai",
    });
  });
});

describe("executable discovery — bounded search surface", () => {
  it("touches only the fixed codex paths and the one-level nvm listing, nothing else", async () => {
    const home = "/fake-home-bounded-codex";
    const { fs: fakeFsPort, touched } = buildFakeFs({});

    await discoverExecutables("codex", { fs: fakeFsPort, home, arch: "arm64" });

    expect(new Set(touched)).toEqual(
      new Set([
        nvmVersionsRoot(home),
        CODEX_CHATGPT_APP,
        CODEX_CODEX_APP,
        CODEX_HOMEBREW_ARM,
        CODEX_HOMEBREW_INTEL,
      ]),
    );
  });

  it("touches only the fixed tunnel-client paths and the reviewed-build-dir path, nothing else", async () => {
    const home = "/fake-home-bounded-tunnel";
    const { fs: fakeFsPort, touched } = buildFakeFs({});

    await discoverExecutables("tunnel-client", {
      fs: fakeFsPort,
      home,
      arch: "arm64",
    });

    expect(new Set(touched)).toEqual(
      new Set([
        TUNNEL_HOMEBREW_ARM_BIN,
        TUNNEL_HOMEBREW_ARM_LIBEXEC,
        TUNNEL_HOMEBREW_INTEL_BIN,
        TUNNEL_HOMEBREW_INTEL_LIBEXEC,
        reviewedBuildPath(home, REVIEWED_TUNNEL_CLIENT_DIGESTS.arm64.sha256),
      ]),
    );
  });

  it("lists at most one nvm version directory deep and never scans past the vendored layout it expects", async () => {
    const home = "/fake-home-npm";
    const version = "v22.19.0";
    const vendoredPath = path.join(
      nvmVersionsRoot(home),
      version,
      "lib",
      "node_modules",
      "@openai",
      "codex",
      "node_modules",
      "@openai",
      "codex-darwin-arm64",
      "vendor",
      "aarch64-apple-darwin",
      "bin",
      "codex",
    );
    const fixture = await realFileFixture();
    const { fs: fakeFsPort, touched } = buildFakeFs({
      [nvmVersionsRoot(home)]: { kind: "dir", entries: [version] },
      [vendoredPath]: { kind: "real", target: fixture.target },
    });

    const result = await discoverExecutables("codex", {
      fs: fakeFsPort,
      home,
      arch: "arm64",
      codesign: fakeCodesign({
        [fixture.target]: {
          verified: true,
          trustedOpenAI: true,
          teamIdentifier: "2DC432GLL2",
        },
      }),
    });

    expect(result.candidates).toEqual([
      expect.objectContaining({
        requestedPath: vendoredPath,
        source: "npm-global",
        verdict: "offer",
      }),
    ]);
    // Only the fixed candidates, the one nvm listing, and the single derived
    // vendored path were ever touched — no recursive walk of the package.
    expect(new Set(touched)).toEqual(
      new Set([
        nvmVersionsRoot(home),
        CODEX_CHATGPT_APP,
        CODEX_CODEX_APP,
        CODEX_HOMEBREW_ARM,
        CODEX_HOMEBREW_INTEL,
        vendoredPath,
      ]),
    );
  });
});

describe("reviewed tunnel-client digests stay pinned to the standalone dependency registry", () => {
  it("matches tooling/external-dependencies.json's dependencies.tunnelClient.builds exactly", async () => {
    const registryPath = path.join(
      __dirname,
      "..",
      "..",
      "tooling",
      "external-dependencies.json",
    );
    const raw = await fs.readFile(registryPath, "utf8");
    const registry = JSON.parse(raw) as {
      dependencies: {
        tunnelClient: {
          builds: Record<string, { sha256: string; bytes: number }>;
        };
      };
    };

    expect(REVIEWED_TUNNEL_CLIENT_DIGESTS).toEqual(
      registry.dependencies.tunnelClient.builds,
    );
  });
});
