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
import { allFoldersChecked } from "./folder-access-state";

// A projection of the existing configuration, never another settings store.
// In particular, neither visiting a step nor saving a key is verification.
export interface OnboardingFacts {
  readonly available: boolean;
  readonly chat: RouteReadinessState;
  readonly folder: RouteReadinessState;
  readonly hasFolder: boolean;
  readonly authority: string;
  readonly connectionIdentity: string;
  readonly verificationIdentity: string | null;
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
      connectionIdentity: "unavailable",
      verificationIdentity: null,
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
        !allFoldersChecked(settings, buildId),
    }),
    hasFolder: workspaceIds.length > 0,
    authority: JSON.stringify([
      buildId,
      settings.computer.generation,
      workspaceIds,
    ]),
    connectionIdentity: JSON.stringify([
      connector.generation,
      connector.tunnelId,
      connector.credential,
      connector.tunnelClient?.executableSha256 ?? null,
    ]),
    verificationIdentity:
      runtime !== null &&
      connector.challenge !== null &&
      settings.setup.computer.verified !== null
        ? JSON.stringify([
            runtime.buildId,
            runtime.runtimeGeneration,
            connector.challenge.challengeSha256,
            connector.challenge.runtimeGeneration,
            settings.setup.computer.verified.workspaceId,
            settings.computer.generation,
            connector.generation,
          ])
        : null,
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
    label: "Folders",
    title: "Your folders, your choice",
    copy: "Sharing folders is optional. Add a folder if you want ChatGPT to use files on this computer, or continue without local access. You can change this later.",
  },
  {
    id: "tunnel",
    label: "Connection",
    title: "Connect this computer",
    copy: "Save your tunnel credentials once, then check the connection. You can replace them later without starting setup again.",
  },
  {
    id: "app",
    label: "Add to ChatGPT",
    title: "Add Farol Dev to ChatGPT",
    copy: "Add Farol Dev in ChatGPT once. Then run an end-to-end check: Farol selects the app, sends one short message, and checks the local receipt. Read the reply before returning to Setup.",
  },
  {
    id: "finish",
    label: "Overview",
    title: "Your setup",
    copy: "Four steps connect ChatGPT to this computer. Open any step to check or change it; only confirmed checks turn green.",
  },
] as const;
export type OnboardingStep = (typeof onboardingSteps)[number]["id"];

export type OnboardingMode = "embedded" | "external";

export function externalConnectorChallengeAllowed(
  facts: OnboardingFacts,
): boolean {
  return (
    facts.available &&
    facts.hasFolder &&
    facts.folder === "ready" &&
    facts.runtimeCurrent &&
    facts.verificationIdentity !== null &&
    !facts.attachmentCurrent &&
    !facts.outcomeUnknown
  );
}

export function onboardingProgress(
  facts: OnboardingFacts,
  mode: OnboardingMode = "embedded",
): readonly boolean[] {
  if (!facts.available) return [false, false, false, false, false];
  // External Computer access does not depend on the embedded browser account.
  // This completes an optional step; it never changes sign-in evidence.
  const chat = mode === "external" || facts.chat === "ready";
  // Choosing whether to share folders is optional and complete as soon as
  // setup is available. Access and connector proof remain separate.
  const folder = true;
  const tunnel =
    facts.hasFolder &&
    facts.folder === "ready" &&
    facts.runtime === "ready" &&
    facts.runtimeCurrent &&
    !facts.outcomeUnknown;
  const app = tunnel && folder && facts.attachmentCurrent;
  return [chat, folder, tunnel, app, chat && folder && tunnel && app];
}

// The checklist describes what the owner has completed. A new build may
// require fresh runtime evidence before Computer is usable, but installing it
// does not erase the already completed setup. Match every saved witness to
// the still-approved folder and connection before showing a past completion.
export function onboardingCompletedSteps(
  settings: ProductSettings | null,
  mode: OnboardingMode = "embedded",
): readonly boolean[] {
  if (!settings) return [false, false, false, false, false];
  const connector = settings.connectors.secureMcp;
  const workspaceIds = new Set(
    settings.computer.workspaces.map((item) => item.workspaceId),
  );
  const chat =
    mode === "external" || routeReadiness(settings.setup.chatgpt) === "ready";
  const witness = settings.setup.computer.verified;
  const folder =
    workspaceIds.size === 0 ||
    (witness !== null &&
      witness.configRevision === settings.computer.generation &&
      witness.workspaceId !== null &&
      workspaceIds.has(witness.workspaceId) &&
      !settings.setup.computer.outcomeUnknown &&
      settings.computer.workspaces.length > 0 &&
      settings.computer.workspaces.every((workspace) => {
        const check = workspace.accessCheck;
        const identity = workspace.rootIdentity;
        return (
          check != null &&
          identity !== undefined &&
          check.computerGeneration === settings.computer.generation &&
          check.rootIdentity.device === identity.device &&
          check.rootIdentity.inode === identity.inode
        );
      }));
  const runtime = connector.runtime;
  const configuredConnection =
    folder &&
    workspaceIds.size > 0 &&
    connector.tunnelClient !== null &&
    connector.credential === "stored" &&
    connector.tunnelId !== null;
  const previouslyVerified = connector.lastVerifiedAttachment;
  const priorAppCheck =
    configuredConnection &&
    previouslyVerified !== null &&
    previouslyVerified.tunnelId === connector.tunnelId &&
    previouslyVerified.connectorGeneration === connector.generation &&
    previouslyVerified.computerGeneration === settings.computer.generation &&
    previouslyVerified.workspaceId === witness?.workspaceId &&
    workspaceIds.has(previouslyVerified.workspaceId);
  const currentConnection =
    configuredConnection &&
    runtime?.state === "ready" &&
    allFoldersChecked(settings, runtime.buildId) &&
    runtime.computerGeneration === settings.computer.generation &&
    runtime.connectorGeneration === connector.generation &&
    !settings.setup.connect.outcomeUnknown;
  const connection = currentConnection || priorAppCheck;
  const attachment = connector.attachment;
  const currentAppCheck =
    currentConnection &&
    attachment !== null &&
    settings.setup.connect.verified !== null &&
    attachment.buildId === runtime?.buildId &&
    attachment.tunnelId === connector.tunnelId &&
    attachment.connectorGeneration === connector.generation &&
    attachment.computerGeneration === settings.computer.generation &&
    attachment.runtimeGeneration === runtime?.runtimeGeneration &&
    attachment.workspaceId === witness?.workspaceId;
  const app = priorAppCheck || currentAppCheck;
  return [chat, folder, connection, app, chat && folder && connection && app];
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
    mode: OnboardingMode = "embedded",
  ): Promise<ActivationResult> {
    if (this.active) return { ok: false, reason: "busy" };
    this.active = true;
    try {
      const initial = port.read();
      if (initial.outcomeUnknown || initial.runtime === "outcome_unknown")
        return { ok: false, reason: "inspect-existing-operation" };
      if (
        !initial.available ||
        (mode === "embedded" && initial.chat !== "ready") ||
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
          (mode === "external" || current.chat === "ready") &&
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
        (mode === "embedded" && started.chat !== "ready") ||
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
