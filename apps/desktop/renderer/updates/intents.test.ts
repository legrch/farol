import { describe, expect, it, vi } from "vitest";
import type { InstalledUpdateView } from "../../../../src/modules/release/contract/installed-update";
import type {
  Intent,
  RendererFacade,
  WindowSnapshot,
} from "../../../../src/ui/renderer/contract";
import { initial } from "../snapshot";
import { createUpdateIntents } from "./intents";

type Command = Readonly<{ kind: string; [key: string]: unknown }>;

const idle: InstalledUpdateView = { phase: "idle", checkedAt: null };
const available: Extract<InstalledUpdateView, { phase: "available" }> = {
  phase: "available",
  version: "1.2.3",
  deferred: false,
};
const ready: InstalledUpdateView = {
  phase: "ready",
  version: "1.2.3",
  deferred: false,
  blockedBy: null,
};
const autoOn = {
  status: "confirmed",
  enabled: true,
  scope: "download-and-install",
} as const;
const autoOff = {
  status: "confirmed",
  enabled: false,
  scope: "download-and-install",
} as const;
const quitOn = {
  status: "confirmed",
  enabled: true,
  scope: "install-on-normal-quit",
} as const;
const quitOff = {
  status: "confirmed",
  enabled: false,
  scope: "install-on-normal-quit",
} as const;

function snapshotWith(
  update: InstalledUpdateView,
  intents: Record<string, Intent> = {},
): WindowSnapshot {
  return {
    ...initial,
    status: "current",
    environment: "preview",
    runtime: "ready",
    buildId: "3".repeat(64),
    update,
    intents,
  };
}

function harness(
  start: WindowSnapshot,
  options: { tracked?: boolean; reply?: (command: Command) => unknown } = {},
) {
  const world = {
    state: start,
    revision: 0,
    adopted: [] as unknown[],
    calls: [] as { command: Command; operationId: unknown }[],
    settled: [] as unknown[],
    dispatched: [] as { key: string; payload: unknown }[],
    reply: options.reply ?? ((): unknown => idle),
  };
  const api = {
    installedUpdate: vi.fn(async (command: Command, operationId?: string) => {
      world.calls.push({ command, operationId });
      return world.reply(command);
    }),
    ...(options.tracked === false
      ? {}
      : {
          settleUpdateDirect: vi.fn((settlement: unknown) => {
            world.settled.push(settlement);
          }),
        }),
  };
  const intents = createUpdateIntents({
    api: api as never,
    snapshot: () => world.state,
    dispatch: async (key, payload, run) => {
      world.dispatched.push({ key, payload });
      return run();
    },
    adopt: (value) => {
      // The controller's adoption advances the one shared counter.
      world.revision++;
      world.adopted.push(value);
    },
    revision: () => world.revision,
  });
  return { world, api, intents };
}

const refused = (id: string, code: string): Intent => ({
  id,
  state: "refused",
  code,
});

