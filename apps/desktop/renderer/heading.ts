import type { WindowSnapshot } from "../../../src/ui/renderer/contract";
import { setupSteps } from "../../../src/ui/renderer/setup-navigation";
import { activityTitle, type ActivityFilter } from "./activity";
import { pages } from "./pages";

/** The window heading for the current destination. */
export function title(snapshot: WindowSnapshot, filter: ActivityFilter) {
  return snapshot.destination.area === "settings"
    ? (pages.find(([id]) => id === snapshot.destination.page)?.[1] ??
        "Settings")
    : snapshot.destination.area === "chatgpt"
      ? (snapshot.tasks.tasks.find(
          (task) => task.taskId === snapshot.destination.taskId && task.agent,
        )?.label ?? "ChatGPT")
      : snapshot.destination.area === "activity"
        ? activityTitle(snapshot, filter)
        : snapshot.destination.area === "setup"
          ? snapshot.destination.setupStep === "attachment"
            ? "4. Add Farol to ChatGPT"
            : (setupSteps.find(
                ([step]) => step === snapshot.destination.setupStep,
              )?.[1] ?? "Setup")
          : "Home";
}
