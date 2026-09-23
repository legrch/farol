import {
  ProductConfigurationCommandSchema,
  type ProductConfigurationCommand,
  type ProductSettings,
} from "../pkg/product-settings/contract";
import {
  routeReadiness,
  setupStepStale,
  type RouteReadinessState,
} from "./setup-presentation";

// A projection of the existing configuration, never another settings store.
// In particular, neither visiting a step nor saving a key is verification.
export interface OnboardingFacts {
  readonly available: boolean;
  readonly chat: RouteReadinessState;
  readonly folder: RouteReadinessState;
  readonly hasFolder: boolean;
  readonly authority: string;
  readonly client: boolean;
  readonly tunnelId: string | null;
  readonly credentialStored: boolean;
  readonly runtime: "stopped" | "ready" | "unreachable" | "outcome_unknown";
  readonly runtimeCurrent: boolean;
  readonly attachmentCurrent: boolean;
  readonly outcomeUnknown: boolean;
}

export function onboardingFacts(
  settings: ProductSettings | null,
  buildId: string,
): OnboardingFacts {
  if (!settings)
    return {
      available: false,
      chat: "not-configured",
      folder: "not-configured",
      hasFolder: false,
      authority: "unavailable",
      client: false,
      tunnelId: null,
      credentialStored: false,
      runtime: "stopped",
      runtimeCurrent: false,
      attachmentCurrent: false,
      outcomeUnknown: false,
    };
  const connector = settings.connectors.secureMcp;
  const runtime = connector.runtime;
  const attachment = connector.attachment;
  const workspaceIds = settings.computer.workspaces
    .map((workspace) => workspace.workspaceId)
    .sort();
  const runtimeCurrent =
    connector.tunnelClient !== null &&
    connector.tunnelId !== null &&
    connector.credential === "stored" &&
    runtime !== null &&
    runtime.state === "ready" &&
    runtime.buildId === buildId &&
    runtime.computerGeneration === settings.computer.generation &&
    runtime.connectorGeneration === connector.generation;
  return {
    available: true,
    chat: routeReadiness(settings.setup.chatgpt),
    folder: routeReadiness(settings.setup.computer, {
      stale:
        setupStepStale(settings, "computer") ||
        settings.setup.computer.verified?.buildId !== buildId,
    }),
    hasFolder: workspaceIds.length > 0,
    authority: JSON.stringify([
      buildId,
      settings.computer.generation,
      workspaceIds,
    ]),
    client: connector.tunnelClient !== null,
    tunnelId: connector.tunnelId,
    credentialStored: connector.credential === "stored",
    runtime: runtime?.state ?? "stopped",
    runtimeCurrent,
    attachmentCurrent:
      runtimeCurrent &&
      attachment !== null &&
      routeReadiness(settings.setup.connect) === "ready" &&
      attachment.buildId === buildId &&
      attachment.tunnelId === connector.tunnelId &&
      attachment.connectorGeneration === connector.generation &&
      attachment.computerGeneration === settings.computer.generation &&
      attachment.runtimeGeneration === runtime?.runtimeGeneration &&
      attachment.workspaceId ===
        settings.setup.computer.verified?.workspaceId &&
      workspaceIds.includes(attachment.workspaceId),
    outcomeUnknown:
      settings.setup.connect.outcomeUnknown ||
      runtime?.state === "outcome_unknown",
  };
}

export const onboardingSteps = [
  {
    id: "chatgpt",
    label: "Sign in",
    title: "Connect your ChatGPT",
    copy: "Sign in inside Farol's ChatGPT browser. Your everyday browser and Codex stay unchanged.",
  },
  {
    id: "folder",
    label: "Choose a folder",
    title: "Choose what ChatGPT can read",
    copy: "Choose one folder. Farol checks access locally; files stay private until you ask ChatGPT to use them.",
  },
  {
    id: "tunnel",
    label: "Activate",
    title: "Connect this computer",
    copy: "Create a separate DEV tunnel and runtime key, then paste them below. Activate saves the connection and starts it for you.",
  },
  {
    id: "app",
    label: "Add to ChatGPT",
    title: "Add Farol Dev to ChatGPT",
    copy: "The tunnel is local-ready. Add its app in ChatGPT, then verify that ChatGPT can reach this computer.",
  },
  {
    id: "finish",
    label: "Ready",
    title: "You're connected",
    copy: "ChatGPT can reach the folder you approved. Use @Farol Dev when asking it to work with your computer.",
  },
] as const;
export type OnboardingStep = (typeof onboardingSteps)[number]["id"];

export function onboardingProgress(facts: OnboardingFacts): readonly boolean[] {
  if (!facts.available) return [false, false, false, false, false];
  const chat = facts.chat === "ready";
  const folder = facts.hasFolder && facts.folder === "ready";
  const tunnel =
    facts.runtime === "ready" && facts.runtimeCurrent && !facts.outcomeUnknown;
  const app = tunnel && folder && facts.attachmentCurrent;
  return [chat, folder, tunnel, app, chat && folder && tunnel && app];
}

