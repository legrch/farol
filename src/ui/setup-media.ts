import { z } from "zod";

/**
 * Setup media manifest: bounded owner-facing instructions for the three
 * external steps Setup cannot verify on its own — creating a tunnel,
 * creating a runtime key, and attaching the connector inside ChatGPT. Every
 * word here is authored content, read from `resources/setup-media.json`;
 * this module only validates it and decides, given a slot, whether a clip
 * may be shown.
 *
 * No clip ships today. A slot's `clip` is optional precisely so that fact
 * is representable without a placeholder file, and `shouldRenderClip`
 * always falls back to text-only instructions when it is absent — the
 * fallback this module exists to make impossible to skip by accident.
 */

export const SetupMediaClipSchema = z.strictObject({
  file: z.string().min(1).max(4_096),
  poster: z.string().min(1).max(4_096),
  captions: z.string().min(1).max(4_096),
});

export const SetupMediaSlotIdSchema = z.enum([
  "create-tunnel",
  "create-key",
  "attach-connector",
]);

export const SetupMediaSlotSchema = z.strictObject({
  id: SetupMediaSlotIdSchema,
  title: z.string().min(1).max(120),
  instructionsVersion: z.number().int().positive(),
  locale: z.literal("en"),
  steps: z.array(z.string().min(1).max(400)).min(1).max(12),
  clip: SetupMediaClipSchema.nullable().optional(),
});

export const SetupMediaManifestSchema = z
  .array(SetupMediaSlotSchema)
  .min(1)
  .max(16)
  .refine(
    (slots) => slots.length === new Set(slots.map((slot) => slot.id)).size,
    "duplicate setup media slot id",
  );

export type SetupMediaClip = z.infer<typeof SetupMediaClipSchema>;
export type SetupMediaSlotId = z.infer<typeof SetupMediaSlotIdSchema>;
export type SetupMediaSlot = z.infer<typeof SetupMediaSlotSchema>;
export type SetupMediaManifest = z.infer<typeof SetupMediaManifestSchema>;

export function parseSetupMediaManifest(raw: unknown): SetupMediaManifest {
  return SetupMediaManifestSchema.parse(raw);
}

// The renderer bundle has no runtime disk access of its own and no bundler
// JSON-import wiring, so this validated constant is what actually ships and
// renders; `resources/setup-media.json` is the human-editable source of the
// same content, and a dedicated test
// (`tests/unit/setup-media.test.ts`) keeps the two byte-for-byte in sync —
// the same pattern `REVIEWED_TUNNEL_CLIENT_DIGESTS` uses against
// `integrations/registry.json` in `executable-discovery.ts`.
export const SETUP_MEDIA_MANIFEST: SetupMediaManifest = parseSetupMediaManifest(
  [
    {
      id: "create-tunnel",
      title: "Create a Secure MCP Tunnel",
      instructionsVersion: 1,
      locale: "en",
      steps: [
        "Open https://platform.openai.com/settings/organization/tunnels, signed in to the organization you want Farol to use.",
        "Create a tunnel and associate it with the ChatGPT workspace you actually use. A tunnel that belongs only to the Platform organization will not appear inside ChatGPT.",
        "Copy the tunnel's ID (it starts with tunnel_). Paste it into the Tunnel ID field on this step.",
      ],
    },
    {
      id: "create-key",
      title: "Create a restricted runtime key",
      instructionsVersion: 1,
      locale: "en",
      steps: [
        "On the same https://platform.openai.com/settings/organization/tunnels page, open the API keys section for this organization.",
        "Create a Restricted key scoped to Tunnels Read and Use only — never an admin or full-access key.",
        "Copy the key once; the platform will not show it again. Paste it into the Runtime key field on this step. Farol stores it privately on this Mac only and never shows it again either.",
      ],
    },
    {
      id: "attach-connector",
      title: "Attach the connector inside ChatGPT",
      instructionsVersion: 1,
      locale: "en",
      steps: [
        "With Developer mode on, open https://chatgpt.com/plugins in the ChatGPT workspace this tunnel belongs to.",
        "Press the add button, name the connector, choose Tunnel as its connection type, and select the tunnel you just created (or paste its Tunnel ID).",
        "Once Farol has started and checked its own connector on this Mac, use Check attachment on this step to confirm ChatGPT can reach it.",
      ],
    },
  ],
);

export function findSetupMediaSlot(
  manifest: SetupMediaManifest,
  id: SetupMediaSlotId,
): SetupMediaSlot | undefined {
  return manifest.find((slot) => slot.id === id);
}

// A clip renders only when the manifest names one AND the caller has
// independently confirmed the file exists. File existence is a main-process
// filesystem concern (see `resolveManifestClips`); this function stays pure
// so "missing clip → text only" is testable without touching disk.
export function shouldRenderClip(
  slot: Pick<SetupMediaSlot, "clip">,
  clipFileExists: boolean,
): boolean {
  return slot.clip != null && clipFileExists;
}

// Drops a slot's clip when its referenced file does not exist, so the
// renderer never has to re-check the filesystem itself and can never build
// a <video> pointing at a broken path. Called once, in the main process,
// before the manifest is ever handed to the renderer.
export function resolveManifestClips(
  manifest: SetupMediaManifest,
  fileExists: (path: string) => boolean,
): SetupMediaManifest {
  return manifest.map((slot) =>
    slot.clip && fileExists(slot.clip.file) && fileExists(slot.clip.poster)
      ? slot
      : { ...slot, clip: null },
  );
}
