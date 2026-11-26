import { describe, expect, it } from "vitest";
import {
  correlationMatches,
  mutationCorrelationMatches,
  sameRange,
} from "./correlation";

const base = {
  ownerId: "o",
  sessionId: "s",
  taskId: "t",
  taskEpoch: 1,
  participantId: "p",
  turnId: "u",
  generation: 2,
  callId: "c",
  workspaceId: "w",
};

describe("sameRange", () => {
  it("treats absent ranges as equal only to each other", () => {
    expect(sameRange(undefined, undefined)).toBe(true);
    expect(sameRange(undefined, { offset: 0, length: 4 })).toBe(false);
    expect(sameRange({ offset: 0, length: 4 }, { offset: 0, length: 4 })).toBe(
      true,
    );
    expect(sameRange({ offset: 0, length: 4 }, { offset: 1, length: 4 })).toBe(
      false,
    );
  });
});

describe("correlationMatches", () => {
  const read = {
    ...base,
    operation: {
      kind: "workspace.read" as const,
      relativePath: "a",
      range: { offset: 0, length: 4 },
    },
  };
  const request = read as never;
  const value = { ...base, relativePath: "a", operation: read.operation };

  it("matches an identical correlation", () => {
    expect(correlationMatches(request, value as never)).toBe(true);
  });

  it("refuses a drifted identity, path, kind or range", () => {
    expect(
      correlationMatches(request, { ...value, turnId: "x" } as never),
    ).toBe(false);
    expect(
      correlationMatches(request, { ...value, relativePath: "b" } as never),
    ).toBe(false);
    expect(
      correlationMatches(request, {
        ...value,
        operation: { kind: "workspace.list", relativePath: "a" },
      } as never),
    ).toBe(false);
    expect(
      correlationMatches(request, {
        ...value,
        operation: { ...read.operation, range: { offset: 9, length: 4 } },
      } as never),
    ).toBe(false);
  });

  it("compares search patterns and verification commands", () => {
    const search = {
      ...base,
      operation: { kind: "workspace.search", relativePath: ".", pattern: "p" },
    };
    const sv = { ...base, relativePath: ".", operation: search.operation };
    expect(correlationMatches(search as never, sv as never)).toBe(true);
    expect(
      correlationMatches(
        search as never,
        {
          ...sv,
          operation: { ...search.operation, pattern: "q" },
        } as never,
      ),
    ).toBe(false);
    const run = {
      ...base,
      operation: {
        kind: "verification.run",
        relativePath: ".",
        command: "test",
      },
    };
    const rv = { ...base, relativePath: ".", operation: run.operation };
    expect(correlationMatches(run as never, rv as never)).toBe(true);
    expect(
      correlationMatches(
        run as never,
        {
          ...rv,
          operation: { ...run.operation, command: "lint" },
        } as never,
      ),
    ).toBe(false);
  });
});

describe("mutationCorrelationMatches", () => {
  const operation = {
    kind: "workspace.write" as const,
    relativePath: "a",
    expectedSha256: null,
  };
  const request = { ...base, operationId: "op", operation } as never;
  const value = {
    ...base,
    operationId: "op",
    relativePath: "a",
    operation,
  };

  it("matches and detects drift", () => {
    expect(mutationCorrelationMatches(request, value)).toBe(true);
    expect(
      mutationCorrelationMatches(request, { ...value, operationId: "x" }),
    ).toBe(false);
    expect(
      mutationCorrelationMatches(request, {
        ...value,
        operation: { ...operation, expectedSha256: "h" },
      }),
    ).toBe(false);
    expect(
      mutationCorrelationMatches(request, {
        ...value,
        operation: { ...operation, kind: "workspace.edit" },
      }),
    ).toBe(false);
  });
});
