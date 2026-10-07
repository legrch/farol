import { describe, expect, it } from "vitest";
import {
  parseKnownCompletionOptions,
  qualifyKnownCompletionFailure,
} from "../../tooling/complete-known-empty-chat.mjs";

describe("one selected known completion launcher", () => {
  const args = [
    "--apply",
    "--development",
    "--expected-source",
    "a".repeat(40),
    "--completion-operation",
    "72374b4b-d10a-4c1d-89fb-32f1a8292b6d",
  ];
  it("requires an exact current source and a distinct completion identity", () => {
    expect(parseKnownCompletionOptions(args)["--development"]).toBe(true);
  });
  it.each([
    [],
    args.slice(1),
    args.filter((v) => v !== "--development"),
    [...args, "--apply"],
    [...args, "--profile", "/private/tmp/other"],
    [...args, "--executable", "/bin/true"],
    [...args, "--retry"],
    [...args.slice(0, -1), "7e8cad64-a73f-4a49-a43f-8800faf8e4bb"],
    [...args.slice(0, -1), "invalid"],
    [...args.slice(0, 3), "dirty", ...args.slice(4)],
  ])("refuses omitted, duplicate or substituted authority: %j", (bad) => {
    expect(() => parseKnownCompletionOptions(bad)).toThrow();
  });
  it("does not infer known child/ACK facts from a matching error string alone", () => {
    expect(() =>
      qualifyKnownCompletionFailure(
        Buffer.from("{}"),
        Buffer.from("EMPTY_CHAT_RECOVERY_INTENT_CHANGED\n"),
        Buffer.from("{}"),
      ),
    ).toThrow();
  });
});