describe("update intent", () => {
  it.each(["rollback", "recover"] as const)(
    "refuses the retired %s command locally without any effect",
    async (action) => {
      const { world, api, intents } = harness(snapshotWith(idle));
      expect(await intents.update(action)).toEqual(
        refused("update", "UPDATE_FORWARD_ONLY"),
      );
      expect(api.installedUpdate).not.toHaveBeenCalled();
      expect(world.dispatched).toEqual([]);
      expect(world.settled).toEqual([]);
    },
  );

  it.each([
    ["download", idle, "UPDATE_NOT_AVAILABLE"],
    ["skip", ready, "UPDATE_NOT_AVAILABLE"],
    ["restart", available, "UPDATE_NOT_READY"],
    [
      "restart",
      { ...ready, blockedBy: "UPDATE_WORK_PENDING" },
      "UPDATE_NOT_READY",
    ],
  ] as const)(
    "refuses %s from %j before dispatch",
    async (action, update, code) => {
      const { api, world, intents } = harness(snapshotWith(update));
      expect(await intents.update(action)).toEqual(refused("update", code));
      expect(api.installedUpdate).not.toHaveBeenCalled();
      expect(world.dispatched).toEqual([]);
    },
  );

  it("refuses a confirmed restart for another version or a blocked state", async () => {
    const wrongVersion = harness(snapshotWith(ready));
    expect(
      await wrongVersion.intents.update("restart-confirmed", "9.9.9"),
    ).toEqual(refused("update", "UPDATE_NOT_READY"));
    const blocked = harness(
      snapshotWith({ ...ready, blockedBy: "UPDATE_RELEASE_STATE_UNKNOWN" }),
    );
    expect(await blocked.intents.update("restart-confirmed", "1.2.3")).toEqual(
      refused("update", "UPDATE_NOT_READY"),
    );
    const notReady = harness(snapshotWith(available));
    expect(await notReady.intents.update("restart-confirmed", "1.2.3")).toEqual(
      refused("update", "UPDATE_NOT_READY"),
    );
    for (const h of [wrongVersion, blocked, notReady])
      expect(h.api.installedUpdate).not.toHaveBeenCalled();
  });

  it("sends a confirmed restart with its version and adopts the reply", async () => {
    const { world, intents } = harness(snapshotWith(ready), {
      reply: () => ({ phase: "applying", version: "1.2.3" }),
    });
    expect(await intents.update("restart-confirmed", "1.2.3")).toEqual({
      id: "update",
      state: "applied",
      code: null,
    });
    expect(world.calls).toHaveLength(1);
    expect(world.calls[0]!.command).toEqual({
      kind: "restart-confirmed",
      version: "1.2.3",
    });
    expect(world.adopted).toEqual([{ phase: "applying", version: "1.2.3" }]);
    expect(world.dispatched[0]).toEqual({
      key: "update",
      payload: { action: "restart-confirmed", version: "1.2.3" },
    });
  });

  it("binds the command to a fresh operation ID and settles it as applied", async () => {
    const { world, intents } = harness(snapshotWith(idle));
    const result = await intents.update("check");
    expect(result).toEqual({ id: "update", state: "applied", code: null });
    const operationId = world.calls[0]!.operationId;
    expect(typeof operationId).toBe("string");
    expect(world.calls[0]!.command).toEqual({ kind: "check" });
    expect(world.settled).toEqual([{ operationId, outcome: "applied" }]);
    await intents.update("check");
    expect(world.calls[1]!.operationId).not.toBe(operationId);
  });

  it("calls the bridge with the command alone when it cannot track settlement", async () => {
    const { api, world, intents } = harness(snapshotWith(idle), {
      tracked: false,
    });
    await intents.update("check");
    expect(api.installedUpdate.mock.calls[0]).toEqual([{ kind: "check" }]);
    expect(world.settled).toEqual([]);
  });

  it("does not settle an operation whose intent is still pending", async () => {
    const world = harness(snapshotWith(idle));
    const intents = createUpdateIntents({
      api: world.api as never,
      snapshot: () => world.world.state,
      dispatch: async (key, _payload, run) => {
        await run();
        return { id: key, state: "pending", code: null };
      },
      adopt: () => {},
      revision: () => 0,
    });
    expect((await intents.update("check")).state).toBe("pending");
    expect(world.api.installedUpdate).toHaveBeenCalledTimes(1);
    expect(world.world.settled).toEqual([]);
  });

  it("settles a refused or unknown outcome as such", async () => {
    const failed = harness(snapshotWith(idle), {
      reply: () => ({
        phase: "failed",
        code: "UPDATE_DOWNLOAD_FAILED",
        recoveryRequired: false,
      }),
    });
    expect(await failed.intents.update("check")).toEqual(
      refused("update", "UPDATE_DOWNLOAD_FAILED"),
    );
    expect(failed.world.settled).toEqual([
      { operationId: failed.world.calls[0]!.operationId, outcome: "refused" },
    ]);
    const unknown = harness(snapshotWith(idle), {
      reply: () => ({
        phase: "failed",
        code: "UPDATE_APPLY_UNKNOWN",
        recoveryRequired: false,
      }),
    });
    expect(await unknown.intents.update("check")).toEqual({
      id: "update",
      state: "unknown",
      code: "UPDATE_APPLY_UNKNOWN",
    });
    expect(unknown.world.settled).toEqual([
      { operationId: unknown.world.calls[0]!.operationId, outcome: "unknown" },
    ]);
  });

  it("maps an unavailable reply to a refusal carrying its code", async () => {
    const { intents } = harness(snapshotWith(idle), {
      reply: () => ({
        phase: "unavailable",
        code: "UPDATE_STATUS_UNAVAILABLE",
      }),
    });
    expect(await intents.update("check")).toEqual(
      refused("update", "UPDATE_STATUS_UNAVAILABLE"),
    );
  });

  it("reports an unparsable reply as unknown and adopts nothing", async () => {
    const { world, intents } = harness(snapshotWith(idle), {
      reply: () => ({ phase: "bogus" }),
    });
    expect(await intents.update("check")).toEqual({
      id: "update",
      state: "unknown",
      code: "UPDATE_OUTCOME_UNKNOWN",
    });
    expect(world.adopted).toEqual([]);
    expect(world.settled).toEqual([
      { operationId: world.calls[0]!.operationId, outcome: "unknown" },
    ]);
  });

  it("drops a reply that a newer observation has overtaken", async () => {
    const { world, intents } = harness(snapshotWith(idle), {
      reply: () => {
        // A newer update observation is adopted while the command is awaited.
        world.revision++;
        return { phase: "checking" };
      },
    });
    expect(await intents.update("check")).toEqual({
      id: "update",
      state: "applied",
      code: null,
    });
    expect(world.adopted).toEqual([]);
  });

  it("reads the shared revision after the dispatch, not a copy", async () => {
    // The command is not started until the dispatcher runs it; a revision
    // advanced before that is the baseline, one advanced after is a fence.
    const { world, intents } = harness(snapshotWith(idle));
    world.revision = 7;
    await intents.update("check");
    expect(world.adopted).toHaveLength(1);
    expect(world.revision).toBe(8);
  });
});

