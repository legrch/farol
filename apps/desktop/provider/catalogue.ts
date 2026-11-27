import {
  CHATGPT_MODEL_ID,
  FAROL_PROVIDER_ID,
  findFarolModel,
} from "../../../src/pkg/model-route/contract";

// The one model entry the provider lists for the host's catalogue request.

export function modelCatalogue(
  model: string,
): Readonly<Record<string, unknown>> {
  const entry = findFarolModel({ provider: FAROL_PROVIDER_ID, model });
  const displayName = entry?.displayName ?? model;
  return {
    id: model,
    object: "model",
    owned_by: FAROL_PROVIDER_ID,
    slug: model,
    display_name: displayName,
    description:
      model === CHATGPT_MODEL_ID
        ? "ChatGPT through Farol. Stable default alias; the upstream selection is verified separately. Native tools retain the host task's permissions."
        : "An explicitly selected Farol model route; native tools retain the host task's permissions.",
    supported_reasoning_levels: [
      {
        effort: "low",
        description:
          "Bounded transport check. The observed ChatGPT model and mode are verified separately before a live readiness claim.",
      },
    ],
    default_reasoning_level: "low",
    shell_type: "unified_exec",
    visibility: "list",
    supported_in_api: true,
    priority: 100,
    support_verbosity: false,
    truncation_policy: { mode: "tokens", limit: 8192 },
    experimental_supported_tools: [],
    base_instructions:
      "Use the isolated Farol provider route selected for this task. Keep native tools under the host task's own sandbox, approvals, and exact registry. Never switch provider or model silently.",
  };
}
