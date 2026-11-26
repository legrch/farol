import { createHash } from "node:crypto";
import vm from "node:vm";
import { expect, it } from "vitest";
import { physicalComposerDraft as reexported } from "../../../src/apps/desktop/chatgpt-physical-page-scripts";
import { physicalComposerDraft } from "./draft";

it("keeps the serialized composer draft reader byte-identical", () => {
  const source = physicalComposerDraft.toString();
  expect(
    `${source.length}:${createHash("sha256").update(source).digest("hex")}`,
  ).toBe(
    "1895:964d52fea15fc67226c37473e1d0e59ae1fc74eca482bc77ff50275762f38f9a",
  );
});

it("stays reachable through the original module", () => {
  expect(reexported).toBe(physicalComposerDraft);
});

it("reads a textarea value without touching markup", () => {
  class Area {
    value = "typed";
  }
  const text: unknown = vm.runInNewContext(
    `(${physicalComposerDraft.toString()})(composer)`,
    { composer: new Area(), HTMLTextAreaElement: Area },
  );
  expect(text).toBe("typed");
});
