import { describe, expect, it } from "vitest";
import {
  compactionMarkerKind,
  compactionMarkerShape,
  decodedTurnMetadata,
  inputContentKinds,
  inputKinds,
  inputRoles,
  metadataKeys,
  record,
  requestKindCompaction,
  requestKindShape,
  toolNames,
  turnMetadataKeys,
} from "./shape";

function withMetadata(metadata: unknown): unknown {
  return {
    client_metadata: {
      "x-codex-turn-metadata":
        typeof metadata === "string" ? metadata : JSON.stringify(metadata),
    },
  };
}

describe("provider request shape", () => {
  it("accepts only plain objects as records", () => {
    expect(record({})).toBe(true);
    expect(record([])).toBe(false);
    expect(record(null)).toBe(false);
    expect(record("x")).toBe(false);
  });

  it("names input kinds, roles and content parts without their values", () => {
    expect(inputKinds({ input: "secret" })).toEqual(["string"]);
    expect(
      inputKinds({ input: [{ type: "message" }, 3, { type: 4 }] }),
    ).toEqual(["message", "unknown", "unknown"]);
    expect(inputKinds({ input: 1 })).toEqual([]);
    expect(inputKinds(null)).toEqual([]);
    expect(inputRoles({ input: [{ role: "user" }, {}, "x"] })).toEqual([
      "user",
      "none",
      "none",
    ]);
    expect(
      inputContentKinds({
        input: [
          { content: [{ type: "input_text", text: "hidden" }, "x"] },
          { content: "plain" },
          "x",
        ],
      }),
    ).toEqual(["0:0:input_text", "0:1:unknown"]);
  });

  it("names tools by name, then type, then unknown", () => {
    expect(
      toolNames({ tools: [{ name: "a" }, { type: "web_search" }, {}, 1] }),
    ).toEqual(["a", "web_search", "unknown", "unknown"]);
    expect(toolNames({})).toEqual([]);
  });

  it("lists sorted client metadata keys", () => {
    expect(metadataKeys({ client_metadata: { b: 1, a: 2 } })).toEqual([
      "a",
      "b",
    ]);
    expect(metadataKeys({ client_metadata: [] })).toEqual([]);
  });

  it("decodes turn metadata from a string or an object only", () => {
    expect(decodedTurnMetadata(withMetadata({ a: 1 }))).toEqual({ a: 1 });
    expect(
      decodedTurnMetadata({
        client_metadata: { "x-codex-turn-metadata": { a: 1 } },
      }),
    ).toEqual({ a: 1 });
    expect(decodedTurnMetadata(withMetadata("{broken"))).toBeNull();
    expect(decodedTurnMetadata(withMetadata("[1]"))).toBeNull();
    expect(decodedTurnMetadata({})).toBeNull();
    expect(turnMetadataKeys(withMetadata({ z: 1, y: 2 }))).toEqual(["y", "z"]);
    expect(turnMetadataKeys({})).toEqual([]);
  });

  it("classifies the compaction marker and request kind", () => {
    expect(compactionMarkerKind({})).toBe("absent");
    expect(compactionMarkerKind(withMetadata({}))).toBe("absent");
    expect(compactionMarkerKind(withMetadata({ compaction: true }))).toBe(
      "true",
    );
    expect(compactionMarkerKind(withMetadata({ compaction: false }))).toBe(
      "false",
    );
    expect(compactionMarkerKind(withMetadata({ compaction: 3 }))).toBe(
      "number",
    );
    expect(
      requestKindCompaction(withMetadata({ request_kind: "compaction" })),
    ).toBe(true);
    expect(requestKindCompaction(withMetadata({ request_kind: "x" }))).toBe(
      false,
    );
  });

  it("describes control markers by shape, keeping only safe tokens", () => {
    expect(
      compactionMarkerShape(withMetadata({ compaction: "inline" })),
    ).toEqual(["string:inline"]);
    expect(
      compactionMarkerShape(withMetadata({ compaction: "has space" })),
    ).toEqual(["string"]);
    expect(
      requestKindShape(
        withMetadata({
          request_kind: {
            b: true,
            kind: "auto",
            name: "bad value!",
            nested: { y: 1, x: 2 },
            list: [],
            n: 4,
          },
        }),
      ),
    ).toEqual([
      "b:boolean:true",
      "kind:string:auto",
      "list:array",
      "n:number",
      "name:string",
      "nested:object:x,y",
    ]);
    expect(requestKindShape(withMetadata({ request_kind: [1] }))).toEqual([
      "array",
    ]);
    expect(requestKindShape(withMetadata({ request_kind: 5 }))).toEqual([
      "number",
    ]);
    expect(requestKindShape({})).toEqual(["undefined"]);
  });
});
