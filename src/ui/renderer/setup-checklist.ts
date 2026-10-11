/** Pure presentation of existing Setup evidence. No checks, grants or effects. */
export const setupSections = [
  ["overview", "Overview"],
  ["signin", "Sign in"],
  ["connection", "Connection"],
  ["folders", "Workspaces"],
  ["attachment", "Check"],
] as const;
export type SetupSection = (typeof setupSections)[number][0];
export type SetupCheckpoint = Exclude<SetupSection, "overview">;
export type SetupCheckState =
  "verified" | "needed" | "pending" | "unknown" | "unavailable";
export type SetupActivity = "settled" | "pending" | "unknown";
export type SetupChecklistInput = Readonly<{
  current: boolean;
  signedIn: boolean;
  workspacesVerified: boolean;
  localConnectionCurrent: boolean;
  externalAccessVerified: boolean;
  computerReady: boolean;
  signInActivity: SetupActivity;
  computerActivity: SetupActivity;
}>;
export type SetupChecklistEntry = Readonly<{
  step: SetupCheckpoint;
  label: string;
  description: string;
  optional: boolean;
  state: SetupCheckState;
  status: string;
  action: "Review" | "Set up";
}>;
const status: Readonly<Record<SetupCheckState, string>> = {
  verified: "Verified",
  needed: "Not checked",
  pending: "Check in progress",
  unknown: "Result needs review",
  unavailable: "Status unavailable",
};
function checkState(
  current: boolean,
  verified: boolean,
  activity: SetupActivity,
): SetupCheckState {
  // Unknown survives observation loss; neither refresh nor navigation settles it.
  if (activity === "unknown") return "unknown";
  if (!current) return "unavailable";
  if (activity === "pending") return "pending";
  return verified ? "verified" : "needed";
}
export function projectSetupChecklist(input: SetupChecklistInput) {
  const entries: readonly SetupChecklistEntry[] = (
    [
      [
        "signin",
        "Sign in",
        "Use your own ChatGPT account.",
        true,
        input.signedIn,
        input.signInActivity,
      ],
      [
        "connection",
        "Connection",
        "Connect this Mac to ChatGPT.",
        false,
        input.localConnectionCurrent,
        input.computerActivity,
      ],
      [
        "folders",
        "Workspaces",
        "Choose workspaces and access for each one.",
        false,
        input.workspacesVerified,
        input.computerActivity,
      ],
      [
        "attachment",
        "Check",
        "Check the complete connection from ChatGPT.",
        false,
        input.externalAccessVerified,
        input.computerActivity,
      ],
    ] as const
  ).map(([step, label, description, optional, verified, activity]) => {
    const state = checkState(input.current, verified, activity);
    return {
      step,
      label,
      description,
      optional,
      state,
      status: status[state],
      action: state === "needed" ? "Set up" : "Review",
    };
  });
  // Embedded sign-in is offered in the wizard but never gates external Computer.
  const ready =
    input.current &&
    input.computerReady &&
    entries
      .filter((entry) => !entry.optional)
      .every((entry) => entry.state === "verified");
  return { entries, ready } as const;
}
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