describe("notice-seen update intent", () => {
  type Available = Extract<InstalledUpdateView, { phase: "available" }>;
  const noticed = (
    overrides: Partial<{ seen: boolean; blockedBy: string | null }> = {},
  ): Available => ({
    ...available,
    notice: { key: "n-1", seen: false, blockedBy: null, ...overrides },
  });
  const seen = (
    update: Available,
    overrides: Partial<{ blockedBy: string | null }> = {},
  ): Available => ({
    ...update,
    notice: { key: "n-1", seen: true, blockedBy: null, ...overrides },
  });

  it.each([
    ["no notice", snapshotWith(available), "n-1"],
    ["another key", snapshotWith(noticed()), "other"],
    ["already seen", snapshotWith(noticed({ seen: true })), "n-1"],
    [
      "blocked",
      snapshotWith(noticed({ blockedBy: "UPDATE_WORK_PENDING" })),
      "n-1",
    ],
    [
      "a pending update intent",
      snapshotWith(noticed(), {
        update: { id: "update", state: "pending", code: null },
      }),
      "n-1",
    ],
    [
      "a retained unknown update intent",
      snapshotWith(noticed(), {
        update: { id: "update", state: "unknown", code: "X" },
      }),
      "n-1",
    ],
    [
      "a failed unknown state",
      snapshotWith({
        phase: "failed",
        code: "UPDATE_APPLY_UNKNOWN",
        recoveryRequired: false,
        notice: { key: "n-1", seen: false, blockedBy: null },
      }),
      "n-1",
    ],
  ])("refuses locally for %s", async (_name, snapshot, key) => {
    const { api, world, intents } = harness(snapshot);
    expect(await intents.update("notice-seen", key)).toEqual(
      refused("update-notice", "UPDATE_NOTICE_NOT_AVAILABLE"),
    );
    expect(api.installedUpdate).not.toHaveBeenCalled();
    expect(world.dispatched).toEqual([]);
  });

  it("acknowledges the bound notice and adopts the matching reply", async () => {
    const before = noticed();
    const { world, intents } = harness(snapshotWith(before), {
      reply: () => seen(before),
    });
    expect(await intents.update("notice-seen", "n-1")).toEqual({
      id: "update-notice",
      state: "applied",
      code: null,
    });
    expect(world.calls[0]!.command).toEqual({
      kind: "notice-seen",
      noticeKey: "n-1",
    });
    expect(world.dispatched[0]).toEqual({
      key: "update-notice",
      payload: { action: "notice-seen", noticeKey: "n-1" },
    });
    expect(world.adopted).toEqual([seen(before)]);
  });

  it("is unknown when the reply moved anything but the notice", async () => {
    const before = noticed();
    const { world, intents } = harness(snapshotWith(before), {
      reply: () => seen({ ...available, version: "9.9.9" }),
    });
    expect(await intents.update("notice-seen", "n-1")).toEqual({
      id: "update-notice",
      state: "unknown",
      code: "UPDATE_NOTICE_OUTCOME_UNKNOWN",
    });
    expect(world.adopted).toEqual([]);
  });

  it("is unknown for an unparsable reply or another notice key", async () => {
    const before = noticed();
    const bad = harness(snapshotWith(before), { reply: () => null });
    expect((await bad.intents.update("notice-seen", "n-1")).code).toBe(
      "UPDATE_NOTICE_OUTCOME_UNKNOWN",
    );
    const other = harness(snapshotWith(before), {
      reply: () => ({
        ...before,
        notice: { key: "n-2", seen: true, blockedBy: null },
      }),
    });
    expect((await other.intents.update("notice-seen", "n-1")).state).toBe(
      "unknown",
    );
  });

  it("maps a blocked or unacknowledged reply to refusal and an unknown block to unknown", async () => {
    const before = noticed();
    const blocked = harness(snapshotWith(before), {
      reply: () => seen(before, { blockedBy: "UPDATE_WORK_PENDING" }),
    });
    expect(await blocked.intents.update("notice-seen", "n-1")).toEqual(
      refused("update-notice", "UPDATE_WORK_PENDING"),
    );
    const unknownBlock = harness(snapshotWith(before), {
      reply: () => seen(before, { blockedBy: "UPDATE_STATE_UNKNOWN" }),
    });
    expect(await unknownBlock.intents.update("notice-seen", "n-1")).toEqual({
      id: "update-notice",
      state: "unknown",
      code: "UPDATE_STATE_UNKNOWN",
    });
    const notSeen = harness(snapshotWith(before), { reply: () => before });
    expect(await notSeen.intents.update("notice-seen", "n-1")).toEqual(
      refused("update-notice", "UPDATE_NOTICE_NOT_ACKNOWLEDGED"),
    );
  });

  it("settles from the reply but does not adopt it after a newer observation", async () => {
    const before = noticed();
    const { world, intents } = harness(snapshotWith(before), {
      reply: () => {
        world.revision++;
        return seen(before);
      },
    });
    expect((await intents.update("notice-seen", "n-1")).state).toBe("applied");
    expect(world.adopted).toEqual([]);
    expect(world.settled).toEqual([
      { operationId: world.calls[0]!.operationId, outcome: "applied" },
    ]);
  });
});

