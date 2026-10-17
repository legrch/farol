import { describe, expect, it, vi } from "vitest";
import { RecoveryArchiveReader } from "../../apps/desktop/recovery/archive";
import { BridgeError, type Client } from "../../apps/desktop/bridge/client";
import type { Json, Outcome } from "../../apps/desktop/bridge/wire";
import {
  storedPage,
  storedReply,
  storedSummary,
} from "../fixtures/recovery-archive";

// Private-pipe correlation with an explicit transport double; no Go owner,
// stored native bytes, old terminal witness or successful ACK is exercised.
function fixture(
  change: (value: Outcome) => unknown = (value) => value,
  namespace: "chat.archive" | "chat.retired" = "chat.archive",
) {
  const context = {
    profileId: "profile",
    backendGeneration: "current-backend",
  };
  const transportContext = { ...context };
  const request = vi.fn<Client["request"]>(
    async (method, _body, options = {}) => {
      const data = method.endsWith(".list") ? storedPage() : storedReply();
      return change({
        status: "ok",
        requestId: options.id!,
        context: { ...transportContext },
        data: data as unknown as Json,
      }) as Outcome;
    },
  );
  return {
    request,
    context,
    reader: new RecoveryArchiveReader({ request }, context, namespace),
  };
}
describe("recovery archive private-pipe adapter", () => {
  it("rejects an unknown method namespace before transport", () => {
    const f = fixture();
    expect(
      () =>
        new RecoveryArchiveReader(
          { request: f.request },
          f.context,
          "computer.settings" as never,
        ),
    ).toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });
  it("selects only retired read methods for a normal owner", async () => {
    const f = fixture(undefined, "chat.retired");
    expect(await f.reader.list("")).toEqual(storedPage());
    expect(
      await f.reader.read(storedSummary().key, storedSummary().digest),
    ).toEqual(storedReply());
    expect(f.request.mock.calls.map((call) => call[0])).toEqual([
      "chat.retired.list",
      "chat.retired.read",
    ]);
    for (const call of f.request.mock.calls)
      expect(call[2]).not.toHaveProperty("operationId");
  });
  it("correlates one original read without an effect identity or current conversation binding", async () => {
    const f = fixture();
    f.context.backendGeneration = "changed caller object";
    const page = await f.reader.list("");
    expect(page).toEqual(storedPage());
    expect(page.entries[0]!.backendGeneration).toBe("old-backend");
    const call = f.request.mock.calls[0]!;
    expect(call).toEqual([
      "chat.archive.list",
      { after: "" },
      { id: expect.any(String), timeoutMs: 8000 },
    ]);
    expect(call[2]).not.toHaveProperty("operationId");
    expect(
      await f.reader.read(storedSummary().key, storedSummary().digest),
    ).toEqual(storedReply());
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it.each([
    ["request", (v: Outcome) => ({ ...v, requestId: "crossed" })],
    ["effect", (v: Outcome) => ({ ...v, operationId: "old-effect" })],
    [
      "profile",
      (v: Outcome) => ({
        ...v,
        context: { ...v.context, profileId: "foreign" },
      }),
    ],
    [
      "backend",
      (v: Outcome) => ({
        ...v,
        context: { ...v.context, backendGeneration: "foreign" },
      }),
    ],
    ["extra field", (v: Outcome) => ({ ...v, retry: true })],
    ["success code", (v: Outcome) => ({ ...v, code: "unexpected" })],
    [
      "trusted provenance",
      (v: Outcome) => ({
        ...v,
        data: { ...storedPage(), observation: "confirmed" },
      }),
    ],
    [
      "unknown outcome",
      (v: Outcome) => ({
        ...v,
        data: storedPage([
          { ...storedSummary(), recordedOutcome: "settled" } as never,
        ]),
      }),
    ],
    [
      "extra authority",
      (v: Outcome) => ({
        ...v,
        data: { ...storedPage(), ackDigest: "a".repeat(64) },
      }),
    ],
    [
      "short next page",
      (v: Outcome) => ({
        ...v,
        data: storedPage([storedSummary()], storedSummary().key),
      }),
    ],
    [
      "duplicate keys",
      (v: Outcome) => ({
        ...v,
        data: storedPage([storedSummary(), storedSummary()]),
      }),
    ],
  ] as const)("withholds %s without transport retry", async (_name, change) => {
    const f = fixture(change);
    await expect(f.reader.list("")).rejects.toMatchObject({ state: "unknown" });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each(["unknown", "refused", "unavailable", "unsupported"] as const)(
    "retains the selected %s outcome",
    async (status) => {
      const f = fixture((v) => ({
        status,
        requestId: v.requestId,
        context: v.context,
        code: "original_result",
      }));
      await expect(f.reader.list("")).rejects.toMatchObject({
        state: status,
        code: "original_result",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["key", "digest", "byte count", "invalid unicode"])(
    "withholds a stored reply with crossed %s",
    async (crossed) => {
      const f = fixture((v) => {
        const data = { ...storedReply(), summary: { ...storedSummary() } };
        if (crossed === "key") data.summary.key = "f".repeat(64);
        if (crossed === "digest") data.summary.digest = "f".repeat(64);
        if (crossed === "byte count") data.text += "!";
        if (crossed === "invalid unicode") data.text = "\ud800";
        return { ...v, data };
      });
      await expect(
        f.reader.read(storedSummary().key, storedSummary().digest),
      ).rejects.toMatchObject({ state: "unknown" });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it("refuses malformed caller selections before touching the private pipe", async () => {
    const f = fixture();
    await expect(f.reader.list("foreign")).rejects.toMatchObject({
      state: "refused",
    });
    await expect(
      f.reader.read(storedSummary().key, "not a digest"),
    ).rejects.toMatchObject({ state: "refused" });
    expect(f.request).not.toHaveBeenCalled();
    expect(
      () =>
        new RecoveryArchiveReader(
          { request: f.request },
          { profileId: "", backendGeneration: "bad" },
        ),
    ).toThrow(BridgeError);
  });
  it("retains a thrown transport error without reissuing it", async () => {
    const f = fixture(),
      lost = new BridgeError("unknown", "lost_private_pipe");
    f.request.mockRejectedValueOnce(lost);
    await expect(f.reader.list("")).rejects.toBe(lost);
    expect(f.request).toHaveBeenCalledTimes(1);
  });
});

it.each([
  "",
  "first line\n<script>plain text</script> ✓",
  "x".repeat(8192),
  "✓".repeat(2730) + "ab",
])("reads bounded literal stored copy case %#", async (text) => {
  const summary = storedSummary(1, text);
  const f = fixture((v) => ({ ...v, data: storedReply(summary, text) }));
  expect(await f.reader.read(summary.key, summary.digest)).toEqual(
    storedReply(summary, text),
  );
  expect(f.request).toHaveBeenCalledTimes(1);
});
it("rejects one byte beyond the stored-copy budget", async () => {
  const text = "x".repeat(8193),
    summary = storedSummary(1, text);
  const f = fixture((v) => ({ ...v, data: storedReply(summary, text) }));
  await expect(
    f.reader.read(summary.key, summary.digest),
  ).rejects.toMatchObject({ state: "unknown" });
});
