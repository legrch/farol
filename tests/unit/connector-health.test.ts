import { afterEach, expect, it, vi } from "vitest";
import {
  connectorHealthWire,
  readConnectorHealth,
} from "../../apps/desktop/connector-health";
import { parseConnectorHealthSnapshot } from "../../apps/desktop/bridge/connector-health-snapshot";
import { validate } from "../../apps/desktop/bridge/wire";

// Producer-shaped passive HTTP fixtures only: no real helper/upstream/account.
const report = () => ({
  schema_version: 1,
  live: true,
  ready: true,
  snapshot_at: "2026-10-18T12:00:00Z",
  runtime: {
    instance_id: "instance-A",
    started_at: "2026-10-18T11:00:00Z",
    lifecycle: "running",
  },
  components: {
    "control-plane": {
      status: "unknown",
      state: "polling",
      observed_at: "2026-10-18T11:59:00Z",
      limited: false,
      details: {
        last_attempt: "2026-10-18T11:59:00Z",
        consecutive_failures: 0,
        current_poll_age_seconds: 60,
        configured_wait_seconds: 120,
        effective_wait_seconds: 120,
        deadline_seconds: 180,
      },
    },
  },
});
afterEach(() => vi.unstubAllGlobals());

it("reads the exact bounded health endpoint once, retaining only normalized facts", async () => {
  const body = report();
  Object.assign(body, { private_extra: "DO_NOT_RETAIN" });
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(body));
  vi.stubGlobal("fetch", fetch);
  const value = await readConnectorHealth("http://127.0.0.1:43125");
  expect(value?.controlPlane?.status).toBe("unknown");
  expect(value?.controlPlane?.details?.currentPollAgeSeconds).toBe(60);
  expect(JSON.stringify(value)).not.toContain("DO_NOT_RETAIN");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]![0].toString()).toBe(
    "http://127.0.0.1:43125/health?details=true",
  );
  expect(fetch.mock.calls[0]![1]).toMatchObject({
    redirect: "error",
    signal: expect.any(AbortSignal),
  });
});

it.each([
  "https://127.0.0.1:123",
  "http://example.com:123",
  "http://localhost:123",
  "http://user:password@127.0.0.1:123",
  "http://127.0.0.1:123/private",
  "http://127.0.0.1:123?key=private",
])("refuses a foreign locator before fetch: %s", async (base) => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal("fetch", fetch);
  expect(await readConnectorHealth(base)).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it.each([404, 401, 503, 504])(
  "withholds HTTP %s without retry or raw body",
  async (status) => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(body, { status }),
    );
    vi.stubGlobal("fetch", fetch);
    expect(await readConnectorHealth("http://127.0.0.1:123")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  },
);

it.each([
  "not-json",
  "{",
  JSON.stringify({ ...report(), schema_version: 99 }),
  "x".repeat(65537),
])("withholds malformed, unsupported or oversized aggregate", async (body) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(body));
  vi.stubGlobal("fetch", fetch);
  expect(await readConnectorHealth("http://127.0.0.1:123")).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("bounds decoded bytes, rejects malformed UTF-8 and observes network failure without retry", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response(new Uint8Array([0xff])),
  );
  vi.stubGlobal("fetch", fetch);
  expect(await readConnectorHealth("http://127.0.0.1:123")).toBeNull();
  fetch.mockRejectedValueOnce(new Error("private-error"));
  expect(await readConnectorHealth("http://127.0.0.1:123")).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("maps only the fixed wire fields, preserving zeroes, sparse optionals and fractional seconds", () => {
  const raw = report();
  raw.components["control-plane"].details.current_poll_age_seconds =
    0.000000001;
  const parsed = parseConnectorHealthSnapshot(raw)!;
  const wire = connectorHealthWire(parsed)!;
  expect(validate("ComputerConnectorHealthSnapshot", wire)).toBe(true);
  expect(wire.controlPlane?.details).toMatchObject({
    consecutiveFailures: "0",
    currentPollAgeSeconds: "0.000000001",
    configuredWaitSeconds: "120",
  });
  expect(wire.controlPlane?.details).not.toHaveProperty("lastSuccessMillis");
  expect(wire).not.toHaveProperty("responseDelivery");
  expect(Object.isFrozen(wire.controlPlane?.details)).toBe(true);
  expect(wire.controlPlane?.details).not.toHaveProperty("last_attempt");
});
