import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../src/apps/desktop/product-configuration";
import {
  CodexHostSelectionSchema,
  CodexTaskSourceSchema,
  ProductSettingsSchema,
  type CodexTaskSource,
  type ProductSettings,
} from "../../src/pkg/product-settings/contract";

// Synthetic source/route witnesses in disposable settings. No probe, selected
// executable, serving grant, native/provider acceptance or Task startup is run.
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
const hostInput = {
  executablePath: "/fixture/bin/codex",
  executableSha256: "a".repeat(64),
  version: "0.153.4",
  protocol: "codex-app-server/v2",
  schemaSha256: "b".repeat(64),
  buildId: "c".repeat(64),
} as const;
function evidence(followup = true): CodexTaskSource {
  const binding = {
    executablePath: hostInput.executablePath,
    executableSha256: hostInput.executableSha256,
    baseSchemaSha256: hostInput.schemaSha256,
  };
  return {
    handoff: {
      ...binding,
      status: "supported",
      contract: {
        version: hostInput.version,
        protocol: hostInput.protocol,
        schemaSha256: "d".repeat(64),
        projectBoundCreateStatus: true,
      },
    },
    followup: followup
      ? {
          ...binding,
          status: "supported",
          contract: {
            kind: "codex-followup-schema/v1",
            protocol: hostInput.protocol,
            baseSchemaSha256: "d".repeat(64),
            schemaSha256: "e".repeat(64),
          },
        }
      : {
          ...binding,
          status: "unavailable",
          code: "CODEX_HOST_FOLLOWUP_UNAVAILABLE",
        },
  };
}
async function fixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-task-source-settings-"),
  );
  roots.push(root);
  const store = new ProductSettingsStore({ root });
  let now = "2026-10-04T09:00:00.000Z";
  const service = new ProductConfigurationService(store, { now: () => now });
  await service.initialize();
  const settings = () => {
    const snapshot = service.snapshot();
    if (snapshot.status !== "ready")
      throw new Error("Fixture settings missing");
    return snapshot.settings;
  };
  const reload = async () => {
    const next = new ProductConfigurationService(store, { now: () => now });
    await next.initialize();
    return next;
  };
  return {
    root,
    store,
    service,
    settings,
    reload,
    advance: () => {
      now = "2026-10-04T10:00:00.000Z";
    },
  };
}
function route(
  settings: ProductSettings,
): NonNullable<ProductSettings["nativeHosts"]["taskRoute"]> {
  return {
    transport: "codex-shared-proxy/v1",
    socketPath: "/fixture/private/codex.sock",
    expectedCodexHome: "/fixture/home",
    workspaceId: "00000000-0000-4000-8000-000000000001",
    projectId: "00000000-0000-4000-8000-000000000002",
    projectRoot: "/fixture/project",
    projectIdentity: { device: "1", inode: "2" },
    gitCommonDirectory: "/fixture/project/.git",
    execution: { sandbox: "read-only", approvalPolicy: "on-request" },
    harness: "codex",
    computerGeneration: settings.computer.generation,
    hostGeneration: settings.nativeHosts.generation,
    approvedAt: "2026-10-04T09:00:00.000Z",
    expiresAt: Date.parse("2026-10-04T12:00:00.000Z"),
  };
}
async function routedFixture() {
  const f = await fixture();
  expect(
    (await f.service.recordCodexHost({ ...hostInput, taskSource: evidence() }))
      .ok,
  ).toBe(true);
  const saved = f.settings();
  saved.nativeHosts.taskRoute = route(saved);
  await f.store.save(saved);
  return { ...f, routed: await f.reload(), saved };
}

