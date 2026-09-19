import { describe, expect, it } from "vitest";

import { RouteBAdmission } from "../../src/apps/desktop/route-b-runtime";

describe("F2-1 route-B admission", () => {
  it("refuses a summary while an initial request on the thread is held", () => {
    const admission = new RouteBAdmission();
    const release = admission.hold("thread-a");
    // The held request's turn may already have ended; its preparation can
    // still be confirming the context handoff.
    expect(admission.beginSummary("thread-a")).toBe(false);
    expect(admission.beginSummary("thread-b")).toBe(true);
    admission.endSummary("thread-b");
    release();
    expect(admission.beginSummary("thread-a")).toBe(true);
    admission.endSummary("thread-a");
  });

  it("keeps refusing until every held request on the thread is released", () => {
    const admission = new RouteBAdmission();
    const first = admission.hold("thread-a");
    const second = admission.hold("thread-a");
    first();
    expect(admission.beginSummary("thread-a")).toBe(false);
    second();
    expect(admission.beginSummary("thread-a")).toBe(true);
  });
});
