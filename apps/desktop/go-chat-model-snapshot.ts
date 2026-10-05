import { createHash } from "node:crypto";
import {
  TaskExecutionSettingsSchema,
  taskPolicyIdentity,
} from "../../src/pkg/owner-config/contract.ts";
import { BridgeError } from "./bridge/client.ts";
import {
  validate,
  type ChatModelPolicy,
  type ChatBrowserModelProfile,
} from "./bridge/wire.ts";
import {
  GoChatBrowserDriver,
  type QualifiedControlTranslation,
} from "./go-chat-browser.ts";

export type CompiledChatModelProfile = Readonly<{
  metadata: ChatBrowserModelProfile;
  controls: Pick<
    QualifiedControlTranslation,
    "model" | "effort" | "mode" | "connector"
  >;
}>;

type ChatModelSnapshot = Readonly<{
  policy: ChatModelPolicy;
  profiles: readonly ChatBrowserModelProfile[];
  translations: readonly QualifiedControlTranslation[];
  configSHA256: string;
}>;

function refuse(code: string): never {
  throw new BridgeError("refused", code);
}

function exactKeys(value: unknown, keys: readonly string[]): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function sameValues(
  rows: readonly { value: string }[],
  expected: readonly string[],
): boolean {
  const values = new Set(expected);
  return (
    rows.length === values.size && rows.every((row) => values.has(row.value))
  );
}

function validateCompiled(row: CompiledChatModelProfile): void {
  if (
    !exactKeys(row, ["metadata", "controls"]) ||
    !validate("ChatBrowserModelProfile", row.metadata) ||
    !exactKeys(row.controls, ["model", "effort", "mode", "connector"])
  )
    refuse("chat_model_snapshot_profile_invalid");
  for (const field of ["model", "effort", "mode", "connector"] as const) {
    if (
      !Array.isArray(row.controls[field]) ||
      !row.controls[field].every((control) =>
        exactKeys(control, ["value", "literal"]),
      )
    )
      refuse("chat_model_snapshot_controls_invalid");
  }
  const p = row.metadata;
  const requested = new Set(p.efforts.map((pair) => pair.requested));
  const resolved = p.efforts.map((pair) => pair.resolved);
  // Go opaque IDs have a tighter byte bound than the generated wire ID type.
  if (
    p.id.length > 120 ||
    p.modelId.length > 120 ||
    !p.required.model ||
    p.required.mode !== (p.mode !== "") ||
    p.required.connector ||
    p.efforts.length === 0 ||
    p.efforts.length > 32 ||
    requested.size !== p.efforts.length ||
    (p.defaultEffort !== "" && !resolved.includes(p.defaultEffort))
  )
    refuse("chat_model_snapshot_profile_invalid");
  if (
    !sameValues(row.controls.model, [p.modelId]) ||
    !sameValues(row.controls.effort, resolved) ||
    !sameValues(row.controls.mode, p.mode === "" ? [] : [p.mode]) ||
    // This Go profile carries no connector selection or grant.
    row.controls.connector.length !== 0
  )
    refuse("chat_model_snapshot_controls_mismatch");
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Capture declarations only. Go resolves settings aliases/defaults; the caller
 * supplies qualified routes and owns their lifetime. Later edits need a new
 * capture and cannot refresh an already admitted mapping.
 */
export function captureChatModelSnapshot(
  tasks: unknown,
  profiles: readonly CompiledChatModelProfile[],
): ChatModelSnapshot {
  try {
    const parsed = TaskExecutionSettingsSchema.safeParse(tasks);
    if (!parsed.success) refuse("chat_model_snapshot_config_invalid");
    if (
      !Array.isArray(profiles) ||
      profiles.length === 0 ||
      profiles.length > 128
    )
      refuse("chat_model_snapshot_profiles_missing");
    const config = parsed.data;
    const policy: ChatModelPolicy = {
      defaultHarness: config.defaultHarness,
      harnesses: Object.keys(config.harnesses)
        .sort()
        .map((name) => {
          const harness = config.harnesses[name]!;
          return {
            name,
            defaultModel: harness.defaultModel,
            models: Object.keys(harness.models)
              .sort()
              .map((alias) => {
                const model = harness.models[alias]!;
                return {
                  alias,
                  model: model.model,
                  ...(model.defaultEffort === undefined
                    ? {}
                    : { defaultEffort: model.defaultEffort }),
                };
              }),
          };
        }),
    };
    if (!validate("ChatModelPolicy", policy))
      refuse("chat_model_snapshot_config_invalid");
    const configSHA256 = createHash("sha256")
      .update(taskPolicyIdentity(config), "utf8")
      .digest("hex");
    const compiled = structuredClone(profiles);
    const ids = new Set<string>();
    const routes = new Set<string>();
    const translations = compiled.map((row): QualifiedControlTranslation => {
      validateCompiled(row);
      const route = JSON.stringify([
        row.metadata.executor,
        row.metadata.runtimeModel,
      ]);
      if (ids.has(row.metadata.id) || routes.has(route))
        refuse("chat_model_snapshot_profile_ambiguous");
      ids.add(row.metadata.id);
      routes.add(route);
      return {
        ...row.controls,
        version: "public-controls-v1",
        configSHA256,
        translationId: row.metadata.id,
      };
    });
    // Constructor validation only: no assigned browser, lookup, clock or IO.
    new GoChatBrowserDriver({ lookup: () => undefined, translations });
    return freeze({
      policy,
      profiles: compiled.map((row) => row.metadata),
      translations,
      configSHA256,
    });
  } catch (error) {
    if (error instanceof BridgeError && error.state === "refused") throw error;
    return refuse("chat_model_snapshot_invalid_input");
  }
}
