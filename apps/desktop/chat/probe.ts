import { z } from "zod";
import { MAX_PREPARED_COMPOSER_CHARACTERS } from "../../../src/apps/desktop/chatgpt/scripts";
import { PublicTurnFrameSchema } from "../../../src/apps/desktop/chatgpt-public-turn";

// What each in-page ChatGPT script may answer, as the closed shape the route
// parses before it trusts a word of it. Every schema is strict about unknown
// keys and bounded in size: a page reply of any other shape is refused, never
// reinterpreted.

export const probeSchema = z.strictObject({
  composerVisible: z.boolean(),
  signInVisible: z.boolean(),
});

// What an in-page submission script returns when it finds the page on
// another URL than the identity the caller validated: it has then touched
// nothing — not the composer, not the send control — and says only that.
const navigatedTaskSchema = z.strictObject({ navigated: z.literal(true) });

// Bound the in-page snapshot to the existing ChatGPT prompt limit.
export const preparedTaskSchema = z.union([
  navigatedTaskSchema,
  z.strictObject({ appSelectionLost: z.literal(true) }),
  z.strictObject({ draftPresent: z.literal(true) }),
  z.strictObject({
    ready: z.boolean(),
    preparedComposerText: z
      .string()
      .max(MAX_PREPARED_COMPOSER_CHARACTERS)
      .optional(),
    baselineAssistantCount: z.number().int().nonnegative(),
    baselineUserCount: z.number().int().nonnegative(),
    baselineMessageIds: z
      .array(z.string().min(1).max(256))
      .max(512)
      .optional()
      .default([]),
  }),
]);

// A control click's acknowledgement (the stop control on cancel).
export const activatedControlSchema = z.strictObject({
  activated: z.boolean(),
});

// The send click's acknowledgement: the same, or the in-page refusal above.
export const activatedTaskSchema = z.union([
  navigatedTaskSchema,
  z.strictObject({ appSelectionLost: z.literal(true) }),
  z.strictObject({ profileLost: z.literal(true) }),
  z.strictObject({ draftPresent: z.literal(true) }),
  activatedControlSchema,
]);

export const taskProbeSchema = z.strictObject({
  publicFrame: PublicTurnFrameSchema.optional(),
  assistantCount: z.number().int().nonnegative(),
  assistantCharacters: z.number().int().nonnegative(),
  assistantText: z.string().max(256 * 1_024),
  userCount: z.number().int().nonnegative(),
  turnUserId: z.string().min(1).max(256).nullable(),
  turnAssistantId: z.string().min(1).max(256).nullable(),
  busy: z.boolean(),
  sendVisible: z.boolean(),
  signInVisible: z.boolean(),
  errorVisible: z.boolean(),
  errorKind: z
    .enum(["none", "usage_limited", "generic"])
    .optional()
    .default("none"),
});

export const activityProbeSchema = z.strictObject({ running: z.boolean() });

export const appBindingSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("bound") }),
  z.strictObject({ state: z.literal("navigated") }),
  z.strictObject({
    state: z.literal("blocked"),
    reason: z.enum([
      "missing",
      "ambiguous",
      "conflict",
      "draft_present",
      "selection_not_observed",
    ]),
  }),
]);

export const temporaryInstantProfileSchema = z.object({
  composerReady: z.boolean(),
  draftPresent: z.boolean(),
  temporary: z.boolean(),
  personalized: z.boolean(),
  personalizationReady: z.boolean(),
  instant: z.boolean(),
  modelReady: z.boolean(),
  visibleModelLabel: z.string().max(80).nullable().optional(),
  modelControlCount: z.number().int().min(0).max(100).optional(),
  labelHasInstant: z.boolean().optional(),
  labelHasThinkingEffort: z.boolean().optional(),
  labelHasFormatMarks: z.boolean().optional(),
});
export const instantPowerSliderSchema = z.object({
  ready: z.boolean(),
  atMinimum: z.boolean().optional(),
});
