import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  SETUP_MEDIA_MANIFEST,
  findSetupMediaSlot,
  parseSetupMediaManifest,
  resolveManifestClips,
  shouldRenderClip,
  type SetupMediaManifest,
} from "../../src/ui/setup-media";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function validSlot(
  overrides: Partial<SetupMediaManifest[number]> = {},
): SetupMediaManifest[number] {
  return {
    id: "create-tunnel",
    title: "Create a Secure MCP Tunnel",
    instructionsVersion: 1,
    locale: "en",
    steps: ["Do the one thing."],
    ...overrides,
  };
}

describe("setup media manifest", () => {
  it("parses a well-formed manifest", () => {
    expect(parseSetupMediaManifest([validSlot()])).toEqual([validSlot()]);
  });

  it("rejects a manifest with a duplicate slot id", () => {
    expect(() => parseSetupMediaManifest([validSlot(), validSlot()])).toThrow();
  });

  it("rejects an unknown slot id", () => {
    expect(() =>
      parseSetupMediaManifest([{ ...validSlot(), id: "not-a-real-slot" }]),
    ).toThrow();
  });

  it("rejects an empty steps array", () => {
    expect(() => parseSetupMediaManifest([validSlot({ steps: [] })])).toThrow();
  });

  it("finds a slot by id and reports undefined for one that is not present", () => {
    const manifest = parseSetupMediaManifest([
      validSlot({ id: "create-tunnel" }),
      validSlot({ id: "create-key" }),
    ]);
    expect(findSetupMediaSlot(manifest, "create-key")?.id).toBe("create-key");
    expect(findSetupMediaSlot(manifest, "attach-connector")).toBeUndefined();
  });

  describe("shouldRenderClip", () => {
    it("never renders a clip when the manifest names none — the shipped default today", () => {
      expect(shouldRenderClip(validSlot(), true)).toBe(false);
      expect(shouldRenderClip(validSlot(), false)).toBe(false);
    });

    it("never renders a clip whose file the caller could not confirm exists", () => {
      const slot = validSlot({
        clip: {
          file: "clips/create-tunnel.mp4",
          poster: "clips/create-tunnel.jpg",
          captions: "clips/create-tunnel.vtt",
        },
      });
      expect(shouldRenderClip(slot, false)).toBe(false);
    });

    it("renders a clip only once the manifest names one AND the file is confirmed present", () => {
      const slot = validSlot({
        clip: {
          file: "clips/create-tunnel.mp4",
          poster: "clips/create-tunnel.jpg",
          captions: "clips/create-tunnel.vtt",
        },
      });
      expect(shouldRenderClip(slot, true)).toBe(true);
    });
  });

  describe("resolveManifestClips", () => {
    it("drops a clip whose file does not exist on disk", () => {
      const manifest = parseSetupMediaManifest([
        validSlot({
          clip: {
            file: "clips/missing.mp4",
            poster: "clips/missing.jpg",
            captions: "clips/missing.vtt",
          },
        }),
      ]);
      const resolved = resolveManifestClips(manifest, () => false);
      expect(resolved[0]?.clip).toBeNull();
    });

    it("keeps a clip whose file and poster both exist on disk", () => {
      const manifest = parseSetupMediaManifest([
        validSlot({
          clip: {
            file: "clips/present.mp4",
            poster: "clips/present.jpg",
            captions: "clips/present.vtt",
          },
        }),
      ]);
      const resolved = resolveManifestClips(manifest, () => true);
      expect(resolved[0]?.clip).toEqual({
        file: "clips/present.mp4",
        poster: "clips/present.jpg",
        captions: "clips/present.vtt",
      });
    });

    it("normalizes a slot with no clip to an explicit null, never a broken reference", () => {
      const manifest = parseSetupMediaManifest([validSlot()]);
      const resolved = resolveManifestClips(manifest, () => true);
      expect(resolved[0]?.clip ?? null).toBeNull();
    });
  });

  it("ships no clip for any of today's three slots", () => {
    for (const slot of SETUP_MEDIA_MANIFEST) {
      expect(slot.clip ?? null).toBeNull();
    }
  });

  it("covers exactly the three external steps this Setup step cannot verify on its own", () => {
    expect(SETUP_MEDIA_MANIFEST.map((slot) => slot.id).sort()).toEqual([
      "attach-connector",
      "create-key",
      "create-tunnel",
    ]);
  });

  it("stays byte-for-byte in sync with resources/setup-media.json", async () => {
    const resourcePath = path.join(
      __dirname,
      "..",
      "..",
      "resources",
      "setup-media.json",
    );
    const raw = await fs.readFile(resourcePath, "utf8");
    const fromDisk = parseSetupMediaManifest(JSON.parse(raw) as unknown);
    expect(fromDisk).toEqual(SETUP_MEDIA_MANIFEST);
  });

  it("only reuses URLs already published in this repository's docs (docs/setup-links.md)", async () => {
    const docsPath = path.join(__dirname, "..", "..", "docs", "setup-links.md");
    const docs = await fs.readFile(docsPath, "utf8");
    const urlPattern = /https?:\/\/[^\s)"'`]+/gu;
    for (const slot of SETUP_MEDIA_MANIFEST) {
      for (const step of slot.steps) {
        const urls = step.match(urlPattern) ?? [];
        for (const url of urls) {
          expect(docs.includes(url.replace(/[.,]$/u, ""))).toBe(true);
        }
      }
    }
  });
});
