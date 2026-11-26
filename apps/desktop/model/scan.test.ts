import { describe, expect, it } from "vitest";

import {
  findForeignProviderConflicts,
  findForeignSelectionConflicts,
  firstForeignHeaderOffset,
  keyOccurrences,
  parseHeader,
} from "./scan";

describe("parseHeader", () => {
  it("accepts every header spelling and rejects non-headers", () => {
    expect(parseHeader("[a.b]")).toEqual(["a", "b"]);
    expect(parseHeader('  [ a . "b c" ]  # note')).toEqual(["a", "b c"]);
    expect(parseHeader("[[a.b]]")).toEqual(["a", "b"]);
    expect(parseHeader("[a] junk")).toBeUndefined();
    expect(parseHeader("[a")).toBeUndefined();
    expect(parseHeader("a = 1")).toBeUndefined();
    expect(parseHeader("['unclosed]")).toBeUndefined();
  });
});

describe("keyOccurrences", () => {
  it("tracks table context, root state and inline-table keys", () => {
    const found = keyOccurrences(
      "model = 1\nx.y = { a = 1, b = { c = 2 } }\n[t]\nk = 3\n# c\n",
    );
    expect(found.map((o) => [o.path.join("."), o.header, o.root])).toEqual([
      ["model", false, true],
      ["x.y", false, true],
      ["x.y.a", false, true],
      ["x.y.b", false, true],
      ["x.y.b.c", false, true],
      ["t", true, false],
      ["t.k", false, false],
    ]);
  });

  it("strips CR from the retained line", () => {
    expect(keyOccurrences("a = 1\r\n")[0]?.line).toBe("a = 1");
  });
});

describe("foreign conflicts", () => {
  it("finds provider entries under every spelling, once per line", () => {
    const scan = [
      "[model_providers.farol]",
      'name = "x"',
      '[ "model_providers" . farol . extra ]',
      "[model_providers]",
      "farol.base_url = 'u'",
      "model_providers.farol.k = 1",
      "[model_providers.other]",
    ].join("\n");
    const found = findForeignProviderConflicts(scan, "farol");
    expect(found.map((c) => c.table)).toEqual([
      "model_providers.farol",
      "model_providers.farol.name",
      "model_providers.farol.extra",
      "model_providers.farol.base_url",
    ]);
  });

  it("redacts a token literal inside a reported conflict line", () => {
    const found = findForeignProviderConflicts(
      '[model_providers.farol]\nexperimental_bearer_token = "s"\n',
      "farol",
    );
    expect(found).toEqual([
      { table: "model_providers.farol", line: "[model_providers.farol]" },
      {
        table: "model_providers.farol.experimental_bearer_token",
        line: 'experimental_bearer_token = "<redacted: Farol Model token>"',
      },
    ]);
  });

  it("finds only root-table model_provider and model keys", () => {
    const scan =
      'model_provider = "x"\n"model" = "y"\nmodel.a = 1\n[t]\nmodel = "z"\n';
    expect(findForeignSelectionConflicts(scan).map((c) => c.table)).toEqual([
      "model_provider",
      "model",
      "model.a",
    ]);
  });
});

describe("firstForeignHeaderOffset", () => {
  it("returns the first header offset outside the block", () => {
    const bytes = "a = 1\n[inner]\nz\n[outer]\n";
    expect(firstForeignHeaderOffset(bytes, undefined)).toBe(6);
    const block = { start: 6, end: 16, leading: 1 };
    expect(firstForeignHeaderOffset(bytes, block)).toBe(16);
    expect(firstForeignHeaderOffset("a = 1\n", undefined)).toBeUndefined();
  });
});
