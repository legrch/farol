import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  admissionConflict,
  assertPrivateDirectory,
  assertPrivateFile,
  positiveInteger,
  schemaError,
} from "./integrity";

const binding = {
  ownerId: "owner",
  taskId: "task",
  hostThreadId: "thread",
  sessionId: "session",
  providerProfileId: "profile",
  modelId: "model",
  mode: "mode",
};
const request = {
  operationId: "op",
  source: "retained_agent" as const,
  sourceBoundary: "b",
};

describe("positiveInteger", () => {
  it("returns safe positive integers and throws the given code otherwise", () => {
    expect(positiveInteger(3, "X")).toBe(3);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => positiveInteger(bad, "X")).toThrow("X");
    }
  });
});

describe("admissionConflict", () => {
  const admission = { binding, sourceEpoch: 2, request };
  it("is null for an identical admission", () => {
    expect(admissionConflict(admission, binding, 2, request)).toBeNull();
  });
  it("reports binding, epoch then request conflicts in that order", () => {
    expect(
      admissionConflict(admission, { ...binding, taskId: "t2" }, 3, {
        ...request,
        operationId: "other",
      }),
    ).toEqual({ status: "conflict", reason: "binding" });
    expect(admissionConflict(admission, binding, 3, request)).toEqual({
      status: "conflict",
      reason: "epoch",
    });
    expect(
      admissionConflict(admission, binding, 2, {
        ...request,
        operationId: "other",
      }),
    ).toEqual({ status: "conflict", reason: "request" });
  });
});

describe("schemaError", () => {
  it("separates an unsupported schema version from corruption", () => {
    expect(schemaError({ schemaVersion: 2 }, "C").message).toBe(
      "C_UNSUPPORTED",
    );
    expect(schemaError({ schemaVersion: 1 }, "C").message).toBe("C_CORRUPT");
    expect(schemaError({}, "C").message).toBe("C_CORRUPT");
    expect(schemaError(null, "C").message).toBe("C_CORRUPT");
    expect(schemaError("x", "C").message).toBe("C_CORRUPT");
  });
});

describe("private entry assertions", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "integrity-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("accepts an owner-only directory and refuses a group-readable one", () => {
    const dir = path.join(root, "d");
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    expect(() => assertPrivateDirectory(fs.lstatSync(dir), "D")).not.toThrow();
    fs.chmodSync(dir, 0o750);
    expect(() => assertPrivateDirectory(fs.lstatSync(dir), "D")).toThrow("D");
  });

  it("refuses a symlink and a regular file as a directory", () => {
    const file = path.join(root, "f");
    fs.writeFileSync(file, "x", { mode: 0o600 });
    const link = path.join(root, "l");
    fs.symlinkSync(root, link);
    expect(() => assertPrivateDirectory(fs.lstatSync(link), "D")).toThrow("D");
    expect(() => assertPrivateDirectory(fs.lstatSync(file), "D")).toThrow("D");
  });

  it("bounds a private file by size, mode and link count", () => {
    const file = path.join(root, "f");
    fs.writeFileSync(file, "abcd", { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    expect(() => assertPrivateFile(fs.lstatSync(file), 4, "F")).not.toThrow();
    expect(() => assertPrivateFile(fs.lstatSync(file), 3, "F")).toThrow("F");
    fs.linkSync(file, path.join(root, "g"));
    expect(() => assertPrivateFile(fs.lstatSync(file), 4, "F")).toThrow("F");
    expect(() =>
      assertPrivateFile(fs.lstatSync(file), 4, "F", 2),
    ).not.toThrow();
    fs.chmodSync(file, 0o640);
    expect(() => assertPrivateFile(fs.lstatSync(file), 4, "F", 2)).toThrow("F");
  });

  it("refuses an empty private file", () => {
    const file = path.join(root, "e");
    fs.writeFileSync(file, "", { mode: 0o600 });
    expect(() => assertPrivateFile(fs.lstatSync(file), 4, "F")).toThrow("F");
  });
});
