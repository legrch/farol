import { describe, expect, it } from "vitest";
import * as agent from "./agent";

describe("agent module surface", () => {
  it("keeps the host factory as its runtime export", () => {
    expect(Object.keys(agent)).toEqual(["createProductAgentHost"]);
  });
});
