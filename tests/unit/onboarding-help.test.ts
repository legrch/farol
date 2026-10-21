import { describe, expect, it } from "vitest";
import {
  onboardingHelpUrl,
  openOnboardingHelp,
} from "../../src/apps/desktop/onboarding-help";
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
  it.each(["tunnels", "api-keys", "chatgpt", "setup-guide"])(
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
  it("opens the repository setup guide through the same fixed destination policy", async () => {
    const external: string[] = [];
    expect(onboardingHelpUrl("setup-guide")).toBe(
      "https://github.com/legrch/farol/blob/main/docs/setup-connection.md",
    );
    expect(
      await openOnboardingHelp("setup-guide", async (url) => {
        external.push(url);
      }),
    ).toBe(true);
    expect(external).toEqual([onboardingHelpUrl("setup-guide")]);
    expect(
      await openOnboardingHelp("setup-guide", async () => {
        throw new Error("open refused");
      }),
    ).toBe(false);
    expect(
      await openOnboardingHelp("https://example.invalid", async (url) => {
        external.push(url);
      }),
    ).toBe(false);
    expect(external).toHaveLength(1);
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
