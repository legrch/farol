import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSupervisedUpdate } from "../../tooling/supervised-update-controller.mjs";
import { runSupervisedUpdateCLI } from "../../tooling/supervised-update.mjs";

vi.mock("../../tooling/supervised-update-controller.mjs", () => ({
  runSupervisedUpdate: vi.fn(),
}));
let root;
let file;
let bytes;
let digest;
const argumentsFor = () => ["--input", file, "--sha256", digest, "--apply"];
beforeEach(async () => {
  root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "farol-supervised-cli-"),
  );
  file = path.join(root, "selection.json");
  bytes = Buffer.from('{"fixture":"controller is mocked"}\n');
  digest = createHash("sha256").update(bytes).digest("hex");
  await fs.writeFile(file, bytes, { mode: 0o600 });
  vi.mocked(runSupervisedUpdate)
    .mockReset()
    .mockResolvedValue({ status: "completed" });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
describe("external supervisor entry (mocked controller, disposable input)", () => {
  it("requires exact hashed private input and invokes one controller", async () => {
    const output = vi.fn();
    expect(await runSupervisedUpdateCLI(argumentsFor(), output)).toBe(0);
    expect(runSupervisedUpdate).toHaveBeenCalledExactlyOnceWith(
      JSON.parse(bytes),
      output,
    );
    expect(output).toHaveBeenCalledExactlyOnceWith({ status: "completed" });
  });
  it.each([
    "missing-apply",
    "extra-flag",
    "relative",
    "digest",
    "shared",
    "symlink",
    "hardlink",
    "oversized",
  ])("refuses %s before any controller effect", async (kind) => {
    const args = argumentsFor();
    if (kind === "missing-apply") args.pop();
    if (kind === "extra-flag") args.push("--force");
    if (kind === "relative") args[1] = "selection.json";
    if (kind === "digest") args[3] = "0".repeat(64);
    if (kind === "shared") await fs.chmod(file, 0o644);
    if (kind === "symlink") {
      await fs.rename(file, file + ".original");
      await fs.symlink(file + ".original", file);
    }
    if (kind === "hardlink") await fs.link(file, file + ".alias");
    if (kind === "oversized") await fs.writeFile(file, " ".repeat(32769));
    await expect(runSupervisedUpdateCLI(args, vi.fn())).rejects.toThrow();
    expect(runSupervisedUpdate).not.toHaveBeenCalled();
  });
  it.each([
    [{ status: "blocked" }, 2],
    [{ status: "unknown" }, 3],
    [
      {
        status: "completed",
        reportingFailure: "UPDATE_PROGRESS_REPORT_FAILED",
      },
      3,
    ],
    [{ status: "completed", controllerClose: "unconfirmed" }, 3],
    [{ status: "blocked", leaseRelease: "unconfirmed" }, 3],
  ])("preserves the controller classification %j", async (report, code) => {
    vi.mocked(runSupervisedUpdate).mockResolvedValue(report);
    const output = vi.fn();
    expect(await runSupervisedUpdateCLI(argumentsFor(), output)).toBe(code);
    expect(output).toHaveBeenCalledExactlyOnceWith(report);
    expect(runSupervisedUpdate).toHaveBeenCalledTimes(1);
  });
  it("prints help without reading an input or invoking the controller", async () => {
    const output = vi.fn();
    expect(await runSupervisedUpdateCLI(["--help"], output)).toBe(0);
    expect(output).toHaveBeenCalledTimes(1);
    expect(runSupervisedUpdate).not.toHaveBeenCalled();
  });

  it.each(["throw", "reject"])(
    "returns reporting loss for a final-only %s without changing the terminal",
    async (kind) => {
      const terminal = Object.freeze({
        status: "completed",
        reportingFailure: null,
        helper: { operationId: "exact-original-fixture" },
      });
      vi.mocked(runSupervisedUpdate).mockImplementation(
        async (_input, publish) => {
          publish({ status: "prepared" });
          return terminal;
        },
      );
      const output = vi.fn((value) => {
        if (value.status !== "completed") return;
        if (kind === "reject")
          return Promise.reject(new Error("OUTPUT_CLOSED"));
        throw new Error("OUTPUT_CLOSED");
      });
      expect(await runSupervisedUpdateCLI(argumentsFor(), output)).toBe(3);
      expect(output).toHaveBeenLastCalledWith(terminal);
      expect(terminal.status).toBe("completed");
      expect(runSupervisedUpdate).toHaveBeenCalledTimes(1);
    },
  );

  it("consumes an async final rejection after an earlier reporting failure", async () => {
    const result = {
      status: "blocked",
      reportingFailure: "UPDATE_PROGRESS_REPORT_FAILED",
    };
    vi.mocked(runSupervisedUpdate).mockResolvedValue(result);
    expect(
      await runSupervisedUpdateCLI(argumentsFor(), async () => {
        throw new Error("OUTPUT_CLOSED");
      }),
    ).toBe(3);
    expect(result.status).toBe("blocked");
    expect(runSupervisedUpdate).toHaveBeenCalledTimes(1);
  });
});
