import {
  DesktopAdmission,
  type DesktopReservation,
  type DesktopWork,
} from "../../apps/desktop/host/admission";

// Keep existing characterization fixtures' controls while running the real
// admission owner. This adapter is test-only; it grants no host authority.
export function admissionFixture<T extends object>(
  fixture: T,
): T & { desktopAdmission: DesktopAdmission } {
  if ("desktopAdmission" in fixture)
    return fixture as T & { desktopAdmission: DesktopAdmission };
  const state = fixture as Record<string, unknown>;
  const admission = new DesktopAdmission({
    chatGptReadonlyTask: () => Boolean(state.pendingChatGptReadonlyTask),
    directChatStart: () => Boolean(state.directChatStart),
    chatGptAttachmentTask: () => Boolean(state.pendingChatGptAttachmentTask),
    workspaceEdit: () => Boolean(state.pendingWorkspaceEdit),
    computer: () =>
      (state.pendingComputer as Map<unknown, unknown> | undefined)?.size !==
        undefined && (state.pendingComputer as Map<unknown, unknown>).size > 0,
    codexAgent: () =>
      (state.codexAgentOperationActive as (() => boolean) | undefined)?.() ??
      false,
    hostCheck: () =>
      Boolean(
        (state.hostCheckClients as Map<unknown, unknown> | undefined)?.size,
      ),
    connectorStart: () => Boolean(state.connectorStartInFlight),
  });
  for (const [name, kind] of Object.entries({
    chatGptTaskAdmission: "chatgpt-task",
    connectorTaskAdmission: "connector-task",
    codexHostTaskAdmission: "codex-host-task",
    workspaceMutationAdmission: "workspace-mutation",
  }) as [string, DesktopWork][]) {
    let held: DesktopReservation | null = state[name]
      ? admission.reserveAdmitted(kind)
      : null;
    Object.defineProperty(state, name, {
      configurable: true,
      get: () => admission.occupied(kind),
      set: (value: boolean) => {
        if (value && !admission.occupied(kind))
          held = admission.reserveAdmitted(kind);
        if (!value) {
          held?.release();
          held = null;
        }
      },
    });
  }
  if (state.quitInProgress) admission.beginQuit();
  Object.defineProperty(state, "quitInProgress", {
    configurable: true,
    get: () => admission.quitInProgress,
    set: (value: boolean) => {
      if (value) admission.beginQuit();
    },
  });
  let update = state.installedUpdateAdmission ? admission.enterUpdate() : null;
  Object.defineProperty(state, "installedUpdateAdmission", {
    configurable: true,
    get: () => admission.installedUpdateAdmission,
    set: (value: boolean) => {
      if (value && !update) update = admission.enterUpdate();
      if (!value) {
        update?.release();
        update = null;
      }
    },
  });
  Object.defineProperty(state, "connectorTaskAdmissionPurpose", {
    configurable: true,
    get: () => admission.connectorTaskAdmissionPurpose,
  });
  Object.defineProperty(state, "configurationRequests", {
    configurable: true,
    get: () => admission.configurationRequests,
  });
  return Object.assign(fixture, { desktopAdmission: admission });
}
