import { describe, expect, it, vi } from "vitest";
import { observeHelper } from "./process";

const start = "Tue Oct  6 12:00:00 2026";
const helper = { pid: 1234, processStart: start };
const reads = (result: { stdout: string; stderr: string }) =>
  vi.fn(async (_pid: number) => result);
const failing = (error: unknown) =>
  vi.fn(async (_pid: number): Promise<never> => {
    throw error;
  });

describe("update helper observation", () => {
  it("is unknown without a retained helper and never reads", async () => {
    const read = reads({ stdout: start, stderr: "" });
    expect(await observeHelper(null, read)).toBe("unknown");
    expect(await observeHelper(undefined, read)).toBe("unknown");
    expect(read).not.toHaveBeenCalled();
  });

  it("reads the retained pid", async () => {
    const read = reads({ stdout: start + "\n", stderr: "" });
    await observeHelper(helper, read);
    expect(read).toHaveBeenCalledExactlyOnceWith(1234);
  });

  it("is live when ps reports the recorded start, trimming output", async () => {
    expect(
      await observeHelper(helper, reads({ stdout: start + "\n", stderr: "" })),
    ).toBe("live");
    expect(
      await observeHelper(
        helper,
        reads({ stdout: ` ${start}  \n`, stderr: "" }),
      ),
    ).toBe("live");
  });

  it("is unknown, not ended, when the start differs", async () => {
    expect(
      await observeHelper(
        helper,
        reads({ stdout: "Wed Oct  7 12:00:00 2026\n", stderr: "" }),
      ),
    ).toBe("unknown");
  });

  it("does not treat a different locale rendering as termination", async () => {
    for (const stdout of [
      "mar. oct.  6 12:00:00 2026\n",
      "6 oct. 2026 12:00:00\n",
      "Tue 06 Oct 2026 12:00:00 PM EEST\n",
    ])
      expect(await observeHelper(helper, reads({ stdout, stderr: "" }))).toBe(
        "unknown",
      );
  });

  it("is unknown for malformed ps output", async () => {
    for (const stdout of [
      "",
      "\n",
      "garbage",
      start + " extra",
      start + "\n" + start + "\n",
      "x".repeat(200),
    ])
      expect(await observeHelper(helper, reads({ stdout, stderr: "" }))).toBe(
        "unknown",
      );
  });

  it("is unknown when ps wrote anything to stderr", async () => {
    expect(
      await observeHelper(helper, reads({ stdout: start, stderr: "warning" })),
    ).toBe("unknown");
  });

  it("is unknown when the recorded start was not captured", async () => {
    expect(
      await observeHelper(
        { pid: 1234, processStart: null },
        reads({ stdout: start, stderr: "" }),
      ),
    ).toBe("unknown");
  });

  it("is ended only for the clean ps absence", async () => {
    expect(
      await observeHelper(helper, failing({ code: 1, stdout: "", stderr: "" })),
    ).toBe("ended");
  });

  it("is unknown for every other failure", async () => {
    for (const error of [
      { code: 2, stdout: "", stderr: "" },
      { code: 1, stdout: "x", stderr: "" },
      { code: 1, stdout: "", stderr: "x" },
      { code: 1, stdout: undefined, stderr: "" },
      { code: 1, stdout: "", stderr: undefined },
      { code: "ETIMEDOUT", stdout: "", stderr: "" },
      { code: "ENOENT" },
      new Error("spawn failed"),
      null,
      undefined,
      "boom",
    ])
      expect(await observeHelper(helper, failing(error))).toBe("unknown");
  });
});
