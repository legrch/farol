import { describe, expect, it } from "vitest";
import { operationTarget } from "./target.ts";

describe("operationTarget", () => {
  it("is empty without inputs", () => {
    expect(operationTarget({})).toEqual({});
  });
  it("prefers relativePath, then directory, then cwd", () => {
    expect(
      operationTarget({
        relativePath: "a",
        relativeDirectory: "b",
        relativeCwd: "c",
      }).relativePath,
    ).toBe("a");
    expect(
      operationTarget({ relativeDirectory: "b", relativeCwd: "c" })
        .relativePath,
    ).toBe("b");
    expect(operationTarget({ relativeCwd: "c" }).relativePath).toBe("c");
  });
  it("keeps only the first command word and only when it is tame", () => {
    expect(operationTarget({ command: "  npm test" }).command).toBe("npm");
    expect(operationTarget({ command: "a b/c d" }).command).toBe("a");
    expect(operationTarget({ command: "/bin/ls" })).toEqual({});
    expect(operationTarget({ command: "" })).toEqual({});
  });
});
