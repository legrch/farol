import { describe, expect, it } from "vitest";
import { onboardingHelpUrl } from "../../src/apps/desktop/onboarding-help";
import {
  ProductConfigurationCommandSchema,
  ProductConfigurationEvidenceSchema,
} from "../../src/pkg/product-settings/contract";
import { fixtureWorkspaceId } from "../fixtures/guided-onboarding";

describe("fixed onboarding help destinations", () => {
  it("opens the public tunnel settings and ChatGPT Plugins destinations", () => {
    expect(onboardingHelpUrl("tunnels")).toBe(
      "https://platform.openai.com/settings/organization/tunnels",
    );
    expect(onboardingHelpUrl("chatgpt")).toBe("https://chatgpt.com/plugins");
  });
  it.each(["tunnels", "chatgpt"])(
    "accepts the named %s action",
    (destination) => {
      expect(
        ProductConfigurationCommandSchema.safeParse({
          kind: "onboarding.open-help",
          destination,
        }).success,
      ).toBe(true);
    },
  );
  it.each([
    { destination: "https://example.invalid/" },
    { destination: "file:///etc/passwd" },
    { destination: "javascript:alert(1)" },
    { destination: "tunnels", url: "https://example.invalid/" },
    { destination: "tunnels", runtimeKey: "synthetic-not-a-real-secret" },
  ])("refuses caller-controlled URLs or additional data: %j", (input) => {
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "onboarding.open-help",
        ...input,
      }).success,
    ).toBe(false);
  });
  it("fails closed even if an untyped caller reaches the resolver", () => {
    expect(() => onboardingHelpUrl("file:///etc/passwd" as "tunnels")).toThrow(
      "ONBOARDING_HELP_DESTINATION_INVALID",
    );
  });
});

describe("native folder selection receipt", () => {
  it("reports an exact approved workspace ID without inventing a listing", () => {
    expect(
      ProductConfigurationEvidenceSchema.parse({
        kind: "computer.workspace-selection",
        workspaceId: fixtureWorkspaceId,
      }),
    ).toEqual({
      kind: "computer.workspace-selection",
      workspaceId: fixtureWorkspaceId,
    });
  });
  it("does not let a selection receipt carry a caller-provided path", () => {
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "computer.workspace-selection",
        workspaceId: fixtureWorkspaceId,
        root: "/arbitrary/path",
      }).success,
    ).toBe(false);
  });
});
