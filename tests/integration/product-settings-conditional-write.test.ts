import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../src/apps/desktop/product-configuration";
import type { ProductSettings } from "../../src/pkg/product-settings/contract";

// Real disposable Settings files; injected acknowledgement failures are explicit.
// No Go delivery policy, wire activation, app or provider is exercised here.
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function fixture(beforeCommit?: () => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-settings-cas-"));
  roots.push(root);
  const store = new ProductSettingsStore(
    { root },
    beforeCommit ? { beforeCommit } : {},
  );
  const service = new ProductConfigurationService(store);
  await service.initialize();
  const expected = (await store.load())!;
  const next: ProductSettings = {
    ...structuredClone(expected),
    revision: expected.revision + 1,
    computer: {
      ...structuredClone(expected.computer),
      pendingEdit: {
        backend: "go-owner-v2",
        operationId: "00000000-0000-4000-8000-00000000000a",
        profileId: "00000000-0000-4000-8000-00000000000b",
        workspaceId: "00000000-0000-4000-8000-00000000000c",
        relativePath: "file.txt",
        computerGeneration: expected.computer.generation,
        submittedAt: "2026-10-04T22:00:00.000Z",
        beforeSha256: "a".repeat(64),
      },
    },
  };
  return { root, store, expected, next, file: path.join(root, "config.json") };
}
describe("single Settings writer conditional publication", () => {
  it("retains exact readback and all unrelated fields with one replacement", async () => {
    const f = await fixture();
    f.expected.tasks = { retained: ["unrelated", "policy"] };
    f.next.tasks = structuredClone(f.expected.tasks);
    await f.store.save(f.expected);
    const rename = vi.spyOn(fs, "rename");
    expect(await f.store.saveConditional(f.expected, f.next)).toEqual({
      status: "committed",
      settings: f.next,
    });
    expect(rename).toHaveBeenCalledTimes(1);
    expect(await f.store.load()).toEqual(f.next);
    // The old expectation is not another write permit.
    expect(await f.store.saveConditional(f.expected, f.next)).toEqual({
      status: "not_written",
    });
    expect(rename).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])(
    "refuses a changed document even when its revision is unchanged: %s",
    async (sameRevision) => {
      const f = await fixture();
      const changed = {
        ...structuredClone(f.expected),
        revision: f.expected.revision + (sameRevision ? 0 : 1),
        tasks: { preserve: "external change" },
      };
      await f.store.save(changed);
      const bytes = await fs.readFile(f.file);
      const rename = vi.spyOn(fs, "rename");
      expect(await f.store.saveConditional(f.expected, f.next)).toEqual({
        status: "not_written",
      });
      expect(rename).not.toHaveBeenCalled();
      expect(await fs.readFile(f.file)).toEqual(bytes);
    },
  );
  it("rechecks the exact document immediately before the replacement fence", async () => {
    let change: (() => Promise<void>) | undefined;
    const f = await fixture(async () => change?.());
    const changed = { ...f.expected, tasks: { preserve: "late change" } };
    change = async () => {
      await fs.writeFile(f.file, JSON.stringify(changed));
    };
    const rename = vi.spyOn(fs, "rename");
    expect(await f.store.saveConditional(f.expected, f.next)).toEqual({
      status: "not_written",
    });
    expect(rename).not.toHaveBeenCalled();
    expect(await f.store.load()).toEqual(changed);
  });
  it("keeps a proven pre-publication refusal distinct from an uncertain write", async () => {
    const f = await fixture();
    const bytes = await fs.readFile(f.file);
    const rename = vi.spyOn(fs, "rename");
    expect(
      await f.store.saveConditional(f.expected, f.next, {
        beforeWrite: async () => {
          throw new Error("promotion lease lost before rename");
        },
      }),
    ).toEqual({ status: "not_written" });
    expect(rename).not.toHaveBeenCalled();
    expect(await fs.readFile(f.file)).toEqual(bytes);
    // A later independently authorized caller may use the unfenced store.
    // This storage primitive does not authorize retrying the old Go operation.
    await expect(f.store.save(f.expected)).resolves.toBeUndefined();
  });
  it("fences lost rename acknowledgement even when visible bytes are complete", async () => {
    const f = await fixture();
    const originalRename = fs.rename.bind(fs);
    const rename = vi
      .spyOn(fs, "rename")
      .mockImplementationOnce(async (a, b) => {
        await originalRename(a, b);
        throw new Error("rename acknowledgement lost after replacement");
      });
    expect(await f.store.saveConditional(f.expected, f.next)).toEqual({
      status: "unknown",
    });
    expect(await f.store.load()).toEqual(f.next);
    expect(
      await f.store.saveConditional(f.next, {
        ...f.next,
        revision: f.next.revision + 1,
      }),
    ).toEqual({ status: "unknown" });
    await expect(f.store.save(f.expected)).rejects.toThrow(
      "SETTINGS_WRITE_OUTCOME_UNKNOWN",
    );
    expect(rename).toHaveBeenCalledTimes(1);
    expect(await f.store.load()).toEqual(f.next);
  });
  it("never reloads to upgrade a failed post-publication readback", async () => {
    const f = await fixture();
    const originalLoad = f.store.load.bind(f.store);
    let reads = 0;
    const load = vi.spyOn(f.store, "load").mockImplementation(async () => {
      if (++reads === 3) throw new Error("readback unavailable");
      return originalLoad();
    });
    expect(await f.store.saveConditional(f.expected, f.next)).toEqual({
      status: "unknown",
    });
    expect(reads).toBe(3);
    load.mockRestore();
    expect(await f.store.load()).toEqual(f.next);
    expect(await f.store.saveConditional(f.expected, f.next)).toEqual({
      status: "unknown",
    });
  });
  it("refuses invalid revision/input without publishing or fencing the writer", async () => {
    const f = await fixture();
    const rename = vi.spyOn(fs, "rename");
    expect(await f.store.saveConditional(f.expected, f.expected)).toEqual({
      status: "not_written",
    });
    expect(
      await f.store.saveConditional(f.expected, {
        ...f.next,
        revision: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toEqual({ status: "not_written" });
    expect(rename).not.toHaveBeenCalled();
    expect(await f.store.saveConditional(f.expected, f.next)).toMatchObject({
      status: "committed",
    });
  });
});
