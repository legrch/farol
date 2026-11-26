import { describe, expect, it } from "vitest";
import { readySchema } from "./ready";

const task = {
  taskId: "t",
  ownerId: "o",
  sessionId: "s",
  turnId: "u",
  generation: 0,
  label: "l",
  hasComputer: false,
  readToken: "r".repeat(32),
};
const ready = {
  kind: "runtime.ready",
  identity: "farol-runtime",
  port: 4310,
  token: "k".repeat(32),
  tasks: [task],
  embeddedNode: "24.0.0",
  embeddedElectron: "40.0.0",
};

describe("runtime ready message", () => {
  it("accepts a complete message for each known identity", () => {
    for (const identity of [
      "farol-runtime",
      "farol-dev-runtime",
      "farol-owner-preview-runtime",
    ])
      expect(readySchema.safeParse({ ...ready, identity }).success).toBe(true);
  });

  it.each([
    ["unknown identity", { identity: "farol-beta-runtime" }],
    ["port zero", { port: 0 }],
    ["port too large", { port: 65_536 }],
    ["short token", { token: "short" }],
    ["unknown field", { extra: true }],
    ["negative generation", { tasks: [{ ...task, generation: -1 }] }],
    ["short read token", { tasks: [{ ...task, readToken: "short" }] }],
  ])("refuses %s", (_name, patch) => {
    expect(readySchema.safeParse({ ...ready, ...patch }).success).toBe(false);
  });
});
