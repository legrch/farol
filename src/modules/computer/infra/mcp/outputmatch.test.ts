import { describe, expect, it } from "vitest";
import { mutationReceiptMatches, readonlyOutputMatches } from "./outputmatch";

const op = (value: object) => value as never;

describe("readonly output matching", () => {
  it("pairs context, list and search with their own output kinds", () => {
    expect(
      readonlyOutputMatches(
        op({ kind: "workspace.context" }),
        op({ kind: "workspace.context" }),
      ),
    ).toBe(true);
    expect(
      readonlyOutputMatches(
        op({ kind: "workspace.list" }),
        op({ kind: "workspace.entries" }),
      ),
    ).toBe(true);
    expect(
      readonlyOutputMatches(
        op({ kind: "workspace.search" }),
        op({ kind: "workspace.matches" }),
      ),
    ).toBe(true);
    expect(
      readonlyOutputMatches(
        op({ kind: "workspace.list" }),
        op({ kind: "workspace.matches" }),
      ),
    ).toBe(false);
  });

  it("accepts a page only for a ranged read", () => {
    const text = (page?: object) =>
      op({ kind: "workspace.text", ...(page ? { page } : {}) });
    const range = { offset: 0, length: 1 };
    expect(
      readonlyOutputMatches(op({ kind: "workspace.read", range }), text({})),
    ).toBe(true);
    expect(readonlyOutputMatches(op({ kind: "workspace.read" }), text())).toBe(
      true,
    );
    expect(
      readonlyOutputMatches(op({ kind: "workspace.read" }), text({})),
    ).toBe(false);
    expect(
      readonlyOutputMatches(op({ kind: "workspace.read", range }), text()),
    ).toBe(false);
  });

  it("requires the same verification command", () => {
    const out = (command: string) => op({ kind: "workspace.command", command });
    const run = op({ kind: "verification.run", command: "a" });
    expect(readonlyOutputMatches(run, out("a"))).toBe(true);
    expect(readonlyOutputMatches(run, out("b"))).toBe(false);
  });
});

describe("mutation receipt matching", () => {
  it("maps write to write and anything else to edit", () => {
    const write = op({ kind: "workspace.write", relativePath: "a" });
    const edit = op({ kind: "workspace.edit", relativePath: "a" });
    expect(
      mutationReceiptMatches(write, { operation: "write", relativePath: "a" }),
    ).toBe(true);
    expect(
      mutationReceiptMatches(write, { operation: "edit", relativePath: "a" }),
    ).toBe(false);
    expect(
      mutationReceiptMatches(edit, { operation: "edit", relativePath: "a" }),
    ).toBe(true);
    expect(
      mutationReceiptMatches(edit, { operation: "edit", relativePath: "b" }),
    ).toBe(false);
  });
});
