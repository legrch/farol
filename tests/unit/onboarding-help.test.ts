import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
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
  it.each([
    "/controlled/dev/_output/build/app",
    "/controlled/Farol Dev.app/Contents/Resources/app",
  ])("resolves the guide inside the host bundle at %s", (directory) => {
    const url = new URL(onboardingHelpUrl("setup-guide", directory));
    expect(url.protocol).toBe("file:");
    expect(fileURLToPath(url)).toBe(path.join(directory, "shell.html"));
    expect(url.hash).toBe("#farol-connection-guide");
    expect(url.search).toBe("");
  });
  it.each([undefined, "", "relative/app"])(
    "refuses a guide without an absolute host bundle: %s",
    (directory) => {
      expect(() => onboardingHelpUrl("setup-guide", directory)).toThrow(
        "ONBOARDING_GUIDE_BUNDLE_INVALID",
      );
    },
  );
  it("opens the guide only through the dedicated local handler", async () => {
    const external: string[] = [];
    let guides = 0;
    const open = async (url: string) => {
      external.push(url);
    };
    expect(await openOnboardingHelp("setup-guide", open)).toBe(false);
    expect(
      await openOnboardingHelp("setup-guide", open, async () => {
        guides++;
      }),
    ).toBe(true);
    expect(guides).toBe(1);
    expect(external).toEqual([]);
    expect(
      await openOnboardingHelp("setup-guide", open, async () => {
        throw new Error("local load failed");
      }),
    ).toBe(false);
    expect(await openOnboardingHelp("tunnels", open)).toBe(true);
    expect(external).toEqual([onboardingHelpUrl("tunnels")]);
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
