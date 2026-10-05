import { describe, expect, it } from "vitest";
import { browserFailureCollector } from "../e2e/lib/browser-failure-witness.mjs";
const failure = {
  stage: "execute",
  kind: "prepare",
  state: "refused",
  code: "host_browser_prepare_invalid",
};
const marker = (value: unknown) =>
  `FAROL_BROWSER_FAILURE ${JSON.stringify(value)}\n`;
describe("content-free native browser failure witness", () => {
  it("retains the exact local closure code without accepting arbitrary client error text", () => {
    const c = browserFailureCollector();
    const closed = {
      stage: "poll",
      kind: null,
      state: "unknown",
      code: "client_closed",
    };
    c.ingest(marker(closed));
    c.ingest(marker({ ...closed, code: "client_private_error" }));
    expect(c.failures).toEqual([closed]);
  });
  it("retains exact classification across pipe chunks without recording surrounding output", () => {
    const c = browserFailureCollector();
    c.ingest("private noise\n" + marker(failure).slice(0, 30));
    c.ingest(marker(failure).slice(30) + "more private noise\n");
    expect(c.failures).toEqual([failure]);
    expect(JSON.stringify(c.failures)).not.toContain("private");
  });
  it("drops oversized, malformed and content-bearing diagnostics and bounds retained records", () => {
    const c = browserFailureCollector();
    for (const value of [
      null,
      { ...failure, prompt: "private" },
      { ...failure, code: "private content" },
      { ...failure, kind: "unknown" },
      { ...failure, state: "ready" },
    ])
      c.ingest(marker(value));
    c.ingest("FAROL_BROWSER_FAILURE {invalid}\n");
    c.ingest("x".repeat(8193));
    expect(c.failures).toEqual([]);
    for (let i = 0; i < 12; i++) c.ingest(marker(failure));
    expect(c.failures).toHaveLength(8);
  });
  it("keeps valid lines coalesced with oversized noise and drops whole oversized lines", () => {
    const c = browserFailureCollector();
    c.ingest("x".repeat(9000) + "\n" + marker(failure) + "y".repeat(9000));
    expect(c.failures).toEqual([failure]);
    // This marker is still part of the same oversized line, not a new record.
    c.ingest(marker(failure));
    expect(c.failures).toHaveLength(1);
    c.ingest(marker(failure));
    expect(c.failures).toEqual([failure, failure]);
  });
});
