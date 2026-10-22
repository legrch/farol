import { SELECTABLE_SEGMENTS } from "./e2e-selection.mjs";

// These segments require removed Setup/Settings surfaces or the old native
// setup prerequisite. Keep the independent startup/fence segments selectable.
const reasons = {
  "live-tasks":
    "The live-task fixture requires the removed native first-run Setup dialog.",
  "dev-new-task-affordance":
    "The prerequisite uses the removed guided-onboarding wizard.",
  "chatgpt-recovery": "The notice assertion requires the removed Setup dialog.",
  "demo-main":
    "The composite requires the removed Setup dialog and Settings Diagnostics.",
  "provider-failure":
    "The failure fixture requires the removed native Setup dialog.",
  "stream-failure":
    "The stream fixture requires the removed native Setup dialog.",
  "process-death":
    "The process-death fixture requires the removed native Setup dialog.",
  "ux34-settings-widths":
    "The capture requires the removed Setup review dialog.",
  "ux34-sidebar-toggle":
    "The pointer prerequisite drives the removed Setup Continue control.",
  "ux34-sign-in-return":
    "The return journey requires the removed Setup dialog.",
  "n04b-model": "The journey requires the removed Model Settings page.",
  "n09-connector": "The connector fixture drives the removed Setup dialog.",
  "n09-connector-attachment":
    "The attachment fixture requires the removed Setup dialog and challenge UI.",
  "n11-agent-scope":
    "The agent fixture requires the removed native Setup dialog.",
  "n12-agent-draft":
    "The draft fixture requires the removed native Setup dialog.",
  "n10-computer-panel":
    "The Computer fixture requires the removed native Setup dialog.",
};
export function previewRetirementPlan(requested) {
  const selected = SELECTABLE_SEGMENTS.filter(
    (segment) =>
      requested === null || requested.segments.includes(segment.name),
  );
  const retired = selected
    .filter((segment) => reasons[segment.name])
    .map((segment) => ({
      status: "NOT_RUN",
      journey: segment.name,
      reason: reasons[segment.name],
      qualifying: false,
    }));
  const runnable = selected
    .filter((segment) => !reasons[segment.name])
    .map((segment) => segment.name);
  return {
    selection:
      requested === null && retired.length === 0
        ? null
        : {
            requested: requested?.requested ?? runnable,
            segments: runnable,
          },
    retired,
  };
}
