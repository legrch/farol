import { describe, expect, it } from "vitest";
import {
  CHATGPT_ROUTE,
  FAROL_MODEL_CATALOGUE,
  FarolModelIdSchema,
  FarolModelRouteSchema,
  findFarolModel,
  formatFarolModelRoute,
} from "../../src/pkg/model-route/contract";

describe("Farol provider-local model names", () => {
  it("keeps separate wire fields and formats a composite name only for display", () => {
    expect(CHATGPT_ROUTE).toEqual({ provider: "farol", model: "chatgpt" });
    expect(formatFarolModelRoute(CHATGPT_ROUTE)).toBe("farol/chatgpt");
    expect(Object.isFrozen(CHATGPT_ROUTE)).toBe(true);
  });

  it.each([
    "farol/chatgpt",
    "farol-next/chatgpt",
    "ChatGPT",
    " chatgpt",
    "chatgpt ",
    "chatgpt\n",
    "chatgpt--release",
    "chatgpt-",
    "../chatgpt",
    "chatgpt%2Frelease",
    "",
  ])(
    "rejects malformed or compound wire model %j without normalizing it",
    (model) => {
      expect(FarolModelIdSchema.safeParse(model).success).toBe(false);
      expect(findFarolModel({ provider: "farol", model })).toBeNull();
    },
  );

  it("allows future names syntactically without advertising unimplemented routes", () => {
    for (const model of [
      "chatgpt-gpt-5.5",
      "chatgpt-release-a",
      "deepseek",
      "deepseek-flash-4.1",
      "kimi",
    ]) {
      expect(FarolModelIdSchema.safeParse(model).success).toBe(true);
      expect(findFarolModel({ provider: "farol", model })).toBeNull();
    }
  });

  it("defines chatgpt as a floating default policy, not an exact version pin", () => {
    expect(findFarolModel(CHATGPT_ROUTE)).toEqual({
      id: "chatgpt",
      displayName: "ChatGPT",
      upstream: "chatgpt",
      selection: "latest-qualified",
    });
    expect(FAROL_MODEL_CATALOGUE.map((entry) => entry.id)).toEqual(["chatgpt"]);
    expect(Object.isFrozen(FAROL_MODEL_CATALOGUE)).toBe(true);
    expect(Object.isFrozen(FAROL_MODEL_CATALOGUE[0])).toBe(true);
  });

  it("requires the exact Farol provider without interpreting a slash", () => {
    for (const provider of ["farol_next", "openai", "farol/chatgpt", "Farol"]) {
      const route = { provider, model: "chatgpt" };
      expect(FarolModelRouteSchema.safeParse(route).success).toBe(false);
      expect(findFarolModel(route)).toBeNull();
      expect(() => formatFarolModelRoute(route)).toThrow();
    }
    expect(findFarolModel("farol/chatgpt")).toBeNull();
    expect(findFarolModel({ ...CHATGPT_ROUTE, extra: "ignored?" })).toBeNull();
  });
});
