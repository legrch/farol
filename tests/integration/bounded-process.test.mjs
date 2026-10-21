import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runBoundedProcess } from "../e2e/bounded-process.mjs";

const roots = [];

function parseLinuxProcessState(stat, pid) {
  // comm may contain spaces, parentheses, and newlines; numeric fields follow it.
  const match =
    /^([1-9]\d*) \([\s\S]*\) ([RSDZTtXxKWPI]) ((?:-?\d+ )*-?\d+)\n$/.exec(stat);
  if (match?.[1] !== String(pid) || match[3].split(" ").length < 19) {
    throw new Error("INVALID_LINUX_PROCESS_STAT");
  }
  return match[2];
}

async function observeProcessLiveness(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return "absent";
    throw error;
  }
  if (process.platform !== "linux") return "live";

  let stat;
  try {
    stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    // A disappearing proc entry still needs the ordinary absence proof.
    try {
      process.kill(pid, 0);
    } catch (absenceError) {
      if (absenceError?.code === "ESRCH") return "absent";
      throw absenceError;
    }
    throw error;
  }
  // Zombies have terminated, but their parent has not reaped them.
  return parseLinuxProcessState(stat, pid) === "Z" ? "zombie" : "live";
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("bounded E2E child process", () => {
  it("distinguishes a live owned child from an absent one", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1_000)"],
      { stdio: "ignore" },
    );
    const closed = new Promise((resolve) => child.once("close", resolve));
    try {
      await once(child, "spawn");
      expect(await observeProcessLiveness(child.pid)).toBe("live");
    } finally {
      child.kill("SIGKILL");
      await closed;
    }
    expect(await observeProcessLiveness(child.pid)).toBe("absent");
  });

  it("parses Linux state after a comm containing parentheses and newlines", () => {
    const fields = Array(49).fill("0").join(" ");
    expect(
      parseLinuxProcessState(`123 (fixture ) name\n) Z ${fields}\n`, 123),
    ).toBe("Z");
  });

  it.each([
    "123 (fixture) Z 0\n",
    `124 (fixture) Z ${Array(49).fill("0").join(" ")}\n`,
    `123 (fixture) ? ${Array(49).fill("0").join(" ")}\n`,
    `123 (fixture) Z ${Array(49).fill("0").join(" ")} invalid\n`,
  ])("rejects uncertain Linux stat data: %j", (stat) => {
    expect(() => parseLinuxProcessState(stat, 123)).toThrow(
      "INVALID_LINUX_PROCESS_STAT",
    );
  });

  it("bounds inherited pipes and terminates its fixture descendant", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-bounded-child-"),
    );
    roots.push(root);
    const pidFile = path.join(root, "descendant.pid");
    const startedAt = Date.now();
    await expect(
      runBoundedProcess(
        process.execPath,
        [
          path.join(import.meta.dirname, "../e2e/inherited-pipe.fixture.cjs"),
          pidFile,
        ],
        {
          cwd: root,
          env: process.env,
          timeoutMs: 1_000,
          terminationGraceMs: 250,
        },
      ),
    ).rejects.toThrow("E2E_CHILD_TIMEOUT");
    expect(Date.now() - startedAt).toBeLessThan(2_000);

    const descendant = Number((await fs.readFile(pidFile, "utf8")).trim());
    expect(Number.isSafeInteger(descendant) && descendant > 1).toBe(true);
    let liveness = "live";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      liveness = await observeProcessLiveness(descendant);
      if (liveness !== "live") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // This checks termination of this fixture child, not reaping or containment.
    expect(["absent", "zombie"]).toContain(liveness);
  });
});
