import {
  ProductConfigurationResultSchema,
  type ProductConfigurationResult,
} from "../pkg/product-settings/contract";

/**
 * What actually happened to the `await window.farolNext.configure(command)`
 * call, captured by the caller's own try/catch. This module never touches
 * the IPC bridge itself, so a rejected promise is handed in as plain data
 * instead of being caught here.
 */
export type ConfigurationTransport =
  { settled: "fulfilled"; value: unknown } | { settled: "rejected" };

/**
 * The closed set of outcomes `configureProduct` can render. `applied` and
 * `refused` both mean the main process parsed the command and answered with
 * a valid `ProductConfigurationResult` — a real acceptance or a real,
 * well-formed refusal. `unconfirmed` means the reply itself is not
 * trustworthy (it failed schema validation, or the transport never
 * delivered a reply at all), which is a different situation from a refusal:
 * the main process may already have admitted and applied the command before
 * the reply was lost or malformed.
 */
export type ConfigurationOutcome =
  | {
      kind: "applied";
      result: Extract<ProductConfigurationResult, { ok: true }>;
    }
  | {
      kind: "refused";
      result: Extract<ProductConfigurationResult, { ok: false }>;
    }
  | {
      kind: "unconfirmed";
      reason: "malformed-response" | "transport-rejected";
    };

/**
 * Shown for every `unconfirmed` outcome. It must never say or imply that
 * nothing happened: the command may already have been admitted and applied
 * before the reply failed to parse or the IPC promise rejected, so the only
 * honest statement is that the outcome is unknown and the current state
 * should be checked before retrying.
 */
export const UNCONFIRMED_CONFIGURATION_MESSAGE =
  "The settings result could not be confirmed. The action may already have taken effect. Check the current state before trying again.";

/**
 * Classifies one configuration transport outcome. A rejected transport is
 * unconfirmed without inspecting a value; a fulfilled transport is parsed
 * with the same `ProductConfigurationResultSchema` the caller already
 * validates replies against, and a failed parse is unconfirmed too — both
 * cases share the reasoning above. Only a value that parses cleanly can be
 * `applied` or `refused`, split on the schema's own `ok` discriminant.
 */
export function classifyConfigurationResponse(
  transport: ConfigurationTransport,
): ConfigurationOutcome {
  if (transport.settled === "rejected") {
    return { kind: "unconfirmed", reason: "transport-rejected" };
  }
  const parsed = ProductConfigurationResultSchema.safeParse(transport.value);
  if (!parsed.success) {
    return { kind: "unconfirmed", reason: "malformed-response" };
  }
  return parsed.data.ok
    ? { kind: "applied", result: parsed.data }
    : { kind: "refused", result: parsed.data };
}

// A valid error reply can still describe an effect whose acknowledgement was
// lost after a write. Access workflows must fence those effects for readback.
export function configurationEffectOutcome(
  outcome: ConfigurationOutcome,
): "applied" | "refused" | "unknown" {
  if (outcome.kind === "unconfirmed") return "unknown";
  if (outcome.result.connectorSetup?.state === "unknown") return "unknown";
  if (outcome.kind === "applied") return "applied";
  if (outcome.result.connectorAttempt?.outcome === "unknown") return "unknown";
  return [
    "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
    "CONNECTOR_CREDENTIAL_OUTCOME_UNKNOWN",
    "CONNECTOR_STOP_UNCONFIRMED",
    "CONNECTOR_SETUP_STEP_UNCONFIRMED",
    "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
    "SETTINGS_WRITE_FAILED",
    "CHATGPT_ACCOUNT_APPROVAL_UNCONFIRMED",
    "CHATGPT_CONVERSATION_UNCONFIRMED",
  ].includes(outcome.result.error)
    ? "unknown"
    : "refused";
}
