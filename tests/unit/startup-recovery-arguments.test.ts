import { expect, it } from "vitest";
import { parseRecoveryArguments } from "../e2e/fixtures/startup-recovery-arguments";

it.each(
  [
    [],
    ["--saved-settings"],
    ["--saved-settings", "--force-quit"],
    ["--saved-settings", "--normal-host-crash"],
    ["--saved-settings", "--stored-replies"],
    ["--saved-settings", "--stored-replies", "--force-quit"],
    ["--saved-settings", "--stored-replies", "--backend-crash"],
    ["--saved-settings", "--stored-replies", "--computer-store-refusal"],
  ].map((args) => ({ args })),
)("selects explicit recovery journey %#", ({ args }) => {
  const result = parseRecoveryArguments(["--run-native", ...args]);
  expect(Object.isFrozen(result)).toBe(true);
  expect(result.backendCrash).toBe(args.includes("--backend-crash"));
  expect(result.forceQuit).toBe(args.includes("--force-quit"));
  expect(result.savedSettings).toBe(args.includes("--saved-settings"));
  expect(result.storedReplies).toBe(args.includes("--stored-replies"));
  expect(result.normalHostCrash).toBe(args.includes("--normal-host-crash"));
  expect(result.computerStoreRefusal).toBe(
    args.includes("--computer-store-refusal"),
  );
});
it.each(
  [
    [],
    ["--run-native", "--backend-crash"],
    ["--run-native", "--saved-settings", "--backend-crash"],
    ["--run-native", "--stored-replies"],
    ["--run-native", "--force-quit"],
    [
      "--run-native",
      "--saved-settings",
      "--stored-replies",
      "--force-quit",
      "--backend-crash",
    ],
    [
      "--run-native",
      "--saved-settings",
      "--stored-replies",
      "--normal-host-crash",
    ],
    ["--run-native", "--saved-settings", "--force-quit", "--force-quit"],
    ["--run-native", "--stored-replies", "--saved-settings"],
    ["--run-native", "--unrecognized"],
  ].map((args) => ({ args })),
)("refuses ambiguous, missing or unselected native input %#", ({ args }) => {
  expect(() => parseRecoveryArguments(args)).toThrow();
});

const refusalJourney = [
  "--run-native",
  "--saved-settings",
  "--stored-replies",
  "--computer-store-refusal",
];

it.each(
  [
    ["--computer-store-refusal"],
    ["--run-native", "--computer-store-refusal"],
    ["--run-native", "--saved-settings", "--computer-store-refusal"],
    ["--run-native", "--stored-replies", "--computer-store-refusal"],
    refusalJourney.slice(1),
    [...refusalJourney, "--unrecognized"],
    [...refusalJourney, "--computer-store-refusal=/arbitrary/profile"],
    ...["--force-quit", "--normal-host-crash", "--backend-crash"].flatMap(
      (crash) => [
        [...refusalJourney, crash],
        [...refusalJourney.slice(0, -1), crash, "--computer-store-refusal"],
      ],
    ),
    ...refusalJourney.flatMap((flag) => [
      [...refusalJourney, flag],
      [flag, ...refusalJourney],
    ]),
  ].map((args) => ({ args })),
)(
  "refuses incomplete, duplicated or combined Computer store faults %#",
  ({ args }) => {
    expect(() => parseRecoveryArguments(args)).toThrow();
  },
);

function permutations(values: readonly string[]): string[][] {
  if (values.length === 0) return [[]];
  return values.flatMap((value, index) =>
    permutations(values.filter((_, other) => other !== index)).map((rest) => [
      value,
      ...rest,
    ]),
  );
}

it.each(
  permutations(refusalJourney)
    .filter((args) =>
      args.some((flag, index) => flag !== refusalJourney[index]),
    )
    .map((args) => ({ args })),
)(
  "refuses reordered Computer store faults before native setup %#",
  ({ args }) => {
    expect(() => parseRecoveryArguments(args)).toThrow();
  },
);
