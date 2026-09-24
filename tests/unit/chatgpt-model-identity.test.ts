import { describe, expect, it } from "vitest";
import { modelCatalogue } from "../../src/apps/desktop/codex-chatgpt-provider";
import { ROUTE_B_MODEL } from "../../src/apps/desktop/route-b-runtime";
import { ProductConfigurationEvidenceSchema } from "../../src/pkg/product-settings/contract";

describe("the single new-task ChatGPT identity", () => {
  it("advertises a neutral route without claiming an upstream model or a permission profile", () => {
    expect(modelCatalogue(ROUTE_B_MODEL)).toMatchObject({
      id: "farol-next/chatgpt",
      slug: "farol-next/chatgpt",
      display_name: "Farol Next ChatGPT",
    });
    expect(modelCatalogue(ROUTE_B_MODEL).description).toContain("permissions");
    expect(modelCatalogue(ROUTE_B_MODEL).base_instructions).toContain(
      "Never switch provider or model silently",
    );
  });

  it("does not accept historical route receipts as proof of the neutral route", () => {
    const evidence = {
      kind: "host.route-b",
      provider: "farol_next",
      model: ROUTE_B_MODEL,
      deltaCount: 1,
      observedCharacters: 5,
    };
    expect(ProductConfigurationEvidenceSchema.safeParse(evidence).success).toBe(
      true,
    );
    for (const model of [
      "farol-next/mind",
      "farol-next/drive",
      "gpt-6-astra",
    ]) {
      expect(
        ProductConfigurationEvidenceSchema.safeParse({ ...evidence, model })
          .success,
      ).toBe(false);
    }
  });

  it("keeps explicitly selected historical catalogue labels distinct", () => {
    expect(modelCatalogue("farol-next/mind").id).toBe("farol-next/mind");
    expect(modelCatalogue("farol-next/drive").id).toBe("farol-next/drive");
    expect(modelCatalogue("unqualified-route").display_name).toBe(
      "unqualified-route",
    );
  });
});
