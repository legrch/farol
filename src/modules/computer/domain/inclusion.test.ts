import { describe, expect, it } from "vitest";

import {
  accessIncludes,
  capabilitySetIncludes,
  commandsInclude,
  networkIncludes,
} from "./inclusion";

describe("accessIncludes", () => {
  it("lets write cover both and read cover only read", () => {
    expect(accessIncludes("write", "write")).toBe(true);
    expect(accessIncludes("write", "read")).toBe(true);
    expect(accessIncludes("read", "read")).toBe(true);
    expect(accessIncludes("read", "write")).toBe(false);
  });
});

describe("commandsInclude", () => {
  it("admits equal, none and workspace over verification", () => {
    expect(commandsInclude("verification", "verification")).toBe(true);
    expect(commandsInclude("none", "none")).toBe(true);
    expect(commandsInclude("verification", "none")).toBe(true);
    expect(commandsInclude("workspace", "verification")).toBe(true);
  });

  it("refuses widening", () => {
    expect(commandsInclude("none", "verification")).toBe(false);
    expect(commandsInclude("verification", "workspace")).toBe(false);
    expect(commandsInclude("none", "workspace")).toBe(false);
  });
});

describe("networkIncludes", () => {
  it("refuses requesting network the parent lacks", () => {
    expect(networkIncludes("approved", "approved")).toBe(true);
    expect(networkIncludes("approved", "none")).toBe(true);
    expect(networkIncludes("none", "none")).toBe(true);
    expect(networkIncludes("none", "approved")).toBe(false);
  });
});

describe("capabilitySetIncludes", () => {
  it("requires every requested capability in the parent", () => {
    expect(
      capabilitySetIncludes(
        ["workspace.read", "workspace.list"],
        ["workspace.read"],
      ),
    ).toBe(true);
    expect(capabilitySetIncludes(["workspace.read"], [])).toBe(true);
    expect(capabilitySetIncludes(["workspace.read"], ["workspace.write"])).toBe(
      false,
    );
  });
});
