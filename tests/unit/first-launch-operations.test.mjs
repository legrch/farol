import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";
import { OperationsSnapshotSchema } from "../../apps/desktop/renderer/operations-contract.ts";
import { parseFirstLaunchOperations } from "../e2e/lib/first-launch-operations.mjs";

const snapshot = () => ({
  entries: [],
  writeFailures: 0,
  corruptLines: 0,
});

it("rejects an omitted uncertainty counter that the compatibility reader defaults to zero", () => {
  const missing = snapshot();
  expect(
    OperationsSnapshotSchema.parse(missing).unrecordedUncertainEntries,
  ).toBe(0);
  expect(() => parseFirstLaunchOperations(missing)).toThrow();
});
it.each([undefined, null, "0", -1, 0.5, Number.NaN])(
  "refuses an absent or invalid native uncertainty diagnostic %s",
  (value) => {
    expect(() =>
      parseFirstLaunchOperations({
        ...snapshot(),
        unrecordedUncertainEntries: value,
      }),
    ).toThrow();
  },
);
it.each([0, 1, 7])(
  "preserves the explicit native uncertainty counter %i",
  (value) => {
    expect(
      parseFirstLaunchOperations({
        ...snapshot(),
        unrecordedUncertainEntries: value,
      }).unrecordedUncertainEntries,
    ).toBe(value);
  },
);

it("loads the native witness parser through plain Node ESM without a bundler", () => {
  expect(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'await import("./tests/e2e/lib/first-launch-operations.mjs");',
      ],
      {
        cwd: path.resolve(import.meta.dirname, "../.."),
        env: { HOME: "/var/empty", PATH: "/usr/bin:/bin" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).length,
  ).toBe(0);
});
