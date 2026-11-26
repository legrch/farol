import { describe, expect, it } from "vitest";
import {
  currentCallEntry,
  currentCallId,
  currentCallPrefix,
  deferred,
  digest,
  outputText,
  turnKey,
  turnTag,
} from "./identity";

const identity = {
  sessionId: "s",
  threadId: "t",
  turnId: "u",
  rootTurnId: "r",
};

describe("provider turn identity", () => {
  it("digests as lowercase sha256 hex", () => {
    expect(digest("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("keys a turn by its canonical identity and tags it with 16 hex digits", () => {
    expect(turnKey({ ...identity })).toBe(
      turnKey({
        rootTurnId: "r",
        turnId: "u",
        threadId: "t",
        sessionId: "s",
      }),
    );
    expect(turnTag(identity)).toMatch(/^[a-f0-9]{16}$/u);
    expect(turnTag(identity)).toBe(digest(turnKey(identity)).slice(0, 16));
    expect(turnTag(identity)).not.toBe(
      turnTag({ ...identity, turnId: "other" }),
    );
  });

  it("recognises only call ids issued for this turn's tag", () => {
    const tag = turnTag(identity);
    const issued = `${currentCallPrefix(tag)}${"a".repeat(16)}`;
    expect(currentCallPrefix(tag)).toBe(`farol_call_${tag}`);
    expect(currentCallId(issued, tag)).toBe(true);
    expect(currentCallId(issued, "0".repeat(16))).toBe(false);
    expect(currentCallId(`${issued}x`, tag)).toBe(false);
    expect(currentCallId(7, tag)).toBe(false);
  });

  it("recognises call entries by type and issued id", () => {
    const tag = turnTag(identity);
    const callId = `${currentCallPrefix(tag)}${"b".repeat(16)}`;
    expect(
      currentCallEntry({ type: "function_call", call_id: callId }, tag),
    ).toBe(true);
    expect(
      currentCallEntry({ type: "function_call_output", call_id: callId }, tag),
    ).toBe(true);
    expect(currentCallEntry({ type: "message", call_id: callId }, tag)).toBe(
      false,
    );
    expect(currentCallEntry({ type: "function_call", call_id: "x" }, tag)).toBe(
      false,
    );
    expect(currentCallEntry("x", tag)).toBe(false);
  });

  it("joins text-bearing tool output parts and bounds the size", () => {
    expect(outputText("plain")).toBe("plain");
    expect(
      outputText([
        { type: "input_text", text: "a" },
        { type: "output_text", text: "b" },
        { type: "text", text: "c" },
      ]),
    ).toBe("a\nb\nc");
    expect(outputText([{ type: "image", text: "a" }])).toBeNull();
    expect(outputText([{ type: "text" }])).toBeNull();
    expect(outputText(["x"])).toBeNull();
    expect(outputText(3)).toBeNull();
    expect(outputText("x".repeat(512 * 1_024))).toHaveLength(512 * 1_024);
    expect(outputText("x".repeat(512 * 1_024 + 1))).toBeNull();
    expect(
      outputText([{ type: "text", text: "x".repeat(512 * 1_024 + 1) }]),
    ).toBeNull();
  });

  it("settles a deferred once from the outside", async () => {
    const resolved = deferred<number>();
    resolved.resolve(4);
    await expect(resolved.promise).resolves.toBe(4);
    const rejected = deferred<number>();
    rejected.reject(new Error("no"));
    await expect(rejected.promise).rejects.toThrow("no");
  });
});
