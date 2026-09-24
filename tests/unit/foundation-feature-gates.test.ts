import { describe, expect, it } from "vitest";

import {
  FAROL_BACKED_PRODUCT_AGENT_ENABLED,
  FAROL_MODEL_ENABLED,
  farolBackedProductAgentRoute,
} from "../../src/apps/desktop/foundation-feature-gates";

describe("unqualified production routes", () => {
  it("keeps unqualified production routes disabled", () => {
    expect(FAROL_MODEL_ENABLED).toBe(false);
    expect(FAROL_BACKED_PRODUCT_AGENT_ENABLED).toBe(false);
    expect(farolBackedProductAgentRoute()).toBeNull();
  });

  it("selects the explicit Farol provider-local route if separately qualified", () => {
    expect(farolBackedProductAgentRoute(true)).toEqual({
      model: "chatgpt",
      effort: "low",
    });
  });
});