describe("automatic downloads intent", () => {
  const key = "update-automatic-downloads";
  const on = (enabled: boolean): InstalledUpdateView => ({
    ...idle,
    automaticUpdatePreference: enabled ? autoOn : autoOff,
  });

  it("refuses while the preference is unavailable", async () => {
    const { api, world, intents } = harness(snapshotWith(idle));
    expect(await intents.setAutomaticDownloads(true)).toEqual(
      refused(key, "UPDATE_AUTOMATIC_PREFERENCE_UNAVAILABLE"),
    );
    expect(api.installedUpdate).not.toHaveBeenCalled();
    expect(world.dispatched).toEqual([]);
  });

  it("answers an already confirmed preference without an effect", async () => {
    const { api, intents } = harness(snapshotWith(on(true)));
    expect(await intents.setAutomaticDownloads(true)).toEqual({
      id: key,
      state: "applied",
      code: null,
    });
    expect(api.installedUpdate).not.toHaveBeenCalled();
  });

  it("sends the change, adopts the confirmed reply and settles applied", async () => {
    const { world, intents } = harness(snapshotWith(on(false)), {
      reply: () => on(true),
    });
    expect(await intents.setAutomaticDownloads(true)).toEqual({
      id: key,
      state: "applied",
      code: null,
    });
    expect(world.calls[0]!.command).toEqual({
      kind: "set-automatic-update-preference",
      enabled: true,
      scope: "download-and-install",
    });
    expect(world.dispatched[0]).toEqual({ key, payload: true });
    expect(world.adopted).toEqual([on(true)]);
    expect(world.settled).toEqual([
      { operationId: world.calls[0]!.operationId, outcome: "applied" },
    ]);
  });

  it("maps a blocked, unknown, mismatched or missing acknowledgement", async () => {
    const blocked = harness(snapshotWith(on(false)), {
      reply: () => ({
        ...idle,
        automaticUpdatePreference: {
          status: "blocked",
          enabled: false,
          code: "UPDATE_BUSY",
        },
      }),
    });
    expect(await blocked.intents.setAutomaticDownloads(true)).toEqual(
      refused(key, "UPDATE_BUSY"),
    );
    const unknown = harness(snapshotWith(on(false)), {
      reply: () => ({
        ...idle,
        automaticUpdatePreference: {
          status: "unknown",
          enabled: false,
          code: "UPDATE_PREF_UNKNOWN",
        },
      }),
    });
    expect(await unknown.intents.setAutomaticDownloads(true)).toEqual({
      id: key,
      state: "unknown",
      code: "UPDATE_PREF_UNKNOWN",
    });
    const mismatch = harness(snapshotWith(on(false)), {
      reply: () => on(false),
    });
    expect(await mismatch.intents.setAutomaticDownloads(true)).toEqual({
      id: key,
      state: "unknown",
      code: "UPDATE_AUTOMATIC_PREFERENCE_ACK_MISMATCH",
    });
    const missing = harness(snapshotWith(on(false)), { reply: () => idle });
    expect(await missing.intents.setAutomaticDownloads(true)).toEqual({
      id: key,
      state: "unknown",
      code: "UPDATE_AUTOMATIC_PREFERENCE_OUTCOME_UNKNOWN",
    });
    expect(missing.world.adopted).toEqual([]);
  });

  it("drops a reply overtaken by a newer observation but still answers it", async () => {
    const { world, intents } = harness(snapshotWith(on(false)), {
      reply: () => {
        world.revision++;
        return on(true);
      },
    });
    expect((await intents.setAutomaticDownloads(true)).state).toBe("applied");
    expect(world.adopted).toEqual([]);
  });
});

