import { describe, expect, it } from "vitest";
import type { HandoffWorkspace } from "../port/handoff";
import {
  historyVerdict,
  lookupResolved,
  lookupVerdict,
  preferenceStored,
  preferenceVerdict,
  resolveRefused,
  sameRecord,
  tasksQuery,
  tasksVerdict,
} from "./projectresult";

const project = {
  root: "/work/root/app",
  device: "1",
  inode: "3",
  gitCommonDirectory: "/work/root/.git",
};

const workspace: HandoffWorkspace = {
  root: "/work/root",
  device: "1",
  inode: "2",
  gitCommonDirectory: "/work/root/.git",
  project,
  execution: { sandbox: "workspace-write", approvalPolicy: "on-request" },
};

describe("preference verdicts", () => {
  const lookup = { workspaceId: "w1", projectId: "p1" };
  const preference = {
    key: "k1",
    workspaceId: "w1",
    projectId: "p1",
    operation: "remember" as const,
  };

  it("echoes the lookup request with a status and code", () => {
    expect(lookupVerdict(lookup, "missing", "C")).toEqual({
      ...lookup,
      status: "missing",
      code: "C",
    });
    expect(lookupResolved(lookup, "k1")).toEqual({
      ...lookup,
      status: "resolved",
      key: "k1",
      persistence: "immutable-local-receipt",
      selection: "latest-local-publication",
      snapshot: "non-atomic",
      controlGranted: false,
    });
  });

  it("echoes the preference identity and never grants control", () => {
    expect(preferenceVerdict(preference, "outcome_unknown", "C")).toEqual({
      status: "outcome_unknown",
      key: "k1",
      workspaceId: "w1",
      projectId: "p1",
      code: "C",
    });
    expect(preferenceStored(preference)).toMatchObject({
      status: "remembered",
      controlGranted: false,
    });
    expect(preferenceStored({ ...preference, operation: "read" }).status).toBe(
      "resolved",
    );
  });

  it("compares a receipt by project id and physical project", () => {
    const record = { projectId: "p1", project };
    expect(sameRecord(record, { ...record })).toBe(true);
    expect(sameRecord(record, { ...record, projectId: "p2" })).toBe(false);
    expect(
      sameRecord(record, { ...record, project: { ...project, inode: "9" } }),
    ).toBe(false);
  });
});

describe("task and history verdicts", () => {
  it("builds refused and unavailable discovery results", () => {
    const request = { workspaceId: "w1", projectId: "p1" };
    expect(tasksVerdict(request, "refused", "C")).toEqual({
      status: "refused",
      workspaceId: "w1",
      projectId: "p1",
      code: "C",
    });
    expect(resolveRefused("w1", "C")).toEqual({
      status: "refused",
      workspaceId: "w1",
      code: "C",
    });
  });

  it("adds the canonical root only for the combined scope", () => {
    const base = { workspaceId: "w1", projectId: "p1" };
    expect(
      tasksQuery({ ...base, scope: "selected-writer" }, workspace),
    ).toEqual({
      projectId: "p1",
      writerRoot: "/work/root",
      scope: "selected-writer",
    });
    expect(
      tasksQuery(
        { ...base, scope: "canonical-and-selected-writer", cursor: "c" },
        workspace,
      ),
    ).toEqual({
      projectId: "p1",
      writerRoot: "/work/root",
      scope: "canonical-and-selected-writer",
      canonicalRoot: "/work/root/app",
      cursor: "c",
    });
  });

  it("names the thread and turn in a history verdict", () => {
    expect(
      historyVerdict(
        { threadId: "t1", turnId: "u1", workspaceId: "w1", projectId: "p1" },
        "unavailable",
        "C",
      ),
    ).toEqual({
      status: "unavailable",
      threadId: "t1",
      turnId: "u1",
      code: "C",
    });
  });
});