describe("Codex Task source settings producer", () => {
  it("persists exact independent witnesses with trusted local provenance across reload", async () => {
    const f = await fixture();
    const input = evidence();
    expect(
      (await f.service.recordCodexHost({ ...hostInput, taskSource: input })).ok,
    ).toBe(true);
    const saved = f.settings();
    const host = saved.nativeHosts.codex;
    expect(host?.taskSource).toEqual({
      hostGeneration: saved.nativeHosts.generation,
      localVerification: host?.localVerification,
      evidence: input,
    });
    expect(host?.schemaSha256).toBe(hostInput.schemaSha256);
    expect(host?.taskSource?.evidence.handoff.baseSchemaSha256).toBe(
      hostInput.schemaSha256,
    );
    expect(host?.liveVerification).toBeNull();
    expect(host?.agentVerification).toBeNull();
    input.handoff.executablePath = "/fixture/changed-input";
    expect(
      (await f.store.load())?.nativeHosts.codex?.taskSource?.evidence.handoff
        .executablePath,
    ).toBe(hostInput.executablePath);
    expect((await f.reload()).snapshot()).toEqual(f.service.snapshot());
  });

  it("leaves unsupported follow-up separate from supported create/status", async () => {
    const f = await fixture();
    expect(
      (
        await f.service.recordCodexHost({
          ...hostInput,
          taskSource: evidence(false),
        })
      ).ok,
    ).toBe(true);
    expect(f.settings().nativeHosts.codex?.taskSource?.evidence).toEqual(
      evidence(false),
    );
  });

  it("persists classified unavailable evidence without enabling a Task route", async () => {
    const f = await routedFixture();
    const input = evidence(false);
    input.handoff = {
      executablePath: hostInput.executablePath,
      executableSha256: hostInput.executableSha256,
      baseSchemaSha256: hostInput.schemaSha256,
      status: "unavailable",
      code: "CODEX_HOST_SCHEMA_UNSAFE",
    };
    expect(
      (await f.routed.recordCodexHost({ ...hostInput, taskSource: input })).ok,
    ).toBe(true);
    const saved = await f.store.load();
    expect(saved?.nativeHosts.codex?.taskSource?.evidence).toEqual(input);
    expect(saved?.nativeHosts.codex?.localVerification).not.toBeNull();
    expect(saved?.nativeHosts.taskRoute).toBeNull();
  });

  it("loads legacy hosts with null Task evidence and preserves unrelated settings", async () => {
    const f = await fixture();
    await f.service.recordCodexHost(hostInput);
    const saved = f.settings();
    const legacy = JSON.parse(JSON.stringify(saved));
    delete legacy.nativeHosts.codex.taskSource;
    const parsed = ProductSettingsSchema.parse(legacy);
    expect(parsed.nativeHosts.codex?.taskSource).toBeNull();
    expect(parsed.general).toEqual(saved.general);
    expect(parsed.computer).toEqual(saved.computer);
    await f.store.save(legacy);
    expect((await f.reload()).snapshot()).toEqual(f.service.snapshot());
    expect(
      CodexHostSelectionSchema.parse(legacy.nativeHosts.codex).taskSource,
    ).toBeNull();
  });

  it.each(["omitted", "null"])(
    "withdraws witnesses and an old route on the same host with %s evidence",
    async (mode) => {
      const f = await routedFixture();
      expect(
        (
          await f.routed.recordCodexHost(
            mode === "omitted" ? hostInput : { ...hostInput, taskSource: null },
          )
        ).ok,
      ).toBe(true);
      const saved = await f.store.load();
      expect(saved?.nativeHosts.codex?.taskSource).toBeNull();
      expect(saved?.nativeHosts.taskRoute).toBeNull();
      expect(saved?.nativeHosts.generation).toBe(
        f.saved.nativeHosts.generation + 1,
      );
      expect(saved?.nativeHosts.codex?.localVerification?.schemaSha256).toBe(
        hostInput.schemaSha256,
      );
    },
  );

  it("retains only an identical source/host/build route through refreshed local verification", async () => {
    const f = await routedFixture();
    f.advance();
    expect(
      (await f.routed.recordCodexHost({ ...hostInput, taskSource: evidence() }))
        .ok,
    ).toBe(true);
    const saved = await f.store.load();
    expect(saved?.nativeHosts.generation).toBe(f.saved.nativeHosts.generation);
    expect(saved?.nativeHosts.taskRoute).toEqual(f.saved.nativeHosts.taskRoute);
    expect(saved?.nativeHosts.codex?.taskSource?.localVerification).toEqual(
      saved?.nativeHosts.codex?.localVerification,
    );
    expect(
      saved?.nativeHosts.codex?.taskSource?.localVerification.verifiedAt,
    ).toBe("2026-10-04T10:00:00.000Z");
  });

  it.each(["handoff", "followup", "optional-loss", "build", "host"])(
    "withdraws the old route after %s drift",
    async (mode) => {
      const f = await routedFixture();
      const source = evidence();
      let input = {
        ...hostInput,
        taskSource: source,
        buildId: hostInput.buildId as string,
        executablePath: hostInput.executablePath as string,
      };
      if (
        mode === "handoff" &&
        source.handoff.status === "supported" &&
        source.followup.status === "supported"
      ) {
        source.handoff.contract.schemaSha256 = "f".repeat(64);
        source.followup.contract.baseSchemaSha256 = "f".repeat(64);
      }
      if (mode === "followup" && source.followup.status === "supported")
        source.followup.contract.schemaSha256 = "f".repeat(64);
      if (mode === "optional-loss") input.taskSource = evidence(false);
      if (mode === "build") input.buildId = "f".repeat(64);
      if (mode === "host") {
        input.executablePath = "/fixture/new/bin/codex";
        source.handoff.executablePath = input.executablePath;
        source.followup.executablePath = input.executablePath;
      }
      expect((await f.routed.recordCodexHost(input)).ok).toBe(true);
      const saved = await f.store.load();
      expect(saved?.nativeHosts.taskRoute).toBeNull();
      expect(saved?.nativeHosts.generation).toBe(
        f.saved.nativeHosts.generation + 1,
      );
      expect(saved?.nativeHosts.codex?.taskSource?.hostGeneration).toBe(
        saved?.nativeHosts.generation,
      );
      expect(saved?.nativeHosts.codex?.taskSource?.evidence).toEqual(
        input.taskSource,
      );
    },
  );

  it("withdraws source evidence after host recheck failure while retaining selected path", async () => {
    const f = await routedFixture();
    expect((await f.routed.recordCodexHostFailure("unreachable")).ok).toBe(
      true,
    );
    const saved = await f.store.load();
    expect(saved?.nativeHosts.codex?.taskSource).toBeNull();
    expect(saved?.nativeHosts.taskRoute).toBeNull();
    expect(saved?.nativeHosts.codex?.executablePath).toBe(
      hostInput.executablePath,
    );
    expect(saved?.nativeHosts.generation).toBe(
      f.saved.nativeHosts.generation + 1,
    );
  });

  it.each([
    "path",
    "binary",
    "base",
    "generation",
    "build",
    "local-time",
    "missing-local",
  ])("withdraws only stale Task evidence on reload: %s", async (mode) => {
    const f = await routedFixture();
    const changed = structuredClone(f.saved);
    const host = changed.nativeHosts.codex;
    if (!host?.taskSource || !host.localVerification)
      throw new Error("Missing fixture source");
    if (mode === "path") host.executablePath = "/fixture/changed";
    if (mode === "binary") host.executableSha256 = "f".repeat(64);
    if (mode === "base") host.schemaSha256 = "f".repeat(64);
    if (mode === "generation") changed.nativeHosts.generation++;
    if (mode === "build") host.localVerification.buildId = "f".repeat(64);
    if (mode === "local-time")
      host.localVerification.verifiedAt = "2026-10-04T10:00:00.000Z";
    if (mode === "missing-local") host.localVerification = null;
    await f.store.save(changed);
    const restarted = await f.reload();
    const snapshot = restarted.snapshot();
    expect(snapshot.status).toBe("ready");
    const saved = await f.store.load();
    expect(saved?.nativeHosts.codex?.taskSource).toBeNull();
    expect(saved?.nativeHosts.taskRoute).toBeNull();
    expect(saved?.computer).toEqual(changed.computer);
    expect(saved?.general).toEqual(changed.general);
    expect(saved?.nativeHosts.codex?.executablePath).toBe(host.executablePath);
  });

  it("contains stale Task evidence in memory even when targeted withdrawal cannot persist", async () => {
    const f = await routedFixture();
    const stale = structuredClone(f.saved);
    stale.nativeHosts.generation++;
    await f.store.save(stale);
    vi.spyOn(f.store, "save").mockRejectedValueOnce(
      new Error("fixture write refused"),
    );
    const snapshot = (await f.reload()).snapshot();
    expect(snapshot).toMatchObject({
      status: "ready",
      settings: {
        nativeHosts: { taskRoute: null, codex: { taskSource: null } },
      },
    });
  });

  it.each(["missing-source", "changed-source", "failed-recheck", "clear"])(
    "fences captured Task authority after %s cannot persist",
    async (mode) => {
      const f = await routedFixture();
      vi.spyOn(f.store, "save").mockRejectedValueOnce(
        new Error("fixture write refused"),
      );
      let result;
      if (mode === "missing-source")
        result = await f.routed.recordCodexHost(hostInput);
      else if (mode === "changed-source")
        result = await f.routed.recordCodexHost({
          ...hostInput,
          taskSource: evidence(false),
        });
      else if (mode === "failed-recheck")
        result = await f.routed.recordCodexHostFailure("unreachable");
      else result = await f.routed.clearCodexHost();
      expect(result).toMatchObject({
        ok: false,
        error: "SETTINGS_WRITE_FAILED",
        snapshot: {
          status: "ready",
          settings: {
            nativeHosts: { taskRoute: null, codex: { taskSource: null } },
          },
        },
      });
      const snapshot = f.routed.snapshot();
      expect(snapshot).toEqual(result.snapshot);
      if (snapshot.status !== "ready")
        throw new Error("Fixture settings missing");
      expect(snapshot.settings.computer).toEqual(f.saved.computer);
      expect(snapshot.settings.nativeHosts.generation).toBeGreaterThan(
        f.saved.nativeHosts.generation,
      );
      // No claim that failed persistence changed disk or a serving native host.
      expect((await f.store.load())?.nativeHosts).toEqual(f.saved.nativeHosts);
    },
  );

  it("fences Task evidence if host withdrawal lands but its readback fails", async () => {
    const f = await routedFixture();
    const load = f.store.load.bind(f.store);
    vi.spyOn(f.store, "load")
      .mockImplementationOnce(async () => null)
      .mockImplementation(load);
    const result = await f.routed.recordCodexHost({
      ...hostInput,
      taskSource: evidence(false),
    });
    expect(result).toMatchObject({
      ok: false,
      error: "SETTINGS_WRITE_FAILED",
      snapshot: {
        settings: {
          nativeHosts: { taskRoute: null, codex: { taskSource: null } },
        },
      },
    });
    expect(
      (await load())?.nativeHosts.codex?.taskSource?.evidence.followup.status,
    ).toBe("unavailable");
  });

  it("does not adopt newly written Task support when the first host readback fails", async () => {
    const f = await fixture();
    const load = f.store.load.bind(f.store);
    vi.spyOn(f.store, "load")
      .mockImplementationOnce(async () => null)
      .mockImplementation(load);
    const result = await f.service.recordCodexHost({
      ...hostInput,
      taskSource: evidence(),
    });
    expect(result).toMatchObject({
      ok: false,
      error: "SETTINGS_WRITE_FAILED",
      snapshot: {
        settings: {
          nativeHosts: { taskRoute: null, codex: { taskSource: null } },
        },
      },
    });
    expect(
      (await load())?.nativeHosts.codex?.taskSource?.evidence.handoff.status,
    ).toBe("supported");
    vi.spyOn(f.store, "save").mockRejectedValueOnce(
      new Error("fixture write refused"),
    );
    expect(
      await f.service.updateGeneral({
        ...f.settings().general,
        openAtLaunch: "activity",
      }),
    ).toMatchObject({
      ok: false,
      snapshot: {
        settings: {
          nativeHosts: { taskRoute: null, codex: { taskSource: null } },
        },
      },
    });
  });

  it.each(["host", "ordinary", "initialize"])(
    "keeps the withdrawal fence through a later %s recovery of old disk bytes",
    async (mode) => {
      const f = await routedFixture();
      vi.spyOn(f.store, "save").mockRejectedValue(
        new Error("fixture write refused"),
      );
      expect((await f.routed.recordCodexHost(hostInput)).ok).toBe(false);
      const first = f.routed.snapshot();
      if (first.status !== "ready") throw new Error("Fixture settings missing");
      if (mode === "host")
        expect((await f.routed.recordCodexHost(hostInput)).ok).toBe(false);
      else if (mode === "ordinary")
        expect(
          (
            await f.routed.updateGeneral({
              ...f.saved.general,
              openAtLaunch: "activity",
            })
          ).ok,
        ).toBe(false);
      else await f.routed.initialize();
      const second = f.routed.snapshot();
      expect(second).toMatchObject({
        status: "ready",
        settings: {
          nativeHosts: { taskRoute: null, codex: { taskSource: null } },
        },
      });
      if (second.status !== "ready")
        throw new Error("Fixture settings missing");
      expect(second.settings.nativeHosts.generation).toBeGreaterThanOrEqual(
        first.settings.nativeHosts.generation,
      );
      expect((await f.store.load())?.nativeHosts).toEqual(f.saved.nativeHosts);
    },
  );

  it("does not release the fence after an ordinary successful settings write", async () => {
    const f = await routedFixture();
    vi.spyOn(f.store, "save").mockRejectedValueOnce(
      new Error("fixture write refused"),
    );
    await f.routed.recordCodexHost(hostInput);
    expect(
      (
        await f.routed.updateGeneral({
          ...f.saved.general,
          openAtLaunch: "activity",
        })
      ).ok,
    ).toBe(true);
    await f.store.save(f.saved); // Synthetic external stale readback; no real writer or authority.
    vi.spyOn(f.store, "save").mockRejectedValueOnce(
      new Error("fixture write refused"),
    );
    const failed = await f.routed.updateGeneral(f.saved.general);
    expect(failed).toMatchObject({
      ok: false,
      snapshot: {
        settings: {
          nativeHosts: { taskRoute: null, codex: { taskSource: null } },
        },
      },
    });
  });

  it("releases the in-process fence only after a trusted host write with exact readback", async () => {
    const f = await routedFixture();
    vi.spyOn(f.store, "save").mockRejectedValueOnce(
      new Error("fixture write refused"),
    );
    await f.routed.recordCodexHost(hostInput);
    const fenced = f.routed.snapshot();
    if (fenced.status !== "ready") throw new Error("Fixture settings missing");
    const restored = await f.routed.recordCodexHost({
      ...hostInput,
      taskSource: evidence(),
    });
    expect(restored).toMatchObject({
      ok: true,
      snapshot: {
        settings: {
          nativeHosts: {
            taskRoute: null,
            codex: { taskSource: { evidence: evidence() } },
          },
        },
      },
    });
    if (restored.snapshot.status !== "ready")
      throw new Error("Fixture settings missing");
    expect(restored.snapshot.settings.nativeHosts.generation).toBeGreaterThan(
      fenced.settings.nativeHosts.generation,
    );
  });

  it("rejects partial support after a whole-snapshot source change", async () => {
    const f = await fixture();
    const source = evidence(false);
    if (source.followup.status !== "unavailable")
      throw new Error("Fixture follow-up missing");
    source.followup.code = "CODEX_HOST_TASK_SOURCE_CHANGED";
    expect(CodexTaskSourceSchema.safeParse(source).success).toBe(false);
    expect(
      await f.service.recordCodexHost({ ...hostInput, taskSource: source }),
    ).toMatchObject({ ok: false, error: "SETTINGS_INPUT_INVALID" });
    source.handoff = {
      executablePath: hostInput.executablePath,
      executableSha256: hostInput.executableSha256,
      baseSchemaSha256: hostInput.schemaSha256,
      status: "unavailable",
      code: "CODEX_HOST_TASK_SOURCE_CHANGED",
    };
    expect(
      (await f.service.recordCodexHost({ ...hostInput, taskSource: source }))
        .ok,
    ).toBe(true);
  });

  it.each(["path", "binary", "base", "version"])(
    "rejects otherwise shaped witness bound to a different %s",
    async (mode) => {
      const f = await fixture();
      const source = evidence();
      if (mode === "path")
        source.handoff.executablePath = source.followup.executablePath =
          "/fixture/other";
      if (mode === "binary")
        source.handoff.executableSha256 = source.followup.executableSha256 =
          "f".repeat(64);
      if (mode === "base")
        source.handoff.baseSchemaSha256 = source.followup.baseSchemaSha256 =
          "f".repeat(64);
      if (mode === "version" && source.handoff.status === "supported")
        source.handoff.contract.version = "0.200.0";
      const before = f.service.snapshot();
      expect(
        await f.service.recordCodexHost({ ...hostInput, taskSource: source }),
      ).toMatchObject({ ok: false, error: "SETTINGS_INPUT_INVALID" });
      expect(f.service.snapshot()).toEqual(before);
    },
  );

  it.each([
    "base-substitution",
    "followup-link",
    "followup-substitution",
    "unsupported-handoff",
    "unknown-field",
    "unknown-code",
    "unknown-status",
    "false-capability",
  ])(
    "strictly rejects %s evidence without manufacturing Task support",
    async (mode) => {
      const f = await fixture();
      const source = JSON.parse(JSON.stringify(evidence()));
      if (mode === "base-substitution")
        source.handoff.contract.schemaSha256 = hostInput.schemaSha256;
      if (mode === "followup-link")
        source.followup.contract.baseSchemaSha256 = hostInput.schemaSha256;
      if (mode === "followup-substitution")
        source.followup.contract.schemaSha256 =
          source.handoff.contract.schemaSha256;
      if (mode === "unsupported-handoff") {
        source.handoff.status = "unavailable";
        delete source.handoff.contract;
        source.handoff.code = "CODEX_HOST_HANDOFF_UNAVAILABLE";
      }
      if (mode === "unknown-field") source.followup.servingGrant = true;
      if (mode === "unknown-code") {
        source.followup.status = "unavailable";
        delete source.followup.contract;
        source.followup.code = "unknown";
      }
      if (mode === "unknown-status") source.followup.status = "ready";
      if (mode === "false-capability")
        source.handoff.contract.projectBoundCreateStatus = false;
      expect(CodexTaskSourceSchema.safeParse(source).success).toBe(false);
      expect(
        await f.service.recordCodexHost({ ...hostInput, taskSource: source }),
      ).toMatchObject({ ok: false, error: "SETTINGS_INPUT_INVALID" });
    },
  );
});