describe("install on quit intent", () => {
  const key = "update-install-on-quit";
  const facade = {
    setInstallOnQuitPreference: () => undefined,
  } as unknown as RendererFacade;
  const withQuit = (enabled: boolean): InstalledUpdateView => ({
    ...idle,
    installOnQuitPreference: enabled ? quitOn : quitOff,
  });

  it("returns a retained unknown outcome without a new effect", async () => {
    const retained: Intent = { id: key, state: "unknown", code: "UPDATE_X" };
    const { api, world, intents } = harness(
      snapshotWith(withQuit(false), { [key]: retained }),
    );
    expect(await intents.setInstallOnQuitPreference(true, facade)).toBe(
      retained,
    );
    expect(api.installedUpdate).not.toHaveBeenCalled();
    expect(world.dispatched).toEqual([]);
  });

  it("refuses a non-boolean value, an ineligible snapshot and a facade without the setter", async () => {
    const wrong = harness(snapshotWith(withQuit(false)));
    expect(
      await wrong.intents.setInstallOnQuitPreference("yes" as never, facade),
    ).toEqual(refused(key, "UPDATE_QUIT_PREFERENCE_UNAVAILABLE"));
    const ineligible = harness(snapshotWith(idle));
    expect(
      await ineligible.intents.setInstallOnQuitPreference(true, facade),
    ).toEqual(refused(key, "UPDATE_QUIT_PREFERENCE_UNAVAILABLE"));
    const bare = harness(snapshotWith(withQuit(false)));
    expect(
      await bare.intents.setInstallOnQuitPreference(true, {} as never),
    ).toEqual(refused(key, "UPDATE_QUIT_PREFERENCE_UNAVAILABLE"));
    for (const h of [wrong, ineligible, bare]) {
      expect(h.api.installedUpdate).not.toHaveBeenCalled();
      expect(h.world.dispatched).toEqual([]);
    }
  });

  it("refuses while another update command is pending", async () => {
    const { api, intents } = harness(
      snapshotWith(withQuit(false), {
        [key]: { id: key, state: "pending", code: null },
      }),
    );
    expect((await intents.setInstallOnQuitPreference(true, facade)).code).toBe(
      "UPDATE_QUIT_PREFERENCE_UNAVAILABLE",
    );
    expect(api.installedUpdate).not.toHaveBeenCalled();
  });

  it("answers the already selected value without an effect", async () => {
    const { api, intents } = harness(snapshotWith(withQuit(true)));
    expect(await intents.setInstallOnQuitPreference(true, facade)).toEqual({
      id: key,
      state: "applied",
      code: null,
    });
    expect(api.installedUpdate).not.toHaveBeenCalled();
  });

  it("sends the change, adopts the confirmed reply and settles applied", async () => {
    const { world, intents } = harness(snapshotWith(withQuit(false)), {
      reply: () => withQuit(true),
    });
    expect(await intents.setInstallOnQuitPreference(true, facade)).toEqual({
      id: key,
      state: "applied",
      code: null,
    });
    expect(world.calls[0]!.command).toEqual({
      kind: "set-install-on-quit-preference",
      enabled: true,
    });
    expect(world.adopted).toEqual([withQuit(true)]);
    expect(world.settled).toEqual([
      { operationId: world.calls[0]!.operationId, outcome: "applied" },
    ]);
  });

  it("re-checks eligibility after the dispatch await and refuses without an effect", async () => {
    const { api, world } = harness(snapshotWith(withQuit(false)));
    const intents = createUpdateIntents({
      api: api as never,
      snapshot: () => world.state,
      dispatch: async (_key, _payload, run) => {
        // The digest await delivered a state that no longer admits the change.
        world.state = snapshotWith(withQuit(false), {
          "update-automatic-downloads": {
            id: "update-automatic-downloads",
            state: "pending",
            code: null,
          },
        });
        return run();
      },
      adopt: () => {},
      revision: () => world.revision,
    });
    expect(await intents.setInstallOnQuitPreference(true, facade)).toEqual(
      refused(key, "UPDATE_QUIT_PREFERENCE_UNAVAILABLE"),
    );
    expect(api.installedUpdate).not.toHaveBeenCalled();
  });

  it("maps blocked, unknown, mismatched and missing acknowledgements", async () => {
    const blocked = harness(snapshotWith(withQuit(false)), {
      reply: () => ({
        ...idle,
        installOnQuitPreference: {
          status: "blocked",
          enabled: false,
          code: "UPDATE_BUSY",
        },
      }),
    });
    expect(
      await blocked.intents.setInstallOnQuitPreference(true, facade),
    ).toEqual(refused(key, "UPDATE_BUSY"));
    const unknown = harness(snapshotWith(withQuit(false)), {
      reply: () => ({
        ...idle,
        installOnQuitPreference: {
          status: "unknown",
          enabled: false,
          code: "UPDATE_Q_UNKNOWN",
        },
      }),
    });
    expect(
      await unknown.intents.setInstallOnQuitPreference(true, facade),
    ).toEqual({
      id: key,
      state: "unknown",
      code: "UPDATE_Q_UNKNOWN",
    });
    const mismatch = harness(snapshotWith(withQuit(false)), {
      reply: () => withQuit(false),
    });
    expect(
      await mismatch.intents.setInstallOnQuitPreference(true, facade),
    ).toEqual({
      id: key,
      state: "unknown",
      code: "UPDATE_QUIT_PREFERENCE_ACK_MISMATCH",
    });
    const missing = harness(snapshotWith(withQuit(false)), {
      reply: () => idle,
    });
    expect(
      await missing.intents.setInstallOnQuitPreference(true, facade),
    ).toEqual({
      id: key,
      state: "unknown",
      code: "UPDATE_QUIT_PREFERENCE_OUTCOME_UNKNOWN",
    });
    expect(missing.world.adopted).toEqual([]);
  });

  it("drops a reply overtaken by a newer observation but still answers it", async () => {
    const { world, intents } = harness(snapshotWith(withQuit(false)), {
      reply: () => {
        world.revision++;
        return withQuit(true);
      },
    });
    expect((await intents.setInstallOnQuitPreference(true, facade)).state).toBe(
      "applied",
    );
    expect(world.adopted).toEqual([]);
  });
});

