import { describe, expect, it } from "vitest";
import { mount, readySettings } from "./setup-fixture";
// Current React/controller and scripted receipts. These are not native E2E proofs.
describe("current Setup evidence", () => {
  it("does not manufacture ready marks from the welcome illustration", async () => {
    const h = await mount();
    expect(
      h.host.querySelectorAll('[data-check-state="verified"]'),
    ).toHaveLength(0);
    expect(h.button("Start using Farol")).toBeUndefined();
    expect(h.f.api.configure).not.toHaveBeenCalled();
  });
  it("keeps local connection distinct from ChatGPT attachment", async () => {
    const h = await mount({ step: "attachment", value: readySettings() });
    expect(h.button("Start using Farol")?.disabled).toBe(true);
    expect(h.host.textContent).not.toContain("Everything works");
  });
  it("withdraws completion when attachment belongs to another build or generation", async () => {
    for (const mismatch of ["build", "generation"]) {
      const value = readySettings(true);
      if (mismatch === "build")
        value.connectors.secureMcp.attachment!.buildId = "f".repeat(64);
      else value.connectors.secureMcp.attachment!.computerGeneration++;
      const h = await mount({ step: "attachment", value });
      expect(h.button("Start using Farol")?.disabled).toBe(true);
    }
  });
  it("never reports file access from an empty workspace catalogue", async () => {
    const value = readySettings(true);
    value.computer.workspaces = [];
    value.setup.computer.verified = null;
    const h = await mount({ step: "folders", value });
    expect(h.button("Continue")?.disabled).toBe(true);
    expect(
      h.host.querySelectorAll(".workspace-row-result .setup-success"),
    ).toHaveLength(0);
  });
  it("keeps unknown effects unverified after a background settings publication", async () => {
    const h = await mount({ step: "attachment", value: readySettings(true) });
    const value = readySettings(true);
    value.revision = 2;
    value.setup.connect.outcomeUnknown = true;
    await h.publish(value);
    expect(h.button("Start using Farol")?.disabled).toBe(true);
    expect(h.host.textContent).not.toContain("Everything works");
  });
});
