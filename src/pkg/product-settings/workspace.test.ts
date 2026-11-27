import { describe, expect, it } from "vitest";
import {
  ApprovedProductWorkspaceSchema,
  PendingWorkspaceEditDeliverySchema,
  WorkspaceRootIdentitySchema,
} from "./workspace.ts";

const id = "11111111-1111-4111-8111-111111111111";

describe("workspace schemas", () => {
  it("is strict about root identity", () => {
    expect(
      WorkspaceRootIdentitySchema.safeParse({ device: "1", inode: "2" })
        .success,
    ).toBe(true);
    expect(
      WorkspaceRootIdentitySchema.safeParse({
        device: "1",
        inode: "2",
        extra: 1,
      }).success,
    ).toBe(false);
    expect(
      WorkspaceRootIdentitySchema.safeParse({ device: "x", inode: "2" })
        .success,
    ).toBe(false);
  });

  it("refuses exclusions that equal or escape the root", () => {
    const base = {
      workspaceId: id,
      root: "/work",
      label: "Work",
      access: "read",
    };
    expect(
      ApprovedProductWorkspaceSchema.safeParse({
        ...base,
        excludedPaths: ["/work/a"],
      }).success,
    ).toBe(true);
    for (const excludedPaths of [["/work"], ["/other"], ["/work/a", "/work/a"]])
      expect(
        ApprovedProductWorkspaceSchema.safeParse({ ...base, excludedPaths })
          .success,
      ).toBe(false);
  });

  it("accepts both pending edit formats and nothing else", () => {
    const legacy = {
      operationId: id,
      workspaceId: id,
      relativePath: "a.txt",
      computerGeneration: 1,
      submittedAt: "2026-01-02T03:04:05.000Z",
    };
    expect(PendingWorkspaceEditDeliverySchema.safeParse(legacy).success).toBe(
      true,
    );
    expect(
      PendingWorkspaceEditDeliverySchema.safeParse({
        ...legacy,
        backend: "go-owner-v2",
        profileId: id,
        beforeSha256: "a".repeat(64),
      }).success,
    ).toBe(true);
    expect(
      PendingWorkspaceEditDeliverySchema.safeParse({
        ...legacy,
        backend: "go-owner-v2",
      }).success,
    ).toBe(false);
  });
});
