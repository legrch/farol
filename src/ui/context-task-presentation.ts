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
    if (context.code === "SUMMARY_SIGN_IN_REQUIRED") {
      return {
        tone: "unavailable",
        label: "Context needs sign-in",
        attention: true,
        locked: true,
      };
    }
    if (context.code === "SUMMARY_USAGE_LIMITED") {
      return {
        tone: "unavailable",
        label: "Context usage limited",
        attention: true,
        locked: true,
      };
    }
    // The task's page shows a newer conversation than the one being retired.
    // Nothing is lost or reset; the switch finishes once the page is back on
    // the previous conversation.
    if (context.code === "SOURCE_RETIREMENT_SUPERSEDED") {
      return {
        tone: "waiting",
        label: "Return to the previous conversation",
        attention: true,
        locked: true,
      };
    }
    return {
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
