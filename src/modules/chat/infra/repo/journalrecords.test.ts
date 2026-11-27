import { describe, expect, it } from "vitest";
import {
  DispatchAttemptSchema,
  isDigest,
  isIntentBinding,
  isRecordObject,
  ProjectPreferenceRecordSchema,
  parseReservation,
  stringRecord,
} from "./journalrecords";

const REQUEST_ID = "0a1b2c3d-0000-4000-8000-000000000001";
const DIGEST = "a".repeat(64);

function reservation(extra: Record<string, unknown> = {}) {
  const project = {
    root: "/work/p",
    device: "1",
    inode: "2",
    gitCommonDirectory: "/work/p/.git",
  };
  return {
    requestDigest: DIGEST,
    workspaceId: "ws1",
    projectId: "p1",
    workspace: {
      ...project,
      project,
      execution: { sandbox: "read-only", approvalPolicy: "untrusted" },
    },
    ...extra,
  };
}

describe("journal records", () => {
  it("accepts a well-formed reservation and refuses malformed ones", () => {
    expect(parseReservation(reservation()).projectId).toBe("p1");
    for (const bad of [
      [],
      reservation({ requestDigest: "short" }),
      reservation({ adopted: false }),
      reservation({ continuedFrom: "nope" }),
      reservation({ continuationVerified: true }),
      reservation({ dispatchProtocol: 2 }),
      reservation({ model: "has space" }),
    ])
      expect(() => parseReservation(bad)).toThrow("HANDOFF_JOURNAL_INVALID");
  });

  it("keeps catalogue and binding refusals on their own codes", () => {
    expect(() =>
      parseReservation(reservation({ modelCatalogue: { modelId: "" } })),
    ).toThrow("HANDOFF_JOURNAL_CATALOGUE_INVALID");
    expect(() =>
      parseReservation(reservation({ modelBinding: { nonsense: true } })),
    ).toThrow("HANDOFF_JOURNAL_MODEL_BINDING_INVALID");
  });

  it("refuses a workspace whose project git directory differs", () => {
    const value = reservation();
    value.workspace.project.gitCommonDirectory = "/elsewhere";
    expect(() => parseReservation(value)).toThrow("HANDOFF_JOURNAL_INVALID");
  });

  it("validates stored strings, digests and intent bindings", () => {
    expect(stringRecord("abc_-1")).toBe("abc_-1");
    expect(() => stringRecord("a b")).toThrow("HANDOFF_JOURNAL_INVALID");
    expect(() => stringRecord(3)).toThrow("HANDOFF_JOURNAL_INVALID");
    expect(isDigest(DIGEST)).toBe(true);
    expect(isDigest("A".repeat(64))).toBe(false);
    expect(isRecordObject({})).toBe(true);
    expect(isRecordObject(null)).toBe(false);
    expect(isRecordObject([])).toBe(false);
    expect(isIntentBinding({ key: REQUEST_ID, digest: DIGEST })).toBe(true);
    expect(isIntentBinding({ key: REQUEST_ID, digest: 1 })).toBe(false);
    expect(isIntentBinding({ key: "x", digest: DIGEST })).toBe(false);
  });

  it("bounds attempts and preference paths", () => {
    expect(DispatchAttemptSchema.safeParse({ attempt: 31 }).success).toBe(true);
    expect(DispatchAttemptSchema.safeParse({ attempt: 32 }).success).toBe(
      false,
    );
    const project = {
      root: "/a/../b",
      device: "1",
      inode: "2",
      gitCommonDirectory: "/a/.git",
    };
    expect(
      ProjectPreferenceRecordSchema.safeParse({ projectId: "p", project })
        .success,
    ).toBe(false);
  });
});
