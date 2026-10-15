import { describe, expect, it, vi } from "vitest";
import { BridgeError } from "../../apps/desktop/bridge/client.ts";
import {
  TaskCurrentSettingsBridge,
  taskSettingsFacts,
} from "../../apps/desktop/bridge/task-current-settings.ts";
import type { Context, Json, Outcome } from "../../apps/desktop/bridge/wire.ts";
import { currentTaskSettingsFixture } from "../fixtures/task-settings-cases.ts";

const context: Context = {
  profileId: "fixture-profile",
  backendGeneration: "fixture-generation",
};

function fixture(change: (out: Outcome) => Outcome = (out) => out) {
  let current = { ...context };
  const request = vi.fn(
    async (
      _method: string,
      body: Json,
      options?: { id?: string },
    ): Promise<Outcome> => {
      const revisions = body as {
        beforeRevision: string;
        candidateRevision: string;
      };
      return change({
        status: "ok",
        context: { ...context },
        requestId: options!.id!,
        data: {
          beforeRevision: revisions.beforeRevision,
          candidateRevision: revisions.candidateRevision,
          changed: true,
        },
      });
    },
  );
  return {
    request,
    bridge: new TaskCurrentSettingsBridge({
      request,
      get verifiedContext() {
        return current;
      },
    }),
    successor: () => {
      current = { ...context, backendGeneration: "successor" };
    },
  };
}

describe("Go Task current-settings transport", () => {
  it("captures both complete fact sets and revisions before its single read", async () => {
    const f = fixture();
    const before = currentTaskSettingsFixture();
    const candidate = structuredClone(before);
    candidate.revision++;
    const expectedBefore = taskSettingsFacts(before);
    const expectedCandidate = taskSettingsFacts(candidate);
    const pending = f.bridge.compare(before, candidate);
    before.nativeHosts.taskRoute!.socketPath = "/changed-after-call";
    candidate.tasks = null;
    expect(await pending).toBe(true);
    expect(f.request).toHaveBeenCalledOnce();
    const [method, body, options] = f.request.mock.calls[0]!;
    expect(method).toBe("task.settings.compare");
    expect(body).toEqual({
      beforeRevision: "1",
      candidateRevision: "2",
      before: JSON.stringify(expectedBefore),
      candidate: JSON.stringify(expectedCandidate),
    });
    expect(options).not.toHaveProperty("operationId");
    expect(
      JSON.parse((body as { before: string }).before).computer.workspaces[0]
        .rootIdentity,
    ).toEqual({
      device: "18446744073709551615",
      inode: "9007199254740993",
    });
  });

  it("maps unsorted and unselected workspace facts without deciding policy", () => {
    const settings = currentTaskSettingsFixture();
    const original = structuredClone(settings.computer.workspaces[0]!);
    original.excludedPaths = ["/fixture/writer/z", "/fixture/writer/a"];
    settings.computer.workspaces = [
      original,
      {
        ...original,
        workspaceId: "10000000-0000-4000-8000-000000000099",
        root: "/other",
        excludedPaths: ["/other/z", "/other/a"],
      },
    ];
    const facts = taskSettingsFacts(settings) as {
      computer: { workspaces: unknown[] };
    };
    expect(facts.computer.workspaces).toMatchObject([
      {
        root: original.root,
        excludedPaths: ["/fixture/writer/z", "/fixture/writer/a"],
      },
      { root: "/other", excludedPaths: ["/other/z", "/other/a"] },
    ]);
    expect(taskSettingsFacts({})).toEqual({ status: "settings-invalid" });
  });

  it.each([
    ["request", (out: Outcome) => ({ ...out, requestId: "other" })],
    ["effect", (out: Outcome) => ({ ...out, operationId: "effect" })],
    [
      "profile",
      (out: Outcome) => ({
        ...out,
        context: { ...context, profileId: "other" },
      }),
    ],
    [
      "generation",
      (out: Outcome) => ({
        ...out,
        context: { ...context, backendGeneration: "other" },
      }),
    ],
    [
      "before revision",
      (out: Outcome) => ({
        ...out,
        data: { beforeRevision: "2", candidateRevision: "1", changed: true },
      }),
    ],
    [
      "candidate revision",
      (out: Outcome) => ({
        ...out,
        data: { beforeRevision: "1", candidateRevision: "2", changed: true },
      }),
    ],
    [
      "nonboolean",
      (out: Outcome) => ({
        ...out,
        data: { beforeRevision: "1", candidateRevision: "1", changed: 1 },
      }),
    ],
    [
      "extra field",
      (out: Outcome) => ({
        ...out,
        data: {
          beforeRevision: "1",
          candidateRevision: "1",
          changed: true,
          approved: true,
        },
      }),
    ],
    [
      "missing field",
      (out: Outcome) => ({
        ...out,
        data: { beforeRevision: "1", changed: false },
      }),
    ],
  ] as const)(
    "refuses a crossed or malformed %s without retry",
    async (_name, change) => {
      const f = fixture(change);
      const settings = currentTaskSettingsFixture();
      await expect(f.bridge.compare(settings, settings)).rejects.toBeInstanceOf(
        BridgeError,
      );
      expect(f.request).toHaveBeenCalledOnce();
    },
  );

  it("rejects a well-formed reply from a predecessor peer", async () => {
    const f = fixture();
    const settings = currentTaskSettingsFixture();
    const pending = f.bridge.compare(settings, settings);
    f.successor();
    await expect(pending).rejects.toMatchObject({
      code: "task_settings_response_context",
    });
    expect(f.request).toHaveBeenCalledOnce();
  });

  it("propagates a lost original response without a local equality fallback", async () => {
    const f = fixture();
    const failure = new BridgeError("unknown", "response_timeout");
    f.request.mockRejectedValue(failure);
    const settings = currentTaskSettingsFixture();
    await expect(f.bridge.compare(settings, settings)).rejects.toBe(failure);
    expect(f.request).toHaveBeenCalledOnce();
  });

  it("preserves a Go refusal without interpreting the two equal inputs", async () => {
    const f = fixture((out) => ({
      requestId: out.requestId,
      context: out.context,
      status: "unavailable",
      code: "TASK_CURRENT_SETTINGS_UNAVAILABLE",
    }));
    const settings = currentTaskSettingsFixture();
    await expect(f.bridge.compare(settings, settings)).rejects.toMatchObject({
      code: "TASK_CURRENT_SETTINGS_UNAVAILABLE",
    });
    expect(f.request).toHaveBeenCalledOnce();
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid revision %s before sending",
    async (revision) => {
      const f = fixture();
      const before = currentTaskSettingsFixture();
      const candidate = structuredClone(before);
      candidate.revision = revision;
      await expect(f.bridge.compare(before, candidate)).rejects.toMatchObject({
        code: "task_settings_revision_invalid",
      });
      expect(f.request).not.toHaveBeenCalled();
    },
  );
});
