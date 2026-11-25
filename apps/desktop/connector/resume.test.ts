import { describe, expect, it, vi } from "vitest";
import { resumeComputerConnector } from "../../../src/apps/desktop/connector-resume-policy";
import { channels } from "../../../src/pkg/ipc/channels";
import type { ProductConfigurationSnapshot } from "../../../src/pkg/product-settings/contract";
import { startConnectorResume, type ConnectorResumePorts } from "./resume";

// The connector resume over recording owners. Quit's flags and the window are
// getters the test changes while the resume waits, so each check is proven to
// read its owner at that moment. The policy is scripted except in the
// cancellation cases, where the real one decides "skipped" before any effect.
// No window, connector, tunnel or provider runs.

type Status = Awaited<ReturnType<typeof resumeComputerConnector>>;

const unavailable = {
  status: "unavailable",
} as unknown as ProductConfigurationSnapshot;

function build(
  overrides: Partial<{
    resume: ConnectorResumePorts["resume"];
    driftSettled: boolean;
    cancelled: boolean;
    quitting: boolean;
    closed: boolean;
    hasWindow: boolean;
    destroyed: boolean;
    startupStage: ConnectorResumePorts["startupStage"];
    watch: () => void;
  }> = {},
) {
  const log: string[] = [];
  const state = {
    cancelled: overrides.cancelled ?? false,
    quitting: overrides.quitting ?? false,
    closed: overrides.closed ?? false,
    destroyed: overrides.destroyed ?? false,
    hasWindow: overrides.hasWindow ?? true,
    snapshots: 0,
  };
  const sent: string[] = [];
  const ports: ConnectorResumePorts = {
    resume:
      overrides.resume ??
      (async () => {
        log.push("resume");
        return "started" as Status;
      }),
    launch: {
      environment: "preview",
      buildEnvironment: "preview",
      buildId: "a".repeat(64),
      previousRunClean: true,
    },
    driftSettled: overrides.driftSettled ?? true,
    snapshot: () => {
      state.snapshots += 1;
      log.push("snapshot");
      return unavailable;
    },
    cancelled: () => state.cancelled,
    desktopAdmission: {
      closed: () => state.closed,
      get quitInProgress() {
        return state.quitting;
      },
    },
    verifyWorkspace: async (id) => {
      log.push(`verify:${id}`);
      return { ok: true };
    },
    start: async () => {
      log.push("start");
      return { ok: true };
    },
    startupStage:
      overrides.startupStage ?? ((stage) => void log.push(`stage:${stage}`)),
    window: () =>
      state.hasWindow
        ? {
            isDestroyed: () => state.destroyed,
            webContents: {
              send: (channel: string) => {
                sent.push(channel);
                log.push("notify");
              },
            },
          }
        : null,
    startConnectorTransportWatch:
      overrides.watch ?? (() => void log.push("watch")),
    finishConnectionCheck: () => void log.push("finish"),
  };
  return { ports, log, state, sent };
}

