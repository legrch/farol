import { z } from "zod";
import manifest from "./computer-guidance.json";

const EntrySchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/u),
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(500),
  keywords: z.array(z.string().min(1).max(100)).max(30),
  text: z.string().min(1).max(8192),
  references: z.array(z.string().min(1).max(80)).max(20),
});
const ManifestSchema = z.strictObject({
  schema: z.literal(1),
  entries: z.array(EntrySchema).min(1).max(64),
});
type Entry = z.infer<typeof EntrySchema>;

// The JSON is embedded into the sealed build. No request can supply a path or
// change this catalogue, and references resolve only to declared entry IDs.
export class PublishedGuidance {
  private readonly entries: readonly Entry[] | null;
  constructor(input: unknown = manifest) {
    const parsed = ManifestSchema.safeParse(input);
    const ids = parsed.success
      ? new Set(parsed.data.entries.map((entry) => entry.id))
      : new Set<string>();
    this.entries =
      parsed.success &&
      ids.size === parsed.data.entries.length &&
      parsed.data.entries.every((entry) =>
        entry.references.every((id) => ids.has(id)),
      )
        ? parsed.data.entries
        : null;
  }
  private unavailable(code: string) {
    return {
      ok: false as const,
      status: "unavailable" as const,
      error: { code, retry: "never" as const },
    };
  }
  search(query: string, limit = 8) {
    if (!this.entries)
      return this.unavailable("GUIDANCE_CATALOGUE_UNAVAILABLE");
    const terms = [
      ...new Set(query.toLowerCase().split(/\s+/u).filter(Boolean)),
    ];
    const ranked = this.entries
      .map((entry) => {
        const text =
          `${entry.id} ${entry.title} ${entry.summary} ${entry.keywords.join(" ")}`.toLowerCase();
        return {
          entry,
          score: terms.reduce(
            (score, term) => score + (text.includes(term) ? 1 : 0),
            0,
          ),
        };
      })
      .filter((item) => item.score > 0)
      .sort(
        (a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id),
      );
    return {
      ok: true as const,
      schema: 1 as const,
      source: "sealed-package-manifest" as const,
      resultLimited: ranked.length > limit,
      entries: ranked.slice(0, limit).map(({ entry, score }) => ({
        id: entry.id,
        title: entry.title,
        summary: entry.summary,
        references: entry.references,
        score,
      })),
    };
  }
  fetch(id: string) {
    if (!this.entries)
      return this.unavailable("GUIDANCE_CATALOGUE_UNAVAILABLE");
    const entry = this.entries.find((entry) => entry.id === id);
    return entry
      ? {
          ok: true as const,
          schema: 1 as const,
          source: "sealed-package-manifest" as const,
          entry,
        }
      : this.unavailable("GUIDANCE_NOT_PUBLISHED");
  }
}
