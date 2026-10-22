import type { Intent, WindowSnapshot } from "../../../src/ui/renderer/contract";

export type UnresolvedAction = Readonly<{
  id: string;
  label: string;
  cause: string;
  state: "pending" | "unknown";
  code?: string | null;
}>;
const unresolved = (intent: Intent) =>
  intent.state === "pending" ||
  intent.state === "unknown" ||
  intent.code === "SETTINGS_WRITE_FAILED";

/** Current window receipts and saved unresolved operations; never invent a retry. */
export function unresolvedActions(
  snapshot: WindowSnapshot,
  retained: readonly Intent[] = [],
): readonly UnresolvedAction[] {
  const intents = new Map(
    Object.values(snapshot.intents).map((intent) => [intent.id, intent]),
  );
  retained.forEach((intent) => intents.set(intent.id, intent));
  const rows: UnresolvedAction[] = [...intents.values()]
    .filter(unresolved)
    .map((intent) => ({
      id: intent.id,
      label: intent.id.startsWith("settings:")
        ? intent.id.split(":")[1]!.replaceAll(".", " ").replaceAll("-", " ")
        : intent.id.replaceAll(":", " ").replaceAll("-", " "),
      state: intent.state === "pending" ? "pending" : "unknown",
      cause:
        intent.state === "pending"
          ? "This action is still waiting for its result. Wait for it to finish."
          : "Farol could not confirm the result. The action may have taken effect; do not repeat it.",
      code: intent.code,
    }));
  const settings =
    snapshot.configuration?.status === "ready"
      ? snapshot.configuration.settings
      : null;
  if (settings) {
    for (const [step, value] of Object.entries(settings.setup)) {
      if ("outcomeUnknown" in value && value.outcomeUnknown)
        rows.push({
          id: `setup:${step}`,
          label: `${step === "computer" ? "Workspace access" : step === "chatgpt" ? "ChatGPT sign-in" : "Connection check"}`,
          state: "unknown",
          cause:
            "The saved setup check has no confirmed outcome. Refresh status to inspect available evidence; this does not repeat the check.",
        });
    }
    if (settings.connectors.secureMcp.runtime?.state === "outcome_unknown")
      rows.push({
        id: "connection-runtime",
        label: "Local connection",
        state: "unknown",
        cause:
          "The connection operation has no confirmed result. Refresh status before taking another action.",
      });
  }
  for (const operationId of new Set(
    [
      settings?.computer.pendingEdit?.operationId,
      snapshot.workspaceEditDelivery,
    ].filter((id): id is string => Boolean(id)),
  ))
    rows.push({
      id: `workspace-edit:${operationId}`,
      label: "Workspace edit",
      state: "pending",
      cause:
        snapshot.workspaceEditDelivery === operationId
          ? "The existing edit result is waiting for delivery acknowledgement. Review it before preparing another edit."
          : "An existing workspace edit is waiting for observation. Read its result without submitting another edit.",
    });
  const update = snapshot.update;
  if (
    update.phase === "recovery" ||
    (update.phase === "failed" && update.recoveryRequired)
  )
    rows.push({
      id: "update-recovery",
      label: "Update recovery",
      state: "unknown",
      cause:
        "An earlier update has no confirmed completion. Inspect the existing recovery options before taking another update action.",
      code: "code" in update ? update.code : null,
    });
  else if (
    update.phase === "checking" ||
    update.phase === "downloading" ||
    update.phase === "applying"
  )
    rows.push({
      id: "update-progress",
      label: "Update in progress",
      state: "pending",
      cause:
        "The current update action is still in progress. Wait for its result; do not start it again.",
    });
  for (const [id, preference] of [
    ["automatic-update", update.automaticUpdatePreference],
    ["install-on-quit", update.installOnQuitPreference],
  ] as const)
    if (preference?.status === "unknown")
      rows.push({
        id,
        label: "Update preference",
        state: "unknown",
        cause:
          "The saved update preference could not be confirmed. Refresh status before changing it again.",
        code: preference.code,
      });
  return rows;
}
