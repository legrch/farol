import type { ProductTaskContext } from "../modules/chat/contract/product-task";

export type ContextTaskPresentation = Readonly<{
  tone: "running" | "waiting" | "failed" | "unknown" | "unavailable";
  label: string;
  attention: boolean;
  locked: true;
}>;

export function contextTaskPresentation(
  context: ProductTaskContext | null | undefined,
): ContextTaskPresentation | null {
  if (!context || context.phase === "active") return null;
  if (context.phase === "blocked") {
    return context.code === "SUMMARY_SIGN_IN_REQUIRED"
      ? {
          tone: "unavailable",
          label: "Context needs sign-in",
          attention: true,
          locked: true,
        }
      : {
          tone: "failed",
          label: "Context blocked",
          attention: true,
          locked: true,
        };
  }
  if (context.phase === "outcome_unknown") {
    return {
      tone: "unknown",
      label: "Context outcome unknown",
      attention: true,
      locked: true,
    };
  }
  if (context.phase === "handoff_offered") {
    return {
      tone: "waiting",
      label: "Installing context",
      attention: false,
      locked: true,
    };
  }
  if (
    context.phase === "host_context_confirmed" ||
    context.phase === "old_epoch_retired"
  ) {
    return {
      tone: "running",
      label: "Switching context",
      attention: false,
      locked: true,
    };
  }
  return {
    tone: "running",
    label:
      context.source === "canonical_history"
        ? "Recovering from history"
        : "Preserving context",
    attention: false,
    locked: true,
  };
}
