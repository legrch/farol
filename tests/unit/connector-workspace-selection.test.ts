import { describe, expect, it } from "vitest";
import { connectorWorkspaceSelection } from "../../src/pkg/product-settings/connector-workspace-selection";
import {
  fixtureWorkspaceId,
  guidedSettingsFixture,
} from "../fixtures/guided-onboarding";

describe("connector workspace selection", () => {
  it("distinguishes an intentional empty catalogue from unverified folders", () => {
    const settings = guidedSettingsFixture();
    expect(connectorWorkspaceSelection(settings)).toBe(fixtureWorkspaceId);
    settings.setup.computer.verified = null;
    expect(connectorWorkspaceSelection(settings)).toBeUndefined();
    settings.computer.workspaces = [];
    expect(connectorWorkspaceSelection(settings)).toBeNull();
  });

  it.each(["generation", "removed", "null"])(
    "does not select a stale %s workspace witness",
    (mismatch) => {
      const settings = guidedSettingsFixture();
      if (mismatch === "generation") settings.computer.generation++;
      if (mismatch === "removed")
        settings.setup.computer.verified!.workspaceId =
          "00000000-0000-4000-8000-000000000099";
      if (mismatch === "null")
        settings.setup.computer.verified!.workspaceId = null;
      expect(connectorWorkspaceSelection(settings)).toBeUndefined();
    },
  );
});