// Selecting another saved grant, or choosing a new folder, cannot inherit the
// previous folder's Ready badge while the new choice is still unverified.
export function onboardingProgressForFolderChoice(
  facts: OnboardingFacts,
  selectedFolderReady: boolean,
): readonly boolean[] {
  const [chat, folder, tunnel, app, ready] = onboardingProgress(facts);
  return [
    chat ?? false,
    (folder ?? false) && selectedFolderReady,
    (tunnel ?? false) && selectedFolderReady,
    (app ?? false) && selectedFolderReady,
    (ready ?? false) && selectedFolderReady,
  ];
}

// A saved grant is not consent to select it for this setup. Only a current
// verification may be preselected; a stale grant needs an explicit choice.
export function defaultOnboardingFolderChoice(
  settings: ProductSettings,
  buildId: string,
): string {
  const verified = settings.setup.computer.verified?.workspaceId;
  if (
    verified &&
    routeReadiness(settings.setup.computer, {
      stale:
        setupStepStale(settings, "computer") ||
        settings.setup.computer.verified?.buildId !== buildId,
    }) === "ready" &&
    settings.computer.workspaces.some(
      (workspace) => workspace.workspaceId === verified,
    )
  ) {
    return verified;
  }
  return "new";
}

export function selectedOnboardingWorkspace(
  settings: ProductSettings,
  choice: string,
): ProductSettings["computer"]["workspaces"][number] | null {
  if (choice === "new") return null;
  return (
    settings.computer.workspaces.find(
      (workspace) => workspace.workspaceId === choice,
    ) ?? null
  );
}

export interface ActivationPort {
  readonly read: () => OnboardingFacts;
  readonly run: (command: ProductConfigurationCommand) => Promise<boolean>;
}
export type ActivationResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      reason:
        | "busy"
        | "prerequisite"
        | "invalid-fields"
        | "new-key-required"
        | "inspect-existing-operation"
        | "state-changed"
        | "command-failed"
        | "runtime-not-ready";
    }>;

// Coordinates existing, admitted product commands. A false/unknown result ends
// the chain. This never repairs/rebinds a runtime, sends a model prompt or retries.
export class GuidedActivation {
  private active = false;

  get busy(): boolean {
    return this.active;
  }

  async run(
    port: ActivationPort,
    values: Readonly<{ tunnelId: string; runtimeKey: string }>,
  ): Promise<ActivationResult> {
    if (this.active) return { ok: false, reason: "busy" };
    this.active = true;
    try {
      const initial = port.read();
      if (initial.outcomeUnknown || initial.runtime === "outcome_unknown")
        return { ok: false, reason: "inspect-existing-operation" };
      if (
        !initial.available ||
        initial.chat !== "ready" ||
        initial.folder !== "ready" ||
        !initial.hasFolder
      )
        return { ok: false, reason: "prerequisite" };
      if (initial.runtime !== "stopped")
        return initial.runtime === "ready" && initial.runtimeCurrent
          ? { ok: true }
          : { ok: false, reason: "inspect-existing-operation" };
      const tunnelId = values.tunnelId.trim();
      if (
        values.runtimeKey === "" &&
        (!initial.credentialStored || tunnelId !== initial.tunnelId)
      )
        return { ok: false, reason: "new-key-required" };
      const parsed = ProductConfigurationCommandSchema.safeParse({
        kind: "connector.configure",
        tunnelId,
        runtimeKey: values.runtimeKey || null,
      });
      if (!parsed.success) return { ok: false, reason: "invalid-fields" };
      const unchanged = (): boolean => {
        const current = port.read();
        return (
          current.available &&
          current.authority === initial.authority &&
          current.chat === "ready" &&
          current.folder === "ready" &&
          !current.outcomeUnknown &&
          current.runtime === "stopped"
        );
      };
      if (!initial.client) {
        if (!(await port.run({ kind: "connector.discover-client" })))
          return { ok: false, reason: "command-failed" };
        const discovered = port.read();
        if (
          !unchanged() ||
          !discovered.client ||
          discovered.tunnelId !== initial.tunnelId ||
          discovered.credentialStored !== initial.credentialStored
        )
          return { ok: false, reason: "state-changed" };
      }
      // Saving an unchanged stored credential would invalidate useful evidence.
      if (values.runtimeKey !== "" || tunnelId !== initial.tunnelId) {
        if (!(await port.run(parsed.data)))
          return { ok: false, reason: "command-failed" };
        if (!unchanged()) return { ok: false, reason: "state-changed" };
      }
      const saved = port.read();
      if (
        !unchanged() ||
        !saved.client ||
        saved.tunnelId !== tunnelId ||
        !saved.credentialStored
      )
        return { ok: false, reason: "state-changed" };
      if (!(await port.run({ kind: "connector.start" })))
        return { ok: false, reason: "command-failed" };
      const started = port.read();
      if (
        started.authority !== initial.authority ||
        started.tunnelId !== tunnelId ||
        started.chat !== "ready" ||
        started.folder !== "ready"
      )
        return { ok: false, reason: "state-changed" };
      return started.runtime === "ready" &&
        started.runtimeCurrent &&
        !started.outcomeUnknown
        ? { ok: true }
        : { ok: false, reason: "runtime-not-ready" };
    } catch {
      // The port may have admitted a command before transport failed. Never
      // continue or claim that nothing happened; existing product recovery owns it.
      return { ok: false, reason: "inspect-existing-operation" };
    } finally {
      this.active = false;
    }
  }
}
