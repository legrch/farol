import path from "node:path";
import { describe, expect, it } from "vitest";
import { desktopIdentity } from "../../src/apps/desktop/desktop-environment";

describe("Farol Dev naming contract", () => {
  const appData = "/private/tmp/Owner's Mac/Application Support";

  it("uses title case for human names without changing machine identities", () => {
    expect(desktopIdentity("dev", appData)).toMatchObject({
      displayName: "Farol Dev",
      applicationName: "Farol Dev",
      runtimeServiceName: "Farol Dev Runtime",
      environment: "dev",
      applicationId: "local.farol.dev",
      runtimeIdentity: "farol-dev-runtime",
      runtimePartition: "persist:farol-dev-runtime",
      chatGptPartition: "persist:farol-dev-chatgpt",
    });
  });

  it("uses the explicit new-install directory, including paths with spaces", () => {
    const identity = desktopIdentity("dev", appData);
    expect(identity.userData).toBe(path.join(appData, "Farol Dev"));
    expect(identity.sessionData).toBe(identity.userData);
    expect(identity.codexHome).toBe(
      path.join(identity.userData, "farol-next-private", "codex-home"),
    );
  });

  it("does not rename or reuse the packaged Preview identity", () => {
    expect(desktopIdentity("preview", appData)).toMatchObject({
      displayName: "Farol",
      applicationName: "Farol Next Preview",
      applicationId: "local.farol.next.preview",
      userData: path.join(appData, "Farol Next Preview"),
      runtimeIdentity: "farol-next-preview-runtime",
      runtimeServiceName: "Farol Next Runtime",
    });
  });
});
