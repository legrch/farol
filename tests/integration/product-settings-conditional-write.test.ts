import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../src/apps/desktop/product-configuration";
import {
  prepareClosedStartupCompatibility,
  type ClosedStartupCompatibilityGuards,
} from "../../src/apps/desktop/closed-startup-compatibility";
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

// Actual disposable config.json publication through the retained Store only.
// Closure/app-pair/operation/lease checks are controlled caller guard fixtures;
// the ACK fault below is injected after a real rename. These are storage
// composition cases, not native app-state restoration or admission acceptance.
function startupGuards(): ClosedStartupCompatibilityGuards {
  const guard = () => ({
    beforeWrite: vi.fn(async () => {}),
    assertBeforePublication: vi.fn(() => {}),
  });
  return {
    closure: guard(),
    appPair: guard(),
    currentSettings: guard(),
    originalOperation: guard(),
    promotionLease: guard(),
  };
}

async function startupFixture() {
  const f = await fixture();
  const current: ProductSettings = {
    ...structuredClone(f.next),
    revision: 31,
    general: {
      openAtLaunch: "home",
      sidebarDefault: "rail",
      activityDetail: "technical",
    },
    tasks: { retained: { policy: "current", delivery: "outcome_unknown" } },
    computer: {
      ...f.next.computer,
      commands: "workspace",
      filePolicy: "approved-roots-v1",
      workspaces: [
        {
          workspaceId: "00000000-0000-4000-8000-00000000000c",
          root: "/fixture/approved",
          label: "Retained root",
          access: "write",
          excludedPaths: ["/fixture/approved/private"],
          rootIdentity: { device: "11", inode: "23" },
          gitHistoryApproved: false,
        },
      ],
    },
    nativeHosts: {
      generation: 9,
      codex: {
        executablePath: "/fixture/bin/codex",
        executableSha256: "b".repeat(64),
        version: "0.153.4",
        protocol: "codex-app-server/v2",
        schemaSha256: "c".repeat(64),
        verifiedAt: "2026-10-08T09:00:00.000Z",
        localVerification: null,
        liveVerification: null,
        agentVerification: null,
      },
      taskRoute: null,
    },
    connectors: {
      secureMcp: {
        ...f.next.connectors.secureMcp,
        generation: 17,
        credential: "stored",
        runtime: {
          state: "outcome_unknown",
          connectorGeneration: 17,
          computerGeneration: f.next.computer.generation,
          runtimeGeneration: "d".repeat(64),
          buildId: "e".repeat(64),
          observedAt: "2026-10-09T09:00:00.000Z",
        },
      },
    },
    setup: {
      ...f.next.setup,
      journey: { currentStep: "verify", dismissed: true },
      verify: {
        ...f.next.setup.verify,
        outcomeUnknown: true,
        needsAction: "Retain original unresolved verification",
        verified: {
          profile: "retained-profile",
          configRevision: 27,
          workspaceId: "00000000-0000-4000-8000-00000000000c",
          runtimeGeneration: "retained-runtime",
          buildId: "e".repeat(64),
          protocol: "retained-verification/v1",
          verifiedAt: "2026-10-08T09:00:00.000Z",
        },
      },
    },
  };
  await f.store.save(current);
  const currentSettings = (await f.store.load())!;
  const guards = startupGuards();
  const adapter = prepareClosedStartupCompatibility({
    currentSettings,
    retainedStartupChoice: "activity",
    store: f.store,
    guards,
  });
  if (adapter.status !== "ready") throw new Error("Startup fixture not ready");
  const compatible: ProductSettings = {
    ...structuredClone(currentSettings),
    revision: currentSettings.revision + 1,
    general: { ...currentSettings.general, openAtLaunch: "activity" },
  };
  return { ...f, currentSettings, guards, adapter, compatible };
}

describe("closed startup compatibility with actual disposable Settings storage", () => {
  it("publishes only explicit startup choice and revision while retaining full current Settings", async () => {
    const f = await startupFixture();
    const before = await fs.readFile(f.file);
    const rename = vi.spyOn(fs, "rename");
    expect(await f.adapter.apply()).toEqual({
      status: "committed",
      originalStoreResult: { status: "committed", settings: f.compatible },
    });
    const after = await fs.readFile(f.file);
    expect(after).not.toEqual(before);
    expect(JSON.parse(after.toString("utf8"))).toEqual(f.compatible);
    expect(await f.store.load()).toEqual(f.compatible);
    expect(f.currentSettings.general.openAtLaunch).toBe("home");
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it("leaves actual bytes unchanged without rename when the original publication guard is lost", async () => {
    const f = await startupFixture();
    const before = await fs.readFile(f.file);
    const rename = vi.spyOn(fs, "rename");
    const publication = vi
      .mocked(f.guards.originalOperation.assertBeforePublication)
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error("Original operation guard lost at publication");
      });
    // The adapter already retained the original callable. The controlled loss
    // therefore uses the same bound mock, rather than a replacement guard.
    const conditional = vi.spyOn(f.store, "saveConditional");
    expect(await f.adapter.apply()).toEqual({
      status: "not_written",
      originalStoreResult: { status: "not_written" },
    });
    expect(publication).toHaveBeenCalledTimes(2);
    expect(conditional).toHaveBeenCalledTimes(1);
    expect(rename).not.toHaveBeenCalled();
    expect(await fs.readFile(f.file)).toEqual(before);
    expect(await f.store.load()).toEqual(f.currentSettings);
    await f.adapter.apply();
    expect(conditional).toHaveBeenCalledTimes(1);
    expect(rename).not.toHaveBeenCalled();
  });

  it("keeps post-rename ACK loss unknown, fences the retained Store and never republishes on repeated apply", async () => {
    const f = await startupFixture();
    const originalRename = fs.rename.bind(fs);
    const rename = vi
      .spyOn(fs, "rename")
      .mockImplementationOnce(async (a, b) => {
        await originalRename(a, b);
        throw new Error("Injected ACK loss after actual Settings rename");
      });
    const load = vi.spyOn(f.store, "load");
    const conditional = vi.spyOn(f.store, "saveConditional");
    const attempt = f.adapter.apply();
    const result = await attempt;
    expect(result).toEqual({
      status: "unknown",
      originalStoreResult: { status: "unknown" },
    });
    expect(result.originalStoreResult).toBe(
      await conditional.mock.results[0]!.value,
    );
    // Exactly the Store's two source comparisons; no failed-ACK readback or
    // adapter reread upgrades the original operation.
    expect(load).toHaveBeenCalledTimes(2);
    const bytes = await fs.readFile(f.file);
    expect(JSON.parse(bytes.toString("utf8"))).toEqual(f.compatible);
    expect(f.adapter.apply()).toBe(attempt);
    expect(await f.adapter.apply()).toBe(result);
    await expect(f.store.save(f.currentSettings)).rejects.toThrow(
      "SETTINGS_WRITE_OUTCOME_UNKNOWN",
    );
    expect(conditional).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(2);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(f.file)).toEqual(bytes);
  });
});
