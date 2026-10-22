/** Pure presentation of existing Setup evidence. No checks, grants or effects. */
export const setupSections = [
  ["overview", "Overview"],
  ["signin", "Sign in"],
  ["folders", "Workspaces"],
  ["connection", "Connect this Mac"],
  ["attachment", "Add to ChatGPT"],
] as const;
export type SetupSection = (typeof setupSections)[number][0];
export type SetupCheckpoint = Exclude<SetupSection, "overview">;
export type SetupCheckState =
  "verified" | "needed" | "pending" | "unknown" | "unavailable";
export type SetupChecklistEntry = Readonly<{
  step: SetupCheckpoint;
  label: string;
  description: string;
  optional: false;
  state: SetupCheckState;
  status: string;
  action: "Review" | "Set up";
}>;
/** Legacy Finish history entries display the summary, never a phantom sixth step. */
export function visibleSetupSection(step: unknown): SetupSection {
  return setupSections.some(([key]) => key === step)
    ? (step as SetupSection)
    : "overview";
}
export function adjacentSetupSection(
  step: unknown,
  direction: -1 | 1,
): SetupSection | null {
  const index = setupSections.findIndex(
    ([key]) => key === visibleSetupSection(step),
  );
  return setupSections[index + direction]?.[0] ?? null;
}
