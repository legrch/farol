import { vi } from "vitest";
import {
  ProductConfigurationResultSchema,
  ProductSettingsSchema,
  type ProductConfigurationResult,
} from "../../src/pkg/product-settings/contract";
import { DesktopAdmission } from "../../apps/desktop/host/admission";
import { guidedSettingsFixture } from "../fixtures/guided-onboarding";

// Test-only scaffolding for the focused ChatGPT configuration slice tests. It
// scripts command routing and effect order; it is not live-provider evidence.
export function sliceScene() {
  const events: string[] = [];
  const snapshot = {
    status: "ready" as const,
    settings: ProductSettingsSchema.parse(guidedSettingsFixture()),
  };
  const failure = (error: string): ProductConfigurationResult =>
    ProductConfigurationResultSchema.parse({ ok: false, error, snapshot });
  const okResult = () => ({ ok: true, snapshot });
  const configuration = {
    snapshot: vi.fn(() => snapshot),
    markSetupVisited: vi.fn(async (step: string) => {
      events.push(`markSetupVisited:${step}`);
      return okResult();
    }),
    recordChatGptObservation: vi.fn(async (observation: unknown) => {
      events.push(`recordChatGptObservation:${JSON.stringify(observation)}`);
      return okResult();
    }),
  };
  const admission = new DesktopAdmission({
    chatGptReadonlyTask: () => false,
    directChatStart: () => false,
    chatGptAttachmentTask: () => false,
    workspaceEdit: () => false,
    computer: () => false,
    codexAgent: () => false,
    hostCheck: () => false,
    connectorStart: () => false,
  });
  return { events, snapshot, failure, configuration, admission };
}

export function failureOf(result: ProductConfigurationResult) {
  return result.ok ? null : result.error;
}
