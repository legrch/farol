import { setupCompletionChecks } from "../setup-completion";
import { connectorRuntimeUncertain } from "../../pkg/product-settings/connector-uncertainty";
import { ProductConfigurationCommandSchema } from "../../pkg/product-settings/contract";
import type { ProductConfigurationCommand } from "../../pkg/product-settings/contract";
import type { Intent, WindowSnapshot } from "./contract";

type Kind = ProductConfigurationCommand["kind"];
type Dependency = "computer" | "chat" | "model" | "attachment" | "shared";
const kinds = new Set<string>(
  ProductConfigurationCommandSchema.options.map(
    (option) => option.shape.kind.value,
  ),
);
const modelCommands = new Set<Kind>([
  "model.status",
  "model.preview",
  "model.apply",
  "model.rollback",
  "model.rotate-token",
]);
const browserCommands = new Set<Kind>([
  "chatgpt.open-browser",
  "chatgpt.present-browser",
  "chatgpt.toggle-sidebar",
]);

// This is presentation admission, never owner authority. Dependency proof:
// main.ts configureAdmittedProduct's model cases touch the model endpoint or
// Codex config only; browser presentation/toggle do not save ProductSettings.
// Sign-in/verify DO call markSetupVisited/recordChatGptObservation -> commit,
// so their uncertain replies stay shared, even though ChatGPT is optional.
function intentDependency(id: string): Dependency {
  const match = /^settings:([^:]+):([^:]*)$/u.exec(id);
  if (!match || !kinds.has(match[1]!)) return "shared";
  const kind = match[1] as Kind;
  // This command's uncertain external Send has its own durable pending flag.
  // It is not evidence of an uncertain credential/settings write.
  if (
    match[2] === "" &&
    (kind === "connector.verify-app" ||
      kind === "connector.verify-separate-app")
  )
    return "attachment";
  if (match[2] === "" && modelCommands.has(kind)) return "model";
  if (match[2] === "" && browserCommands.has(kind)) return "chat";
  // Computer/connector commands can save the shared document or withdraw its
  // publication. Unknown foreign IDs and new/unproven commands fail closed.
  return "shared";
}
function commandDependency(kind: Kind): Dependency {
  if (
    kind === "connector.verify-app" ||
    kind === "connector.verify-separate-app" ||
    kind === "connector.check-attachment" ||
    kind === "connector.select-chatgpt-app"
  )
    return "attachment";
  if (modelCommands.has(kind)) return "model";
  if (browserCommands.has(kind) || kind.startsWith("chatgpt.")) return "chat";
  if (kind.startsWith("computer.") || kind.startsWith("connector."))
    return "computer";
  return "shared";
}
function conflicts(source: Dependency, target: Dependency): boolean {
  return source === "shared" || target === "shared" || source === target;
}

export function dependencyFences(
  snapshot: WindowSnapshot,
  target: Dependency,
  local: readonly Intent[] = [],
  observingModel = false,
  observingAttachment = false,
) {
  const settings =
    snapshot.configuration?.status === "ready"
      ? snapshot.configuration.settings
      : null;
  const attachmentConfirmed = setupCompletionChecks(settings, {
    buildId: snapshot.buildId ?? "",
    current:
      snapshot.status === "current" &&
      snapshot.runtime === "ready" &&
      snapshot.update.phase !== "applying",
    signInObservation: snapshot.signInObservation ?? null,
    signInCheck: snapshot.setupSignInCheck ?? null,
  }).attachment;
  let pending = false;
  let unknown = Boolean(
    settings &&
    (settings.computer.pendingEdit ||
      settings.setup.computer.outcomeUnknown ||
      connectorRuntimeUncertain(settings) ||
      (target === "attachment" &&
        !observingAttachment &&
        settings.setup.connect.outcomeUnknown) ||
      settings.setup.hosts.outcomeUnknown ||
      settings.setup.verify.outcomeUnknown ||
      settings.connectors.secureMcp.runtime?.state === "outcome_unknown" ||
      (settings.setup.chatgpt.outcomeUnknown && conflicts("chat", target))),
  );
  const inspect = (intent: Intent, key = intent.id, retained = true) => {
    // A writer may return a refusal after an uncertain save/read-back. A
    // refused receipt is not proof that its publication never happened.
    if (intent.code === "SETTINGS_WRITE_FAILED") unknown = true;
    if (intent.state !== "pending" && intent.state !== "unknown") return;
    let source =
      key === intent.id && retained ? intentDependency(intent.id) : "shared";
    if (
      source === "attachment" &&
      intent.state === "unknown" &&
      !(
        (settings?.connectors.secureMcp.appVerificationPending === true ||
          attachmentConfirmed) &&
        intent.code === "CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN"
      )
    )
      source = "shared";
    // A matching current receipt qualifies today's fact without rewriting the
    // earlier Send's history. Readback may inspect that fact, never replay Send.
    if (
      source === "attachment" &&
      intent.state === "unknown" &&
      intent.code === "CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN" &&
      (observingAttachment || attachmentConfirmed)
    )
      return;
    if (observingModel && source === "model") return;
    if (!conflicts(source, target)) return;
    pending ||= intent.state === "pending";
    unknown ||= intent.state === "unknown";
  };
  Object.entries(snapshot.intents).forEach(([key, intent]) =>
    inspect(intent, key),
  );
  local.forEach((intent) =>
    inspect(
      intent,
      intent.id,
      intent.state !== "unknown" ||
        snapshot.intents[intent.id]?.state === "unknown",
    ),
  );
  return { pending, unknown };
}

// A known shell can present its isolated browser without Computer or Settings
// readiness. This grants no configuration, task, Send or sign-in authority.
export function browserPresentationAllowed(snapshot: WindowSnapshot): boolean {
  return (
    snapshot.buildId !== null &&
    snapshot.status !== "starting" &&
    snapshot.status !== "incompatible" &&
    snapshot.update.phase !== "applying"
  );
}

export function commandAllowed(
  snapshot: WindowSnapshot,
  kind: Kind,
  workspaceId?: string,
  local: readonly Intent[] = [],
) {
  if (kind === "chatgpt.present-browser")
    return (
      browserPresentationAllowed(snapshot) &&
      ![snapshot.intents["settings:chatgpt.present-browser:"], ...local].some(
        (intent) =>
          intent?.id === "settings:chatgpt.present-browser:" &&
          (intent.state === "pending" || intent.state === "unknown"),
      )
    );
  if (
    !kinds.has(kind) ||
    snapshot.status !== "current" ||
    snapshot.runtime !== "ready" ||
    !snapshot.buildId ||
    snapshot.configuration?.status !== "ready"
  )
    return false;
  const id = `settings:${kind}:${workspaceId ?? ""}`;
  if (
    [snapshot.intents[id], ...local.filter((item) => item.id === id)].some(
      (item) => item?.state === "pending" || item?.state === "unknown",
    )
  )
    return false;
  if (
    workspaceId &&
    !snapshot.configuration.settings.computer.workspaces.some(
      (workspace) => workspace.workspaceId === workspaceId,
    )
  )
    return false;
  const fences = dependencyFences(
    snapshot,
    commandDependency(kind),
    local,
    kind === "model.status",
    kind === "connector.check-attachment" ||
      kind === "connector.verify-separate-app",
  );
  return !fences.pending && !fences.unknown;
}
