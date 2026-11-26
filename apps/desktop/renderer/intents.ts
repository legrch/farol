import { useSyncExternalStore } from "react";
import {
  visibleSetupSection,
  type SetupSection,
} from "../../../src/ui/renderer/setup-checklist";
import type {
  Destination,
  Intent,
  RendererFacade,
  SettingsPage,
  WindowSnapshot,
} from "../../../src/ui/renderer/contract";

export const intention = (kind: string, workspaceId = "") =>
  `settings:${kind}:${workspaceId}`;
export type PageFeedback = Readonly<{
  request: object;
  text: string;
  result: Intent | null;
  origin: Destination;
}>;
export type FeedbackPage = SettingsPage | `setup:${SetupSection}`;
export function feedbackPage(destination: Destination): FeedbackPage {
  return destination.area === "setup"
    ? `setup:${visibleSetupSection(destination.setupStep)}`
    : destination.page;
}
function createFeedback() {
  let revision = 0;
  const listeners = new Set<() => void>();
  return {
    pages: {} as Partial<Record<FeedbackPage, PageFeedback>>,
    intents: {} as Record<string, Intent>,
    unretained: false,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => revision,
    changed() {
      revision++;
      listeners.forEach((listener) => listener());
    },
  };
}
// Window-owned presentation receipts survive page dismissal. No command bodies,
// credentials or authority are cached; the facade still owns operation outcomes.
const feedbackByWindow = new WeakMap<
  RendererFacade,
  ReturnType<typeof createFeedback>
>();
export function useSettingsFeedback(facade: RendererFacade) {
  let feedback = feedbackByWindow.get(facade);
  if (!feedback) {
    feedback = createFeedback();
    feedbackByWindow.set(facade, feedback);
  }
  useSyncExternalStore(feedback.subscribe, feedback.getSnapshot);
  return feedback;
}
export function settledEdit(
  result: Intent | "unretained" | null,
  snapshot: WindowSnapshot,
) {
  if (
    !result ||
    result === "unretained" ||
    !result.id.startsWith("settings:computer.apply-workspace-edit:")
  )
    return null;
  const current = snapshot.intents[result.id];
  return current &&
    current !== result &&
    (current.state === "applied" || current.state === "refused")
    ? current
    : null;
}
/** Retained transport outcomes also fence Setup when the facade lost its receipt. */
export function retainedSetupIntents(
  facade: RendererFacade,
  snapshot: WindowSnapshot,
): readonly Intent[] {
  const feedback = feedbackByWindow.get(facade);
  if (!feedback) return [];
  return [
    ...Object.values(feedback.intents).map(
      (intent) => settledEdit(intent, snapshot) ?? intent,
    ),
    ...(feedback.unretained
      ? [{ id: "setup:unretained", state: "unknown" as const, code: null }]
      : []),
  ];
}
export function useSetupIntents(
  facade: RendererFacade,
  snapshot: WindowSnapshot,
) {
  useSettingsFeedback(facade);
  return retainedSetupIntents(facade, snapshot);
}
export function useSettingsAttention(
  facade: RendererFacade,
  snapshot: WindowSnapshot,
) {
  const feedback = useSettingsFeedback(facade);
  return Boolean(
    feedback.unretained ||
    Object.values(feedback.intents).some(
      (intent) => intent.state === "unknown" && !settledEdit(intent, snapshot),
    ),
  );
}
export function actionFeedback(result: Intent): string {
  if (result.state === "pending") return "Saving or checking…";
  if (result.state === "unknown" || result.code === "SETTINGS_WRITE_FAILED")
    return "Farol could not confirm the last action. Refresh its saved result before continuing; do not repeat it.";
  if (result.state === "refused")
    return "The action could not be completed. Check the setup guide before trying again.";
  return "Saved.";
}
// Evidence carries a revision, but no request ID. If another facade intent
// changed during a picker/preview, do not attribute its evidence to our action.
export function soleIntent(
  before: WindowSnapshot,
  after: WindowSnapshot,
  kind: string,
  id = intention(kind),
): boolean {
  return Object.entries(after.intents).every(
    ([key, value]) => key === id || before.intents[key] === value,
  );
}
