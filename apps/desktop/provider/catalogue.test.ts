import { describe, expect, it } from "vitest";
import {
  CHATGPT_MODEL_ID,
  FAROL_PROVIDER_ID,
} from "../../../src/pkg/model-route/contract";
import { modelCatalogue } from "./catalogue";

describe("provider model catalogue", () => {
  it("describes the stable ChatGPT alias with a low reasoning level", () => {
    const entry = modelCatalogue(CHATGPT_MODEL_ID);
    expect(entry).toMatchObject({
      id: CHATGPT_MODEL_ID,
      slug: CHATGPT_MODEL_ID,
      object: "model",
      owned_by: FAROL_PROVIDER_ID,
      default_reasoning_level: "low",
      visibility: "list",
    });
    expect(String(entry.description)).toContain("Stable default alias");
  });

  it("describes any other model as an explicit selection under its own name", () => {
    const entry = modelCatalogue("unlisted-model");
    expect(entry).toMatchObject({
      id: "unlisted-model",
      display_name: "unlisted-model",
    });
    expect(String(entry.description)).toContain("explicitly selected");
  });
});
