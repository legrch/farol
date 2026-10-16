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
  ].map((args) => ({ args })),
)("selects explicit recovery journey %#", ({ args }) => {
  const result = parseRecoveryArguments(["--run-native", ...args]);
  expect(Object.isFrozen(result)).toBe(true);
  expect(result.backendCrash).toBe(args.includes("--backend-crash"));
  expect(result.forceQuit).toBe(args.includes("--force-quit"));
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
