import { describe, expect, it } from "vitest";
import { commandResult } from "./results";

describe("commandResult", () => {
  it("marks status as tracked-files-only", () => {
    expect(commandResult("git.status", "## main\n")).toEqual({
      ok: true,
      value: {
        kind: "workspace.command",
        command: "git.status",
        relativePath: ".",
        exitCode: 0,
        stdout: "## main\n",
        stderr: "",
        outputBytes: 8,
        network: "none",
        coverage: "tracked-files-only",
        layout: "primary",
      },
    });
  });

  it("marks head as head-commit and counts bytes, not characters", () => {
    const result = commandResult("git.head", "é\n");
    expect(result).toMatchObject({
      ok: true,
      value: { coverage: "head-commit", outputBytes: 3 },
    });
  });
});
