import { CHATGPT_MODEL_ID } from "../../pkg/model-route/contract.ts";

// Task 39 foundation: these routes have no production qualification yet.
// A saved setting or a restarted app must not turn either route on.
export const FAROL_MODEL_ENABLED = false;
export const FAROL_BACKED_PRODUCT_AGENT_ENABLED = false;

export type FarolBackedProductAgentRoute = Readonly<{
  model: typeof CHATGPT_MODEL_ID;
  effort: "low";
}>;

export function farolBackedProductAgentRoute(
  enabled = FAROL_BACKED_PRODUCT_AGENT_ENABLED,
): FarolBackedProductAgentRoute | null {
  return enabled ? { model: CHATGPT_MODEL_ID, effort: "low" } : null;
}
