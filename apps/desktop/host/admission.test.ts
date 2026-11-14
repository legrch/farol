import { describe, expect, it } from "vitest";
import { DesktopAdmission, type DesktopPendingWork } from "./admission";

function fixture() {
  const flags = {
    chatGptReadonlyTask: false,
    directChatStart: false,
    chatGptAttachmentTask: false,
    workspaceEdit: false,
    computer: false,
    codexAgent: false,
    hostCheck: false,
    connectorStart: false,
  };
  const pending = Object.fromEntries(
    Object.keys(flags).map((key) => [
      key,
      () => flags[key as keyof typeof flags],
    ]),
  ) as DesktopPendingWork;
  return { admission: new DesktopAdmission(pending), flags };
}

describe("DesktopAdmission", () => {
  it("keeps Quit latched after its original update preparation releases", () => {
    const { admission } = fixture();
    admission.beginQuit();
    const update = admission.enterUpdate();
    expect(update).not.toBeNull();
    update!.release();
    expect(admission.closed()).toBe(true);
    expect(admission.quitInProgress).toBe(true);
    expect(admission.installedUpdateAdmission).toBe(false);
    expect(admission.updateBlocker(false)).toBe("UPDATE_WORK_PENDING");
    expect(admission.updateBlocker(true)).toBeNull();
  });

  it.each([
    "chatgpt-task",
    "connector-task",
    "codex-host-task",
    "workspace-mutation",
  ] as const)(
    "refuses new %s work while update or Quit closes admission",
    (kind) => {
      const { admission } = fixture();
      const update = admission.enterUpdate()!;
      expect(admission.acquire(kind)).toBeNull();
      update.release();
      const admitted = admission.acquire(kind)!;
      expect(admitted).not.toBeNull();
      admission.beginQuit();
      admitted.release();
      expect(admission.acquire(kind)).toBeNull();
    },
  );

  it("does not let a retired handle release a successor reservation", () => {
    const { admission } = fixture();
    const first = admission.acquire("connector-task", "manual-diagnostic")!;
    expect(admission.acquire("connector-task")).toBeNull();
    expect(admission.connectorTaskAdmissionPurpose).toBe("manual-diagnostic");
    first.release();
    const second = admission.acquire("connector-task", "manual-diagnostic")!;
    first.release();
    expect(admission.occupied("connector-task")).toBe(true);
    expect(admission.connectorTaskAdmissionPurpose).toBe("manual-diagnostic");
    second.release();
    expect(admission.connectorTaskAdmissionPurpose).toBeNull();
  });

  it("does not let a retired update handle reopen a successor update", () => {
    const { admission } = fixture();
    const first = admission.enterUpdate()!;
    expect(admission.enterUpdate()).toBeNull();
    first.release();
    const second = admission.enterUpdate()!;
    first.release();
    expect(admission.closed()).toBe(true);
    second.release();
    expect(admission.closed()).toBe(false);
  });

  it.each([
    "chatGptReadonlyTask",
    "directChatStart",
    "chatGptAttachmentTask",
    "workspaceEdit",
    "computer",
    "codexAgent",
    "hostCheck",
  ] as const)("prioritizes pending %s over connector activity", (key) => {
    const { admission, flags } = fixture();
    flags[key] = true;
    flags.connectorStart = true;
    expect(admission.updateBlocker(true)).toBe("UPDATE_WORK_PENDING");
    flags[key] = false;
    expect(admission.updateBlocker(true)).toBe("UPDATE_CONNECTOR_ACTIVE");
  });

  it.each(["chatgpt-task", "workspace-mutation", "codex-host-task"] as const)(
    "retains the update fence for %s until release",
    (kind) => {
      const { admission } = fixture();
      const work = admission.acquire(kind)!;
      expect(admission.updateBlocker(true)).toBe("UPDATE_WORK_PENDING");
      work.release();
      expect(admission.updateBlocker(true)).toBeNull();
    },
  );

  it("counts overlapping configuration requests through rejection", async () => {
    const { admission } = fixture();
    let finish!: () => void;
    const first = admission.withConfigurationRequest(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await expect(
      admission.withConfigurationRequest(async () => {
        expect(admission.configurationRequests).toBe(2);
        throw new Error("controlled refusal");
      }),
    ).rejects.toThrow("controlled refusal");
    expect(admission.configurationRequests).toBe(1);
    expect(admission.updateBlocker(true)).toBe("UPDATE_WORK_PENDING");
    finish();
    await first;
    expect(admission.configurationRequests).toBe(0);
    expect(admission.updateBlocker(true)).toBeNull();
  });

  it("releases configuration admission after a synchronous throw", async () => {
    const { admission } = fixture();
    await expect(
      admission.withConfigurationRequest(() => {
        throw new Error("synchronous refusal");
      }),
    ).rejects.toThrow("synchronous refusal");
    expect(admission.configurationRequests).toBe(0);
  });
});
