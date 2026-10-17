import { describe, expect, it, vi } from "vitest";
import {
  WindowController,
  canSetInstallOnQuitPreference,
} from "../../src/ui/renderer/controller";
import { automaticUpdateAvailable } from "../../src/ui/renderer/update-eligibility";
import { bootstrap, fixture } from "./fixture";

// Renderer projection only; no installed updater, browser or account proof.
describe("owner Preview renderer boundary", () => {
  it("retains its distinct environment without acquiring automatic-update authority", async () => {
    const f = fixture();
    vi.mocked(f.api.bootstrap).mockResolvedValue({
      ...bootstrap(),
      environment: "owner-preview",
    });
    const controller = new WindowController(f.api);
    try {
      await controller.start();
      const current = controller.getSnapshot();
      expect(current.status).toBe("current");
      expect(current.environment).toBe("owner-preview");
      const wouldOtherwiseQualify = {
        ...current,
        update: {
          phase: "idle" as const,
          checkedAt: null,
          automaticUpdatePreference: {
            status: "confirmed" as const,
            enabled: false,
          },
          installOnQuitPreference: {
            status: "confirmed" as const,
            scope: "install-on-normal-quit" as const,
            enabled: false,
          },
        },
      };
      expect(automaticUpdateAvailable(wouldOtherwiseQualify)).toBe(false);
      expect(
        canSetInstallOnQuitPreference(wouldOtherwiseQualify, controller),
      ).toBe(false);
      expect(f.api.configure).not.toHaveBeenCalled();
      expect(f.api.task).not.toHaveBeenCalled();
    } finally {
      controller.dispose();
    }
  });
});
