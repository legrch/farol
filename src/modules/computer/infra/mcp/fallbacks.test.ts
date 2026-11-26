import { describe, expect, it } from "vitest";
import {
  admissionRefused,
  admissionUnavailable,
  catalogueUnavailable,
  historyUnavailable,
  lookupUnavailable,
  observeUnknown,
  preferenceUnavailable,
  resolveRefused,
  tasksUnavailable,
} from "./fallbacks";

const json = (value: object) => JSON.stringify(value);

describe("task fallbacks", () => {
  it("keeps the request fields before the lookup code", () => {
    expect(json(lookupUnavailable({ a: 1 }))).toBe(
      '{"status":"unavailable","a":1,"code":"HANDOFF_PROJECT_PREFERENCE_LOOKUP_UNAVAILABLE"}',
    );
  });

  it("makes only a failed remember an unknown outcome", () => {
    const base = { key: "k", workspaceId: "w", projectId: "p" };
    expect(
      preferenceUnavailable({ ...base, operation: "remember" }).status,
    ).toBe("outcome_unknown");
    expect(preferenceUnavailable({ ...base, operation: "read" }).status).toBe(
      "unavailable",
    );
    expect(json(preferenceUnavailable({ ...base, operation: "read" }))).toBe(
      '{"status":"unavailable","key":"k","workspaceId":"w","projectId":"p","code":"HANDOFF_PROJECT_PREFERENCE_UNAVAILABLE"}',
    );
  });

  it("names the failing tool in each code", () => {
    expect(tasksUnavailable({ workspaceId: "w", projectId: "p" })).toEqual({
      status: "unavailable",
      workspaceId: "w",
      projectId: "p",
      code: "HANDOFF_PROJECT_TASKS_UNAVAILABLE",
    });
    expect(resolveRefused("w")).toEqual({
      status: "refused",
      workspaceId: "w",
      code: "HANDOFF_PROJECT_RESOLVE_UNAVAILABLE",
    });
    expect(historyUnavailable({ threadId: "t", turnId: "u" })).toEqual({
      status: "unavailable",
      threadId: "t",
      turnId: "u",
      code: "HANDOFF_HISTORY_UNAVAILABLE",
    });
    expect(observeUnknown("t")).toEqual({
      status: "outcome_unknown",
      threadId: "t",
    });
  });

  it("separates refused observe admission from unavailable reads", () => {
    expect(admissionRefused()).toEqual({
      status: "refused",
      code: "HANDOFF_TASK_ADMISSION_DENIED",
    });
    expect(admissionUnavailable()).toEqual({
      status: "unavailable",
      code: "HANDOFF_TASK_ADMISSION_DENIED",
    });
    expect(catalogueUnavailable("TASK_MODEL_CATALOG_INVALID")).toEqual({
      status: "unavailable",
      code: "TASK_MODEL_CATALOG_INVALID",
    });
  });
});
