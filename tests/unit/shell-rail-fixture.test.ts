import { expect, it } from "vitest";
import { shellRailFixture } from "../e2e/shell-rail-fixture";

it("ready fixture construction cannot leak connection evidence into unfinished state", () => {
  const ready = shellRailFixture(true);
  const unfinished = shellRailFixture(false);
  expect(ready.configuration.settings.connectors.secureMcp.runtime?.state).toBe(
    "ready",
  );
  expect(
    unfinished.configuration.settings.connectors.secureMcp.runtime,
  ).toBeNull();
  expect(
    unfinished.configuration.settings.connectors.secureMcp.tunnelId,
  ).toBeNull();
  expect(
    unfinished.configuration.settings.connectors.secureMcp.attachment,
  ).toBeNull();
  expect(unfinished.configuration.settings.computer.workspaces).toEqual([]);
  expect(unfinished.configuration.settings.setup.chatgpt.verified).toBeNull();
});
