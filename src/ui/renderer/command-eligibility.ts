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
// configuration/dispatch.ts configureAdmittedProduct's model cases touch the model endpoint or
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
    (match[2] === "" || /^[a-f0-9]{64}$/u.test(match[2]!)) &&
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
    kind === "connector.test-connection" ||
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

/**
 * Whether main's retained credential recovery names exactly the fenced
 * document this window holds. Advisory presentation, never owner authority:
 * main re-validates generation, revision, key digest and tunnel on every retry.
 */
export function credentialRecoveryMatches(snapshot: WindowSnapshot): boolean {
  const recovery = snapshot.credentialRecovery;
  if (!recovery || snapshot.configuration?.status !== "ready") return false;
  const settings = snapshot.configuration.settings;
  return (
    settings.setup.connect.outcomeUnknown &&
    settings.connectors.secureMcp.generation === recovery.generation &&
    settings.revision === recovery.revision
  );
}
// The failed attempt of the one command that may recover the fence. Its
// receipt is the uncertainty main holds the recovery for; it stops fencing only
// that command, and only while the exact recovery is retained.
const recoverableAttempt = /^settings:connector\.save-and-connect:/u;

/**
 * An uncertain save-and-connect receipt the current document has outgrown.
 * The receipt itself is never rewritten: it keeps its recorded outcome in
 * Activity. It stops fencing once the snapshot shows the fence settled and the
 * key stored, and a later save-and-connect receipt of this window ended
 * known (applied or refused). Main only accepts that later command over its
 * retained recovery, so the earlier effect is settled, whatever the later
 * Start did.
 */
export function attemptOutgrown(
  intent: Intent,
  snapshot: WindowSnapshot,
  local: readonly Intent[] = [],
): boolean {
  if (
    !recoverableAttempt.test(intent.id) ||
    intent.state === "pending" ||
    (intent.state !== "unknown" && intent.code !== "SETTINGS_WRITE_FAILED") ||
    snapshot.configuration?.status !== "ready"
  )
    return false;
  const settings = snapshot.configuration.settings;
  const order = snapshot.setupCheckOrder?.[intent.id];
  if (
    settings.setup.connect.outcomeUnknown ||
    settings.connectors.secureMcp.credential !== "stored" ||
    !order
  )
    return false;
  return [...Object.values(snapshot.intents), ...local].some(
    (receipt) =>
      receipt.id !== intent.id &&
      recoverableAttempt.test(receipt.id) &&
      (receipt.state === "applied" || receipt.state === "refused") &&
      (snapshot.setupCheckOrder?.[receipt.id] ?? 0) > order,
  );
}

export function dependencyFences(
  snapshot: WindowSnapshot,
  target: Dependency,
  local: readonly Intent[] = [],
  observingModel = false,
  observingAttachment = false,
  recovering = false,
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
      // A recoverable credential fence is the connect fence alone; an
      // uncertain runtime still refuses through the explicit term below.
      (!recovering && connectorRuntimeUncertain(settings)) ||
      (target === "attachment" &&
        !observingAttachment &&
        settings.setup.connect.outcomeUnknown) ||
      settings.setup.hosts.outcomeUnknown ||
      settings.setup.verify.outcomeUnknown ||
      settings.connectors.secureMcp.runtime?.state === "outcome_unknown" ||
      (settings.setup.chatgpt.outcomeUnknown && conflicts("chat", target))),
  );
  const inspect = (intent: Intent, key = intent.id, retained = true) => {
    if (attemptOutgrown(intent, snapshot, local)) return;
    if (
      recovering &&
      intent.state !== "pending" &&
      recoverableAttempt.test(intent.id)
    )
      return;
    // A writer may return a refusal after an uncertain save/read-back. A
    // refused receipt is not proof that its publication never happened.
    if (intent.code === "SETTINGS_WRITE_FAILED") unknown = true;
    if (intent.state !== "pending" && intent.state !== "unknown") return;
    // These commands retain their own original-attempt custody. Explicit
    // connection checks publish attachment only after Go verification through
    // the existing writer; SETTINGS_WRITE_FAILED was fenced above. External
    // Send uncertainty alone is not an unrelated Settings write uncertainty.
    if (
      key === intent.id &&
      /^(?:deep-test:(?:status|run|ack)|connection-test:run):[0-9a-f-]{36}$/u.test(
        key,
      )
    )
      return;
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
  // Owner Ping is a tunnel diagnostic (@Farol + challenge). Workspace
  // continuity and unrelated Computer pending edits must not disable Send;
  // main still validates the live runtime before the prompt leaves.
  if (kind === "connector.test-connection") return true;
  const fences = dependencyFences(
    snapshot,
    commandDependency(kind),
    local,
    kind === "model.status",
    kind === "connector.check-attachment" ||
      kind === "connector.verify-separate-app",
    kind === "connector.save-and-connect" &&
      credentialRecoveryMatches(snapshot),
  );
  return !fences.pending && !fences.unknown;
}
