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
export type SetupActivity = "settled" | "pending" | "unknown";
export type SetupChecklistInput = Readonly<{
  current: boolean;
  signedIn: boolean;
  hasWorkspaces: boolean;
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
        false,
        input.signedIn,
        input.signInActivity,
      ],
      [
        "connection",
        "Connect this Mac",
        "Create a tunnel and connect this Mac.",
        false,
        input.localConnectionCurrent,
        input.computerActivity,
      ],
      [
        "folders",
        "Workspaces",
        "Choose workspaces and access for each one.",
        false,
        input.hasWorkspaces && input.workspacesVerified,
        input.computerActivity,
      ],
      [
        "attachment",
        "Add to ChatGPT",
        "Add the app and check the full connection.",
        false,
        input.externalAccessVerified,
        input.computerActivity,
      ],
    ] as const
  )
    .slice()
    .sort(
      (left, right) =>
        setupSections.findIndex(([step]) => step === left[0]) -
        setupSections.findIndex(([step]) => step === right[0]),
    )
    .map(([step, label, description, optional, verified, activity]) => {
      const state = checkState(input.current, verified, activity);
      return {
        step,
        label,
        description,
        optional,
        state,
        status:
          state === "verified" && step === "connection"
            ? "Local connection ready"
            : state === "verified" && step === "attachment"
              ? "Verified from ChatGPT"
              : state === "needed" && step === "folders" && optional
                ? "No workspace access enabled"
                : status[state],
        action: state === "needed" ? "Set up" : "Review",
      };
    });
  // Every guided step requires its own real evidence.
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
