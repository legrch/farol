import type { ProductSettings } from "../pkg/product-settings/contract";
import { selectedConnectorApp } from "../pkg/product-settings/connector-app-selection";
import { allFoldersChecked } from "./folder-access-state";
import { onboardingFacts } from "./guided-onboarding";

type SignInBinding = Readonly<{
  documentGeneration: number;
  sequence: number;
}>;
export type SetupCompletionContext = Readonly<{
  buildId: string;
  current: boolean;
  signInObservation: Readonly<{
    buildId: string;
    state: "authenticated" | "signed_out" | "unknown";
    pending: boolean;
    binding: SignInBinding | null;
  }> | null;
  signInCheck: Readonly<{
    buildId: string;
    binding: SignInBinding;
  }> | null;
}>;

/** Shared receipt predicate. Callers supply their own current host/UI state. */
export function setupCompletionChecks(
  settings: ProductSettings | null,
  context: SetupCompletionContext,
) {
  const {
    buildId,
    signInObservation: observation,
    signInCheck: check,
  } = context;
  const facts = onboardingFacts(settings, buildId);
  const connector = settings?.connectors.secureMcp;
  const runtime = connector?.runtime;
  const verified = settings?.setup.computer.verified;
  const workspace = settings?.computer.workspaces.find(
    (item) => item.workspaceId === verified?.workspaceId,
  );
  const admissible = Boolean(
    context.current &&
    buildId &&
    settings &&
    !settings.computer.pendingEdit &&
    !Object.values(settings.setup).some(
      (step) => "outcomeUnknown" in step && step.outcomeUnknown,
    ) &&
    runtime?.state !== "outcome_unknown",
  );
  const folders = Boolean(
    admissible &&
    settings &&
    facts.folder === "ready" &&
    workspace &&
    verified?.buildId === buildId &&
    verified.configRevision === settings.computer.generation &&
    allFoldersChecked(settings, buildId),
  );
  const connection = admissible && facts.runtimeCurrent;
  const challenge = connector?.challenge;
  const challengeCurrent =
    challenge != null &&
    facts.runtimeCurrent &&
    challenge.buildId === buildId &&
    challenge.computerGeneration === settings?.computer.generation &&
    challenge.runtimeGeneration === runtime?.runtimeGeneration;
  const witness = settings?.setup.connect.verified;
  return {
    signin: Boolean(
      admissible &&
      observation?.state === "authenticated" &&
      !observation.pending &&
      observation.buildId === buildId &&
      observation.binding &&
      check?.buildId === buildId &&
      check.binding.documentGeneration ===
        observation.binding.documentGeneration &&
      observation.binding.sequence >= check.binding.sequence &&
      settings?.setup.chatgpt.verified?.buildId === buildId &&
      settings.setup.chatgpt.reachable === "reachable",
    ),
    folders,
    connection,
    attachment: Boolean(
      admissible &&
      facts.attachmentCurrent &&
      witness?.buildId === buildId &&
      witness.configRevision === connector?.generation &&
      witness.runtimeGeneration === runtime?.runtimeGeneration &&
      witness.workspaceId ===
        (facts.hasFolder ? workspace?.workspaceId : null) &&
      (challenge == null ||
        (challengeCurrent &&
          connector?.attachment?.challengeSha256 ===
            challenge.challengeSha256)) &&
      connector &&
      selectedConnectorApp(connector) !== null,
    ),
  };
}

export function setupCompletionAllowed(
  settings: ProductSettings | null,
  context: SetupCompletionContext,
): boolean {
  return Object.values(setupCompletionChecks(settings, context)).every(Boolean);
}
