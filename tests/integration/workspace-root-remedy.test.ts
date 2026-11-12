import { describe, expect, it } from "vitest";
import {
  unresolvedWorkspaceRootChange,
  workspaceRootChangeRemedy,
} from "../../src/ui/workspace-root-remedy";

const refused = {
  id: "settings:computer.check-folder:workspace-a",
  state: "refused",
  code: "WORKSPACE_ROOT_CHANGED",
};
const verified = {
  id: "settings:computer.verify-workspace:workspace-a",
  state: "applied",
  code: null,
};

describe("workspace root change presentation (not native authority)", () => {
  it("reports an uncertain cause, blocked access and no credential reset", () => {
    const message = workspaceRootChangeRemedy("WORKSPACE_ROOT_CHANGED");
    expect(message).toContain("cannot confirm");
    expect(message).toContain("may have changed");
    expect(message).toContain("Access remains blocked");
    expect(message).toContain("login or connection key will not fix");
    expect(message).toContain("unknown operation");
    expect(workspaceRootChangeRemedy("OTHER_ERROR")).toBeNull();
    expect(workspaceRootChangeRemedy(null)).toBeNull();
  });

  it.each([
    undefined,
    {},
    { [refused.id]: 0, [verified.id]: 2 },
    { [refused.id]: -1, [verified.id]: 2 },
    { [refused.id]: NaN, [verified.id]: 2 },
    { [refused.id]: 2, [verified.id]: NaN },
    { [refused.id]: 2, [verified.id]: Infinity },
    { [refused.id]: 2, [verified.id]: 2.5 },
    { [refused.id]: 2, [verified.id]: 2 },
    { [refused.id]: 3, [verified.id]: 2 },
  ])(
    "never infers supersession from missing, invalid or older order: %s",
    (order) => {
      expect(unresolvedWorkspaceRootChange([refused, verified], order)).toBe(
        refused,
      );
    },
  );

  it("accepts only a newer confirmed verification for the identical workspace", () => {
    expect(
      unresolvedWorkspaceRootChange([refused, verified], {
        [refused.id]: 2,
        [verified.id]: 3,
      }),
    ).toBeUndefined();
  });

  it("never clears one workspace with another's newer verification", () => {
    const other = {
      ...verified,
      id: "settings:computer.verify-workspace:workspace-b",
    };
    expect(
      unresolvedWorkspaceRootChange([refused, other], {
        [refused.id]: 1,
        [other.id]: 50,
      }),
    ).toBe(refused);
  });

  it("a successful folder-only probe does not supersede a verified-root refusal", () => {
    const badVerify = { ...refused, id: verified.id };
    const goodProbe = { ...refused, state: "applied", code: null };
    expect(
      unresolvedWorkspaceRootChange([badVerify, goodProbe], {
        [badVerify.id]: 1,
        [goodProbe.id]: 2,
      }),
    ).toBe(badVerify);
  });

  it("does not display a refusal for a removed workspace", () => {
    expect(
      unresolvedWorkspaceRootChange([refused], {}, ["workspace-b"]),
    ).toBeUndefined();
    expect(unresolvedWorkspaceRootChange([refused], {}, ["workspace-a"])).toBe(
      refused,
    );
    expect(unresolvedWorkspaceRootChange([refused], {}, [])).toBeUndefined();
  });

  it("never recasts unknown, pending or unrelated commands as root refusals", () => {
    for (const state of ["unknown", "pending", "applied"]) {
      expect(
        unresolvedWorkspaceRootChange([{ ...refused, state }], {}),
      ).toBeUndefined();
    }
    expect(
      unresolvedWorkspaceRootChange(
        [{ ...refused, id: "settings:computer.add-workspace:workspace-a" }],
        {},
      ),
    ).toBeUndefined();
    expect(
      unresolvedWorkspaceRootChange(
        [{ ...refused, id: "settings:computer.check-folder:" }],
        {},
      ),
    ).toBeUndefined();
  });
});