describe("check on open", () => {
  it.each([
    [
      "a pending update intent",
      { update: { id: "update", state: "pending", code: null } },
      idle,
    ],
    [
      "a retained unknown update intent",
      { update: { id: "update", state: "unknown", code: "X" } },
      idle,
    ],
    [
      "a failed unknown state",
      {},
      {
        phase: "failed",
        code: "UPDATE_APPLY_UNKNOWN",
        recoveryRequired: false,
      },
    ],
    ["a download in progress", {}, { phase: "downloading" }],
    ["a check in progress", {}, { phase: "checking" }],
  ] as const)(
    "observes only, without a check, for %s",
    async (_name, intents, update) => {
      const {
        api,
        world,
        intents: updates,
      } = harness(
        snapshotWith(update as InstalledUpdateView, intents as never),
      );
      expect(updates.checkOnOpen()).toBeUndefined();
      expect(api.installedUpdate).not.toHaveBeenCalled();
      expect(world.dispatched).toEqual([]);
    },
  );

  it.each([
    ["idle", idle],
    ["available", available],
    [
      "a recheckable block",
      { ...ready, blockedBy: "UPDATE_WORK_PENDING" } as InstalledUpdateView,
    ],
  ])("checks from %s", async (_name, update) => {
    const { world, intents } = harness(snapshotWith(update));
    const result = intents.checkOnOpen();
    expect(result).toBeInstanceOf(Promise);
    await result;
    expect(world.calls.map((call) => call.command)).toEqual([
      { kind: "check" },
    ]);
  });

  it("checks at once when the surface opens after boot", async () => {
    const { world, intents } = harness(snapshotWith(idle));
    intents.requestCheckOnOpen(false);
    await vi.waitFor(() => expect(world.calls).toHaveLength(1));
  });

  it("defers the check while booting and runs it exactly once afterwards", async () => {
    const { world, intents } = harness(snapshotWith(idle));
    intents.requestCheckOnOpen(true);
    expect(world.calls).toEqual([]);
    await intents.settlePendingCheck(false);
    expect(world.calls).toHaveLength(1);
    await intents.settlePendingCheck(false);
    expect(world.calls).toHaveLength(1);
  });

  it("settles nothing when no check was requested", async () => {
    const { world, intents } = harness(snapshotWith(idle));
    await intents.settlePendingCheck(false);
    expect(world.calls).toEqual([]);
  });

  it("keeps the request while disposed and honours it only for a live window", async () => {
    const { world, intents } = harness(snapshotWith(idle));
    intents.requestCheckOnOpen(true);
    await intents.settlePendingCheck(true);
    expect(world.calls).toEqual([]);
    await intents.settlePendingCheck(false);
    expect(world.calls).toHaveLength(1);
  });

  it("still applies the open-time guards to a deferred check", async () => {
    const { world, intents } = harness(snapshotWith(idle));
    intents.requestCheckOnOpen(true);
    world.state = snapshotWith(idle, {
      update: { id: "update", state: "pending", code: null },
    });
    await intents.settlePendingCheck(false);
    expect(world.calls).toEqual([]);
  });
});
