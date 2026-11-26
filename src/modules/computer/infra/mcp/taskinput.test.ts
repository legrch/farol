import { describe, expect, it } from "vitest";
import {
  CodexProjectTasksInputSchema,
  CodexTaskCreateInputSchema,
  CodexTaskHistoryInputSchema,
  CodexTaskTitleInputSchema,
  SavedChatCreateInputSchema,
  SavedChatStatusInputSchema,
} from "./taskinput";

const uuid = "123e4567-e89b-42d3-a456-426614174000";

describe("task input schemas", () => {
  it("accepts a minimal task create and refuses bad text", () => {
    const base = {
      key: uuid,
      workspaceId: "w",
      projectId: "p",
      message: "hello",
    };
    expect(CodexTaskCreateInputSchema.safeParse(base).success).toBe(true);
    expect(
      CodexTaskCreateInputSchema.safeParse({ ...base, message: "" }).success,
    ).toBe(false);
    expect(
      CodexTaskCreateInputSchema.safeParse({ ...base, message: "a\0" }).success,
    ).toBe(false);
    expect(
      CodexTaskCreateInputSchema.safeParse({ ...base, key: "nope" }).success,
    ).toBe(false);
    expect(
      CodexTaskCreateInputSchema.safeParse({
        ...base,
        message: "é".repeat(4_097),
      }).success,
    ).toBe(false);
  });

  it("restricts project task scope and cursor", () => {
    const base = { workspaceId: "w", projectId: "p" };
    expect(
      CodexProjectTasksInputSchema.safeParse({
        ...base,
        scope: "selected-writer",
      }).success,
    ).toBe(true);
    expect(
      CodexProjectTasksInputSchema.safeParse({ ...base, scope: "other" })
        .success,
    ).toBe(false);
    expect(
      CodexProjectTasksInputSchema.safeParse({ ...base, cursor: "a\nb" })
        .success,
    ).toBe(false);
  });

  it("extends observe with turn, cursor and tail for history", () => {
    const base = {
      threadId: uuid,
      workspaceId: "w",
      projectId: "p",
      turnId: uuid,
    };
    expect(
      CodexTaskHistoryInputSchema.safeParse({ ...base, tail: true }).success,
    ).toBe(true);
    expect(
      CodexTaskHistoryInputSchema.safeParse({ ...base, turnId: undefined })
        .success,
    ).toBe(false);
  });

  it("allows a null expected title but not a blank new one", () => {
    const base = {
      key: uuid,
      dispatchId: uuid,
      workspaceId: "w",
      projectId: "p",
      expectedTitle: null,
    };
    expect(
      CodexTaskTitleInputSchema.safeParse({ ...base, title: "T" }).success,
    ).toBe(true);
    expect(
      CodexTaskTitleInputSchema.safeParse({ ...base, title: "   " }).success,
    ).toBe(false);
  });

  it("bounds saved chat fields", () => {
    expect(
      SavedChatCreateInputSchema.safeParse({
        key: uuid,
        title: "t".repeat(81),
        firstMessage: "m",
      }).success,
    ).toBe(false);
    expect(
      SavedChatStatusInputSchema.safeParse({ dispatchId: uuid, recheck: true })
        .success,
    ).toBe(true);
  });
});