describe("connector resume", () => {
  it.each([
    ["started", "connector-resumed"],
    ["skipped", "connector-resume-skipped"],
    ["verification-refused", "connector-resume-refused"],
    ["start-refused", "connector-resume-refused"],
  ] as const)(
    "stages %s as %s, starts the watch, then clears the check and notifies",
    async (status, stage) => {
      const { ports, log, sent } = build({
        resume: async () => status,
      });
      await startConnectorResume(ports);
      expect(log).toEqual([
        "snapshot",
        `stage:${stage}`,
        "notify",
        "watch",
        "finish",
        "notify",
      ]);
      expect(sent).toEqual([
        channels.configurationChanged,
        channels.configurationChanged,
      ]);
    },
  );

  it("never sends another ChatGPT test after local startup: it only reports a status, never starting or verifying", async () => {
    const { ports, log } = build({ resume: async () => "started" });
    await startConnectorResume(ports);
    expect(log.some((entry) => /^(start|verify:)/u.test(entry))).toBe(false);
  });

  it("takes the first snapshot before the resume and hands it to the policy", async () => {
    const seen: unknown[] = [];
    const { ports, log } = build({
      resume: async (input) => {
        log.push("resume");
        seen.push(input);
        return "skipped";
      },
    });
    const promise = startConnectorResume(ports);
    expect(log).toEqual(["snapshot", "resume"]);
    await promise;
    expect(seen).toEqual([{ ...ports.launch, snapshot: unavailable }]);
  });

  it("reads the current snapshot, the workspace check and the start through the ports", async () => {
    const { ports, log } = build({
      resume: async (_input, policyPorts) => {
        policyPorts.current();
        await policyPorts.verifyWorkspace("w1");
        await policyPorts.start();
        return "started";
      },
    });
    await startConnectorResume(ports);
    expect(log.slice(0, 4)).toEqual([
      "snapshot",
      "snapshot",
      "verify:w1",
      "start",
    ]);
  });

  it("lets the policy continue only while settled, not cancelled and admission open", async () => {
    const verdicts: boolean[] = [];
    const { ports, state } = build({
      resume: async (_input, policyPorts) => {
        verdicts.push(policyPorts.mayContinue());
        state.cancelled = true;
        verdicts.push(policyPorts.mayContinue());
        state.cancelled = false;
        state.closed = true;
        verdicts.push(policyPorts.mayContinue());
        state.closed = false;
        verdicts.push(policyPorts.mayContinue());
        return "skipped";
      },
    });
    await startConnectorResume(ports);
    expect(verdicts).toEqual([true, false, false, true]);
    const unsettled = build({
      driftSettled: false,
      resume: async (_input, policyPorts) => {
        expect(policyPorts.mayContinue()).toBe(false);
        return "skipped";
      },
    });
    await startConnectorResume(unsettled.ports);
  });

  it.each([
    ["cancelled by Quit before it starts", { cancelled: true }],
    [
      "refused for a drift withdrawal that did not settle",
      { driftSettled: false },
    ],
    ["refused once admission is closed", { closed: true }],
  ] as const)("skips with the real policy when %s", async (_name, flag) => {
    const { ports, log } = build({ ...flag, resume: resumeComputerConnector });
    await startConnectorResume(ports);
    expect(log).toEqual([
      "snapshot",
      "stage:connector-resume-skipped",
      "notify",
      "watch",
      "finish",
      "notify",
    ]);
  });

  it("sees a Quit that cancels the resume while the policy is already running", async () => {
    const verdicts: boolean[] = [];
    const { ports, state } = build({
      resume: async (_input, policyPorts) => {
        verdicts.push(policyPorts.mayContinue());
        state.cancelled = true;
        await Promise.resolve();
        verdicts.push(policyPorts.mayContinue());
        return "verification-refused";
      },
    });
    await startConnectorResume(ports);
    expect(verdicts).toEqual([true, false]);
  });

  it("does not notify a window that is absent, destroyed or closing, but still finishes", async () => {
    for (const flag of [
      { hasWindow: false },
      { destroyed: true },
      { quitting: true },
    ]) {
      const { ports, log, sent } = build(flag);
      await startConnectorResume(ports);
      expect(sent).toEqual([]);
      expect(log).toEqual([
        "snapshot",
        "resume",
        "stage:connector-resumed",
        "watch",
        "finish",
      ]);
    }
  });

  it("swallows a failed resume into a failed stage, still watches, and finishes", async () => {
    const { ports, log } = build({
      resume: async () => {
        log.push("resume");
        throw new Error("RESUME_FAILED");
      },
    });
    await expect(startConnectorResume(ports)).resolves.toBeUndefined();
    expect(log).toEqual([
      "snapshot",
      "resume",
      "stage:connector-resume-failed",
      "watch",
      "finish",
      "notify",
    ]);
  });

  it("does not notify between a failed resume and its finish", async () => {
    const { ports, sent } = build({
      resume: async () => {
        throw new Error("RESUME_FAILED");
      },
    });
    await startConnectorResume(ports);
    expect(sent).toEqual([channels.configurationChanged]);
  });

  it("clears the check even when the success handler throws, and that error is not swallowed", async () => {
    const { ports, log } = build({
      startupStage: () => {
        throw new Error("STAGE_FAILED");
      },
    });
    await expect(startConnectorResume(ports)).rejects.toThrow("STAGE_FAILED");
    expect(log).toEqual(["snapshot", "resume", "finish", "notify"]);
  });

  it("does not start the watch twice when the watch itself throws", async () => {
    const watch = vi.fn(() => {
      throw new Error("WATCH_FAILED");
    });
    const { ports, log } = build({ watch });
    await expect(startConnectorResume(ports)).rejects.toThrow("WATCH_FAILED");
    expect(watch).toHaveBeenCalledOnce();
    expect(log.slice(-2)).toEqual(["finish", "notify"]);
  });

  it("reads the window when each notice is sent, not when the resume began", async () => {
    const { ports, state, sent } = build({
      resume: async () => {
        state.hasWindow = false;
        return "started";
      },
    });
    await startConnectorResume(ports);
    expect(sent).toEqual([]);
  });
});
