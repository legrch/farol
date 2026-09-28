import { describe, expect, it } from "vitest";
import manifest from "../../src/modules/computer/infra/mcp/computer-guidance.json";
import { PublishedGuidance } from "../../src/modules/computer/infra/mcp/published-guidance";

describe("sealed Computer guidance manifest", () => {
  it("ranks only published entries, bounds results and resolves every reference", () => {
    const guidance = new PublishedGuidance();
    const ranked = guidance.search("workspace instructions", 1);
    expect(ranked).toMatchObject({
      ok: true,
      resultLimited: true,
      entries: [{ id: "computer-start", score: 2 }],
    });
    for (const entry of manifest.entries) {
      expect(guidance.fetch(entry.id)).toMatchObject({ ok: true, entry });
      for (const id of entry.references)
        expect(guidance.fetch(id)).toMatchObject({ ok: true, entry: { id } });
    }
    expect(guidance.search("unpublished-nonsense")).toMatchObject({
      ok: true,
      resultLimited: false,
      entries: [],
    });
  });
  it.each([
    null,
    { ...manifest, entries: [...manifest.entries, manifest.entries[0]] },
    {
      ...manifest,
      entries: manifest.entries.map((entry) => ({
        ...entry,
        references: ["unpublished"],
      })),
    },
    { ...manifest, extraPath: "/owner/secret" },
  ])(
    "makes a missing, invalid or dangling manifest explicitly unavailable",
    (input) => {
      const guidance = new PublishedGuidance(input);
      expect(guidance.search("workspace")).toMatchObject({
        ok: false,
        status: "unavailable",
        error: { code: "GUIDANCE_CATALOGUE_UNAVAILABLE" },
      });
      expect(guidance.fetch("computer-start")).toMatchObject({
        ok: false,
        status: "unavailable",
        error: { code: "GUIDANCE_CATALOGUE_UNAVAILABLE" },
      });
    },
  );
  it("does not use an invented ID or path as an ambient file fetch", () => {
    const guidance = new PublishedGuidance();
    for (const id of [
      "AGENTS.md",
      "../../AGENTS.md",
      "/Users/owner/brain",
      "file://computer-start",
      "unpublished",
    ]) {
      expect(guidance.fetch(id)).toMatchObject({
        ok: false,
        status: "unavailable",
        error: { code: "GUIDANCE_NOT_PUBLISHED" },
      });
    }
  });
});
