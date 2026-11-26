import { describe, expect, it } from "vitest";
import { parsePorcelainStatus, renderStatus, statusArguments } from "./status";

const nul = (...fields: string[]): Buffer =>
  Buffer.from(fields.map((field) => `${field}\0`).join(""));

describe("statusArguments", () => {
  it("is the fixed porcelain invocation without exclusions", () => {
    expect(statusArguments([])).toEqual([
      "status",
      "--porcelain",
      "--branch",
      "-z",
      "--untracked-files=no",
      "--ignore-submodules=all",
    ]);
  });

  it("appends one literal top-anchored exclusion per denied prefix", () => {
    expect(statusArguments(["a", "b/c"]).slice(6)).toEqual([
      "--",
      ":(exclude,top,literal)a",
      ":(exclude,top,literal)b/c",
    ]);
  });
});

describe("parsePorcelainStatus", () => {
  it("accepts empty output", () => {
    expect(parsePorcelainStatus(Buffer.alloc(0))).toEqual({
      kind: "ok",
      header: null,
      records: [],
    });
  });

  it("parses header, plain records and renames", () => {
    expect(
      parsePorcelainStatus(
        nul("## main...origin/main", " M a.txt", "R  new.txt", "old.txt"),
      ),
    ).toEqual({
      kind: "ok",
      header: "main...origin/main",
      records: [
        { code: " M", path: "a.txt" },
        { code: "R ", path: "new.txt", original: "old.txt" },
      ],
    });
  });

  it("parses without a header", () => {
    expect(parsePorcelainStatus(nul("A  x"))).toEqual({
      kind: "ok",
      header: null,
      records: [{ code: "A ", path: "x" }],
    });
  });

  it("flags malformed shapes", () => {
    const bad = [
      Buffer.from(" M a"),
      nul("## "),
      nul("## a\nb"),
      nul("  a.txt"),
      nul("?? a.txt"),
      nul(" Mx"),
      nul("M a", "short"),
      nul("RM a"),
    ];
    for (const stdout of bad) {
      expect(parsePorcelainStatus(stdout), stdout.toString()).toEqual({
        kind: "malformed",
      });
    }
    expect(parsePorcelainStatus(Buffer.from([0xff, 0x00]))).toEqual({
      kind: "malformed",
    });
  });

  it("flags paths the route will not render", () => {
    expect(parsePorcelainStatus(nul(" M a\\b"))).toEqual({
      kind: "unsupported-path",
    });
    expect(parsePorcelainStatus(nul("R  ok", "../bad"))).toEqual({
      kind: "unsupported-path",
    });
  });
});

describe("renderStatus", () => {
  it("renders header, plain and rename lines", () => {
    expect(
      renderStatus("main", [
        { code: " M", path: "a" },
        { code: "R ", path: "n", original: "o" },
      ]),
    ).toBe("## main\n M a\nR  o -> n\n");
  });

  it("renders nothing for a clean headerless status", () => {
    expect(renderStatus(null, [])).toBe("");
  });
});
