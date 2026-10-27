import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireDevLifecycleLock,
  devLifecycleLockPath,
  releaseDevLifecycleLock,
} from "../../tooling/dev-lifecycle-lock.mjs";

const module = new URL("../../tooling/dev-lifecycle-lock.mjs", import.meta.url)
  .href;
const owned = [];

// A separate launcher process that takes the lock and reports the outcome.
function launcher(root) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { acquireDevLifecycleLock } from ${JSON.stringify(module)};
try { await acquireDevLifecycleLock(${JSON.stringify(root)}); process.stdout.write("held\\n"); setInterval(() => {}, 1000); }
catch (error) { process.stdout.write(error.message.split(":")[0] + "\\n"); }`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  owned.push(child);
  const answer = new Promise((resolve) => {
    let text = "";
    child.stdout.on("data", (chunk) => {
      text += chunk;
      if (text.includes("\n")) resolve(text.trim());
    });
  });
  return { child, answer };
}

async function checkout() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-dev-lock-"));
  owned.push(root);
  return root;
}

afterEach(async () => {
  await releaseDevLifecycleLock();
  for (const item of owned.splice(0)) {
    if (typeof item === "string")
      await fs.rm(item, { recursive: true, force: true });
    else if (item.exitCode === null && item.signalCode === null) {
      item.kill("SIGKILL");
      await new Promise((resolve) => item.once("exit", resolve));
    }
  }
});

describe("Dev lifecycle lock", () => {
  it("admits exactly one of two concurrent launchers", async () => {
    const root = await checkout();
    const answers = await Promise.all([
      launcher(root).answer,
      launcher(root).answer,
    ]);
    expect(answers.sort()).toEqual(["DEV_LIFECYCLE_BUSY", "held"]);
  });

  it("refuses while held and admits again after release", async () => {
    const root = await checkout();
    await acquireDevLifecycleLock(root);
    expect(await launcher(root).answer).toBe("DEV_LIFECYCLE_BUSY");
    await releaseDevLifecycleLock();
    expect(await launcher(root).answer).toBe("held");
  });

  it("is free once a holder is killed, without a stale-lock protocol", async () => {
    const root = await checkout();
    const holder = launcher(root);
    expect(await holder.answer).toBe("held");
    holder.child.kill("SIGKILL");
    await new Promise((resolve) => holder.child.once("exit", resolve));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await acquireDevLifecycleLock(root);
    expect(
      JSON.parse(await fs.readFile(devLifecycleLockPath(root), "utf8")).pid,
    ).toBe(process.pid);
  });
});
