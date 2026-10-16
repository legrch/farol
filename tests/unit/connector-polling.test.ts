import { expect, it, vi, afterEach } from "vitest";
import {
  parseConnectorPollingMetrics,
  readConnectorPollingMetrics,
} from "../../apps/desktop/connector-polling";

afterEach(() => vi.unstubAllGlobals());
it("projects only unique safe numeric reports without metric labels", () => {
  const out = parseConnectorPollingMetrics(
    'commands_poll_cycles_total{private="never-return"} 1e2\ncommands_poll_errors_total 3\ncommands_poll_last_successful_timestamp_seconds 1700000000.123\nsecret_metric{private="other"} 7\n',
  );
  expect(out).toEqual({
    cycles: "100",
    errors: "3",
    lastSuccessMillis: "1700000000123",
  });
  expect(Object.isFrozen(out)).toBe(true);
  expect(JSON.stringify(out)).not.toContain("private");
});
it.each(["NaN", "+Inf", "-1", "1.1", "9007199254740992", "arbitrary"])(
  "omits invalid counter %s",
  (value) => {
    expect(
      parseConnectorPollingMetrics(`commands_poll_cycles_total ${value}\n`),
    ).toEqual({});
  },
);
it("withholds ambiguous series and oversized documents", () => {
  expect(
    parseConnectorPollingMetrics(
      'commands_poll_last_successful_timestamp_seconds{channel="old"} 1\ncommands_poll_last_successful_timestamp_seconds{channel="new"} 1700000000\n',
    ),
  ).toEqual({});
  expect(parseConnectorPollingMetrics("x".repeat(256 * 1024 + 1))).toEqual({});
  expect(parseConnectorPollingMetrics("\n".repeat(4097))).toEqual({});
  expect(
    parseConnectorPollingMetrics(
      "commands_poll_last_successful_timestamp_seconds 1e-100\n",
    ),
  ).toEqual({});
});
it.each([503, 504, 404])(
  "keeps metrics HTTP %s unknown without retry or raw body",
  async (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("private upstream detail", { status }),
    );
    vi.stubGlobal("fetch", fetch);
    expect(await readConnectorPollingMetrics("http://127.0.0.1:43125")).toEqual(
      {},
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0].toString()).toBe(
      "http://127.0.0.1:43125/metrics",
    );
  },
);
it("refuses foreign URLs before fetch and bounds malformed/oversized UTF-8", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response(new Uint8Array([0xff])),
  );
  vi.stubGlobal("fetch", fetch);
  for (const url of [
    "https://127.0.0.1:123",
    "http://example.com:123",
    "http://user:password@127.0.0.1:123",
    "http://127.0.0.1:123/private",
    "http://127.0.0.1:123?key=private",
  ])
    expect(await readConnectorPollingMetrics(url)).toEqual({});
  expect(fetch).not.toHaveBeenCalled();
  expect(await readConnectorPollingMetrics("http://127.0.0.1:123")).toEqual({});
  fetch.mockImplementationOnce(
    async () => new Response("x".repeat(256 * 1024 + 1)),
  );
  expect(await readConnectorPollingMetrics("http://127.0.0.1:123")).toEqual({});
});
