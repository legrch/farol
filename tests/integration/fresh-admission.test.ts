import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preserveFreshStartHistory } from "../../apps/desktop/recovery/fresh-admission";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((p) => fs.rm(p, { recursive: true, force: true })),
  );
});
async function fixture(pid = 2147483647) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-fresh-admission-")),
  );
  roots.push(root);
  await fs.chmod(root, 0o700);
  const run = Buffer.from(
    JSON.stringify({
      schema: 1,
      pid,
      startedAt: "2026-10-26T15:19:22.185Z",
      bootTime: null,
      processStart: null,
    }) + "\n",
  );
  const quit = Buffer.from(
    JSON.stringify({
      schema: 1,
      at: "2026-10-26T17:28:03.914Z",
      drained: false,
      unconfirmed: ["connector", "go-core"],
    }) + "\n",
  );
  await fs.writeFile(path.join(root, "running.json"), run, { mode: 0o600 });
  await fs.writeFile(path.join(root, "last-quit.json"), quit, { mode: 0o600 });
  const unknown = Array.from({ length: 57 }, (_, n) => ({
    id: `original-${n}`,
    outcome: "unknown",
  }))
    .map((v) => JSON.stringify(v))
    .join("\n");
  await fs.writeFile(path.join(root, "operations.jsonl"), unknown, {
    mode: 0o600,
  });
  return { root, run, quit, unknown };
}
describe("fresh host preservation before independent native admission", () => {
  it("retains old marker/Quit bytes and all 57 UNKNOWN without resolving or replaying them", async () => {
    const f = await fixture();
    let current = 0;
    await preserveFreshStartHistory(f.root, async () => {
      current++;
    });
    expect(current).toBe(3);
    const [name] = await fs.readdir(path.join(f.root, "run-history"));
    const archive = path.join(f.root, "run-history", name!);
    expect(await fs.readFile(path.join(archive, "running.json"))).toEqual(
      f.run,
    );
    expect(await fs.readFile(path.join(archive, "last-quit.json"))).toEqual(
      f.quit,
    );
    expect(await fs.readFile(path.join(f.root, "running.json"))).toEqual(f.run);
    expect(await fs.readFile(path.join(f.root, "last-quit.json"))).toEqual(
      f.quit,
    );
    expect(
      await fs.readFile(path.join(f.root, "operations.jsonl"), "utf8"),
    ).toBe(f.unknown);
  });
  it("does not admit a live or unidentified current owner", async () => {
    const f = await fixture(process.pid);
    await expect(
      preserveFreshStartHistory(f.root, async () => {}),
    ).rejects.toThrow("FRESH_START_CURRENT_OWNER_UNCONFIRMED");
    expect(await fs.readdir(f.root)).toEqual(
      expect.not.arrayContaining(["run-history"]),
    );
    expect(await fs.readFile(path.join(f.root, "running.json"))).toEqual(f.run);
  });
  it("does not replace a marker after current startup exclusion is lost", async () => {
    const f = await fixture();
    const error = Error("current claim lost");
    await expect(
      preserveFreshStartHistory(f.root, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(await fs.readFile(path.join(f.root, "running.json"))).toEqual(f.run);
    expect(await fs.readdir(f.root)).not.toContain("run-history");
  });
  it("preserves absence of an old Quit and refuses duplicate marker keys", async () => {
    const f = await fixture();
    await fs.unlink(path.join(f.root, "last-quit.json"));
    await preserveFreshStartHistory(f.root, async () => {});
    const [name] = await fs.readdir(path.join(f.root, "run-history"));
    expect(await fs.readdir(path.join(f.root, "run-history", name!))).toEqual([
      "running.json",
    ]);
    const duplicate = f.run.toString().replace('"pid":', '"pid":7,"pid":');
    await fs.writeFile(path.join(f.root, "running.json"), duplicate);
    await expect(
      preserveFreshStartHistory(f.root, async () => {}),
    ).rejects.toThrow();
    expect(await fs.readFile(path.join(f.root, "running.json"), "utf8")).toBe(
      duplicate,
    );
  });
});
