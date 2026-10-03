import type {
  ChatGptPhysicalApi,
  PhysicalBinding,
  PhysicalCorrelation,
  PhysicalPrevious,
  PhysicalSelection,
} from "./chatgpt-physical-api";

export type PhysicalSurface = Readonly<{
  handle: object;
  binding: PhysicalBinding;
  isDestroyed(): boolean;
}>;

// Non-secret, bounded, instance-local submission metadata. No prompt or journal.
export type PhysicalSubmission = Readonly<{
  originBinding: PhysicalBinding;
  operationId: string;
  evidenceId: string;
  intentDigest: string;
  promptDigest: string;
  baselineUserIds: readonly string[];
  previous: PhysicalPrevious;
  selection: PhysicalSelection;
}>;
export type PhysicalPageObservation = Readonly<{
  operationId: string;
  binding: PhysicalBinding;
  deadlineMillis: number;
  submission: PhysicalSubmission;
  correlation: PhysicalCorrelation;
}>;

// Consumer-owned native port. The host implements named mechanics on this exact
// captured surface; no arbitrary evaluation or navigation is exposed by the API.
export interface ChatGptPhysicalHostPort {
  qualified(): boolean;
  snapshot(): PhysicalSurface | null;
  homeUrl: string;
  conversationUrl(conversationId: string): string | null;
  load(surface: PhysicalSurface, url: string): Promise<void>;
  prepareProbe(
    surface: PhysicalSurface,
    binding: PhysicalBinding,
  ): Promise<unknown>;
  verifySend(
    surface: PhysicalSurface,
    input: Parameters<ChatGptPhysicalApi["verifySend"]>[0],
  ): Promise<unknown>;
  send(
    surface: PhysicalSurface,
    input: Parameters<ChatGptPhysicalApi["send"]>[0],
  ): Promise<unknown>;
  observe(
    surface: PhysicalSurface,
    input: PhysicalPageObservation,
  ): Promise<unknown>;
  cancel(
    surface: PhysicalSurface,
    input: PhysicalPageObservation,
  ): Promise<unknown>;
  destroy(surface: PhysicalSurface, deadlineMillis: number): Promise<void>;
}
