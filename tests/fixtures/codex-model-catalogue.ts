/** Synthetic protocol catalogue. Never evidence about an account. */
export function catalogueModel(
  model: string,
  efforts: readonly string[] = ["medium", "high", "low", "xhigh"],
) {
  return {
    id: `picker-${model}`,
    model,
    displayName: model,
    hidden: false,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
      reasoningEffort,
      description: "fixture",
    })),
    defaultReasoningEffort: efforts[0] ?? null,
  };
}
