import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const vnextRoot = path.resolve(import.meta.dirname, "../..");

describe("Farol Next resource ownership", () => {
  it("declares every implemented identity and keeps absent integrations absent", async () => {
    const manifest = JSON.parse(
      await fs.readFile(path.join(vnextRoot, "resources.json"), "utf8"),
    );

    expect(manifest).toMatchObject({
      schema: "farol.next.resource-manifest/1",
      product: {
        name: "Farol Next Preview",
        version: "0.1.0-preview.0",
        bundleId: "local.farol.next.preview",
      },
      application: {
        singleInstanceScope: "userData",
        browserPartition: "persist:farol-next-preview",
      },
      runtime: {
        port: "os-allocated-loopback",
        bearer: "per-launch-memory-only",
      },
      integrations: {
        tunnel: "absent",
        mcpRegistration: "absent",
        providerRegistration: "absent",
        updater: "absent",
      },
    });
    expect(manifest.exclusions).toEqual(
      expect.arrayContaining([
        "~/.farol",
        "local.farol.app",
        "persist:farol-chatgpt",
        "codex-chatgpt-web",
      ]),
    );
  });
});
