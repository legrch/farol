import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CodexSocketAdmissionError,
  existingCodexSocket,
  SharedCodexProxyHost,
} from "../../src/modules/chat/infra/native/shared-codex-proxy-host";
import { codexTaskRouteFailureCode } from "../../src/apps/desktop/codex-task-route-error";
import { ProductConfigurationResultSchema } from "../../src/pkg/product-settings/contract";

const SOCKET = "/fixture/selected.sock";
type SocketInfo = Awaited<ReturnType<typeof fs.lstat>>;

function socketInfo(
  kind: "socket" | "symlink" | "file",
  uid = process.getuid?.() ?? 0,
): SocketInfo {
  return {
    uid,
    isSocket: () => kind === "socket",
    isSymbolicLink: () => kind === "symlink",
  } as SocketInfo;
}

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error("private provider path and details"), {
    code,
  });
}

afterEach(() => vi.restoreAllMocks());

describe("selected shared Codex socket admission diagnostics", () => {
  it("passes only closed socket codes through the desktop result contract", () => {
    const denied = new CodexSocketAdmissionError(
      "CODEX_SHARED_SOCKET_ACCESS_DENIED",
      "realpath",
      "EPERM",
    );
    const code = codexTaskRouteFailureCode(denied);
    expect(
      ProductConfigurationResultSchema.parse({
        ok: false,
        error: code,
        snapshot: { status: "error", error: "SETTINGS_READ_FAILED" },
      }),
    ).toMatchObject({ error: "CODEX_SHARED_SOCKET_ACCESS_DENIED" });
    expect(
      codexTaskRouteFailureCode(new Error("private provider detail")),
    ).toBe("CODEX_TASK_ROUTE_UNAVAILABLE");
  });

  it.each([
    ["ENOENT", "CODEX_SHARED_SOCKET_NOT_FOUND"],
    ["EPERM", "CODEX_SHARED_SOCKET_ACCESS_DENIED"],
    ["EACCES", "CODEX_SHARED_SOCKET_ACCESS_DENIED"],
    ["EIO", "CODEX_SHARED_SOCKET_CHECK_FAILED"],
  ])(
    "classifies lstat %s and never follows the target",
    async (errno, code) => {
      vi.spyOn(fs, "lstat").mockRejectedValue(fsError(errno));
      const follow = vi.spyOn(fs, "realpath");
      await expect(existingCodexSocket(SOCKET)).rejects.toMatchObject({
        message: code,
        phase: "lstat",
        errno: errno === "EIO" ? undefined : errno,
      });
      expect(follow).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "symlink",
      process.getuid?.() ?? 0,
      "CODEX_SHARED_SOCKET_ALIAS_UNSUPPORTED",
    ],
    ["file", process.getuid?.() ?? 0, "CODEX_SHARED_SOCKET_INVALID_TARGET"],
    [
      "socket",
      (process.getuid?.() ?? 0) + 1,
      "CODEX_SHARED_SOCKET_INVALID_TARGET",
    ],
  ] as const)(
    "refuses a %s or wrong-owner endpoint before realpath",
    async (kind, uid, code) => {
      vi.spyOn(fs, "lstat").mockResolvedValue(socketInfo(kind, uid));
      const follow = vi.spyOn(fs, "realpath");
      await expect(existingCodexSocket(SOCKET)).rejects.toMatchObject({
        message: code,
        phase: "lstat",
      });
      expect(follow).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["EPERM", "CODEX_SHARED_SOCKET_ACCESS_DENIED"],
    ["EIO", "CODEX_SHARED_SOCKET_CHECK_FAILED"],
  ])("retains realpath %s without exposing the cause", async (errno, code) => {
    vi.spyOn(fs, "lstat").mockResolvedValue(socketInfo("socket"));
    vi.spyOn(fs, "realpath").mockRejectedValue(fsError(errno));
    await expect(existingCodexSocket(SOCKET)).rejects.toMatchObject({
      message: code,
      phase: "realpath",
      errno: errno === "EIO" ? undefined : errno,
    });
  });

  it("keeps canonical owner socket admission and refuses a changed path", async () => {
    vi.spyOn(fs, "lstat").mockResolvedValue(socketInfo("socket"));
    const follow = vi
      .spyOn(fs, "realpath")
      .mockResolvedValueOnce(SOCKET)
      .mockResolvedValueOnce("/fixture/other.sock");
    await expect(existingCodexSocket(SOCKET)).resolves.toBe(SOCKET);
    await expect(existingCodexSocket(SOCKET)).rejects.toMatchObject({
      message: "CODEX_SHARED_SOCKET_INVALID_TARGET",
      phase: "realpath",
    });
    expect(follow).toHaveBeenCalledTimes(2);
  });

  it("does not start a proxy after a metadata refusal", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-socket-diagnostic-")),
    );
    const executable = path.join(root, "codex-fixture");
    const bytes = Buffer.from("fixture executable, never launched\n");
    await fs.writeFile(executable, bytes, { mode: 0o700 });
    const realLstat = fs.lstat.bind(fs);
    const connect = vi.spyOn(SharedCodexProxyHost.prototype, "connect");
    vi.spyOn(fs, "lstat").mockImplementation((value, options) =>
      String(value) === SOCKET
        ? Promise.reject(fsError("EPERM"))
        : realLstat(value, options),
    );
    try {
      await expect(
        SharedCodexProxyHost.attach({
          executablePath: executable,
          executableSha256: createHash("sha256").update(bytes).digest("hex"),
          socketPath: SOCKET,
          cwd: root,
          expectedCodexHome: "/fixture/codex-home",
        }),
      ).rejects.toMatchObject({
        message: "CODEX_SHARED_SOCKET_ACCESS_DENIED",
        phase: "lstat",
      });
      expect(connect).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
