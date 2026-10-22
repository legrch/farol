import { describe, expect, it } from "vitest";
import { modelCatalogue } from "../../src/apps/desktop/codex-chatgpt-provider";
import { ROUTE_B_MODEL } from "../../src/apps/desktop/route-b-runtime";
import { ProductConfigurationEvidenceSchema } from "../../src/pkg/product-settings/contract";

describe("the single new-task ChatGPT identity", () => {
  it("advertises the provider-local ID without claiming an upstream model or permission profile", () => {
    expect(ROUTE_B_MODEL).toBe("chatgpt");
    expect(modelCatalogue(ROUTE_B_MODEL)).toMatchObject({
      id: "chatgpt",
      slug: "chatgpt",
      owned_by: "farol",
      display_name: "ChatGPT",
    });
    expect(modelCatalogue(ROUTE_B_MODEL).description).toContain("permissions");
    expect(modelCatalogue(ROUTE_B_MODEL).base_instructions).toContain(
      "Never switch provider or model silently",
    );
  });

  it("does not accept historical or compound route receipts as new proof", () => {
    const evidence = {
      kind: "host.route-b",
      provider: "farol",
      model: "chatgpt",
      deltaCount: 1,
      observedCharacters: 5,
    };
    expect(ProductConfigurationEvidenceSchema.safeParse(evidence).success).toBe(
      true,
    );
    for (const model of [
      "legacy-route/chatgpt",
      "legacy-route/mind",
      "legacy-route/drive",
      "farol/chatgpt",
      "gpt-6-astra",
      "chatgpt-release-a",
    ]) {
      expect(
        ProductConfigurationEvidenceSchema.safeParse({ ...evidence, model })
          .success,
      ).toBe(false);
    }
    for (const provider of ["legacy_provider", "openai"]) {
      expect(
        ProductConfigurationEvidenceSchema.safeParse({ ...evidence, provider })
          .success,
      ).toBe(false);
    }
  });

  it("never relabels a historical or unknown ID as the current default", () => {
    for (const model of [
      "legacy-route/mind",
      "legacy-route/drive",
      "unknown",
    ]) {
      expect(modelCatalogue(model)).toMatchObject({
        id: model,
        display_name: model,
      });
    }
  });
});
