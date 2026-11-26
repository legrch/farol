import { describe, expect, it } from "vitest";
import {
  admissionRecheckable,
  restartBlockPermitted,
  timerMayRetryBlock,
} from "./admission";

describe("admission blocks", () => {
  it("rechecks only refusals raised before a helper launched", () => {
    expect(admissionRecheckable("UPDATE_WORK_PENDING")).toBe(true);
    expect(admissionRecheckable("UPDATE_BROWSER_STATE_UNKNOWN")).toBe(false);
    expect(admissionRecheckable("UPDATE_HANDOFF_UNKNOWN")).toBe(false);
  });

  it("lets the timer retry unblocked and pre-dispatch blocks only", () => {
    expect(timerMayRetryBlock(null)).toBe(true);
    expect(timerMayRetryBlock("UPDATE_BROWSER_OPEN")).toBe(true);
    expect(timerMayRetryBlock("UPDATE_BROWSER_STATE_UNKNOWN")).toBe(true);
    expect(timerMayRetryBlock("UPDATE_HANDOFF_UNKNOWN")).toBe(false);
  });

  it("passes a block on restart only with confirmation", () => {
    expect(restartBlockPermitted(null, false)).toBe(true);
    expect(restartBlockPermitted("UPDATE_BROWSER_OPEN", false)).toBe(false);
    expect(restartBlockPermitted("UPDATE_BROWSER_OPEN", true)).toBe(true);
    expect(restartBlockPermitted("UPDATE_CONNECTOR_ACTIVE", true)).toBe(true);
    expect(restartBlockPermitted("UPDATE_HANDOFF_UNKNOWN", true)).toBe(false);
  });
});
