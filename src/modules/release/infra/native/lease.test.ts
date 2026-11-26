import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createLeaseWriter,
  ExtractionLease,
  LEASE_FILE,
  localStartParser,
  observeLeaseProcess,
  readProcessIdentity,
  type ProcessRead,
} from "./lease";

const START = "Thu Nov 26 10:00:00 2026";
const LATER = "Thu Nov 26 10:00:05 2026";
const EARLIER = "Thu Nov 26 09:59:55 2026";
const recorded = (processStart: string | null) => ({
  pid: 4000,
  processStart,
  startedAtMs: processStart === null ? null : Date.parse(processStart),
});
const answering =
  (text: string): ProcessRead =>
  async () => ({ stdout: `${text}\n`, stderr: "" });
const absent: ProcessRead = async () => {
  throw Object.assign(new Error("exit 1"), {
    code: 1,
    stdout: "",
    stderr: "",
  });
};

describe("process identity", () => {
  it("reads the start text and its instant", async () => {
    expect(await readProcessIdentity(4000, answering(START))).toEqual({
      processStart: START,
      startedAtMs: Date.parse(START),
    });
  });
  it("reports a clean ps absence as no process", async () => {
    expect(await readProcessIdentity(4000, absent)).toBeNull();
  });
  it.each([
    ["a failed probe", async () => Promise.reject(new Error("timeout"))],
    [
      "a non-clean exit",
      async () =>
        Promise.reject(
          Object.assign(new Error("exit 1"), {
            code: 1,
            stdout: "",
            stderr: "denied",
          }),
        ),
    ],
    ["stderr output", async () => ({ stdout: `${START}\n`, stderr: "warn" })],
    ["unparsable text", async () => ({ stdout: "yesterday\n", stderr: "" })],
    ["an empty answer", async () => ({ stdout: "\n", stderr: "" })],
  ] as const)("does not report %s as absence", async (_name, read) => {
    await expect(readProcessIdentity(4000, read)).rejects.toThrow();
  });
});

describe("lease process observation", () => {
  it("treats the recorded start as the same live process", async () => {
    expect(await observeLeaseProcess(recorded(START), answering(START))).toBe(
      "live",
    );
  });
  it("treats an absent pid as ended, even when its start was never recorded", async () => {
    expect(await observeLeaseProcess(recorded(START), absent)).toBe("ended");
    expect(await observeLeaseProcess(recorded(null), absent)).toBe("ended");
  });
  it("treats a pid reused by a later process as ended", async () => {
    expect(await observeLeaseProcess(recorded(START), answering(LATER))).toBe(
      "ended",
    );
  });
  it("does not treat an earlier or unrecorded start as ended", async () => {
    expect(await observeLeaseProcess(recorded(START), answering(EARLIER))).toBe(
      "unknown",
    );
    expect(await observeLeaseProcess(recorded(null), answering(START))).toBe(
      "unknown",
    );
  });
  it("treats a failed probe as unknown", async () => {
    expect(
      await observeLeaseProcess(recorded(START), async () =>
        Promise.reject(new Error("ps unavailable")),
      ),
    ).toBe("unknown");
  });
  it("still sees the same process after a timezone change renames its start text", async () => {
    // Written in UTC; read in UTC+9, where ps prints nine hours later for the
    // same instant. The instant is what identifies the process.
    const utc = (text: string) => Date.parse(`${text} UTC`);
    const tokyo = (text: string) => Date.parse(`${text} UTC`) - 9 * 3_600_000;
    const identity = {
      pid: 4000,
      processStart: START,
      startedAtMs: utc(START),
    };
    expect(
      await observeLeaseProcess(
        identity,
        answering("Thu Nov 26 19:00:00 2026"),
        tokyo,
      ),
    ).toBe("live");
    // A later process is still later in the new timezone.
    expect(
      await observeLeaseProcess(
        identity,
        answering("Thu Nov 26 19:00:09 2026"),
        tokyo,
      ),
    ).toBe("ended");
  });
});

describe("lease writer", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "farol-lease-"));
  });
  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  const writer = () =>
    createLeaseWriter({
      directory,
      ownerPid: 4000,
      owner: { processStart: START, startedAtMs: Date.parse(START) },
      handle: "handle",
      now: () => 1_000,
    });
  const read = async () =>
    ExtractionLease.parse(
      JSON.parse(await fs.readFile(path.join(directory, LEASE_FILE), "utf8")),
    );
  it("writes a private lease that its own reader accepts", async () => {
    await writer().create();
    const stat = await fs.lstat(path.join(directory, LEASE_FILE));
    expect(stat.mode & 0o777).toBe(0o600);
    expect(await read()).toMatchObject({
      ownerPid: 4000,
      phase: "created",
      createdAt: 1_000,
      updatedAt: 1_000,
      children: [],
    });
  });
  it("announces a spawn, then records the child, leaving no temporary file", async () => {
    const lease = writer();
    await lease.create();
    await lease.beginSpawn();
    expect((await read()).phase).toBe("spawning");
    await lease.childSpawned(4100);
    expect(await read()).toMatchObject({
      phase: "spawned",
      children: [{ pid: 4100, processStart: null, startedAtMs: null }],
    });
    await lease.childIdentified(4100, {
      processStart: LATER,
      startedAtMs: Date.parse(LATER),
    });
    expect(await read()).toMatchObject({
      phase: "spawned",
      children: [{ pid: 4100, processStart: LATER }],
    });
    expect(await fs.readdir(directory)).toEqual([LEASE_FILE]);
  });
  it("keeps the previous lease whole when a revision cannot be published", async () => {
    const lease = writer();
    await lease.create();
    await fs.mkdir(path.join(directory, `${LEASE_FILE}.1.tmp`));
    await expect(lease.beginSpawn()).rejects.toThrow();
    expect((await read()).phase).toBe("created");
  });
  it("serialises concurrent revisions in call order", async () => {
    const lease = writer();
    await lease.create();
    await Promise.all([lease.beginSpawn(), lease.childSpawned(4100)]);
    expect(await read()).toMatchObject({
      phase: "spawned",
      children: [{ pid: 4100, processStart: null }],
    });
  });
  it("lists a second child beside the first and identifies only its own pid", async () => {
    const lease = writer();
    await lease.create();
    await lease.childSpawned(4100);
    await lease.childSpawned(4200);
    await lease.childIdentified(4200, {
      processStart: LATER,
      startedAtMs: Date.parse(LATER),
    });
    expect((await read()).children).toEqual([
      { pid: 4100, processStart: null, startedAtMs: null },
      { pid: 4200, processStart: LATER, startedAtMs: Date.parse(LATER) },
    ]);
  });
  it("refuses a lease with an unknown field", () => {
    expect(
      ExtractionLease.safeParse({
        schema: "farol.update-extraction-lease/1",
        ownerPid: 4000,
        ownerProcessStart: START,
        ownerStartedAtMs: 1,
        handle: "h",
        phase: "created",
        createdAt: 1,
        updatedAt: 1,
        children: [],
        extra: true,
      }).success,
    ).toBe(false);
  });
});

describe("one wall-clock start, one instant", () => {
  // US Eastern, 2026: clocks fall back at 06:00Z on 1 Nov and spring forward at
  // 07:00Z on 8 Mar. The offset is UTC minus local, in minutes.
  const eastern = (ms: number) =>
    ms >= Date.UTC(2026, 10, 1, 6) || ms < Date.UTC(2026, 2, 8, 7) ? 300 : 240;
  const parse = localStartParser(eastern);
  it("converts an unambiguous local time", () => {
    expect(parse("Thu Nov 26 10:00:00 2026")).toBe(
      Date.UTC(2026, 10, 26, 15, 0, 0),
    );
    expect(parse("Sat Jul  4 10:00:00 2026")).toBe(
      Date.UTC(2026, 6, 4, 14, 0, 0),
    );
  });
  it("refuses the repeated hour, which names two instants", () => {
    expect(parse("Sun Nov  1 01:30:00 2026")).toBeNaN();
  });
  it("refuses the skipped hour, which names none", () => {
    expect(parse("Sun Mar  8 02:30:00 2026")).toBeNaN();
  });
  it("refuses text that is not a start", () => {
    expect(parse("yesterday")).toBeNaN();
    expect(parse("Thu Foo 26 10:00:00 2026")).toBeNaN();
  });
  it("records no instant for an ambiguous start and calls a running pid unknown", async () => {
    const ambiguous = "Sun Nov  1 01:30:00 2026";
    expect(
      await readProcessIdentity(4000, answering(ambiguous), parse),
    ).toEqual({ processStart: ambiguous, startedAtMs: null });
    expect(
      await observeLeaseProcess(
        { pid: 4000, processStart: ambiguous, startedAtMs: null },
        answering(ambiguous),
        parse,
      ),
    ).toBe("unknown");
    // An unambiguous recorded start against an ambiguous observed one.
    expect(
      await observeLeaseProcess(
        {
          pid: 4000,
          processStart: START,
          startedAtMs: Date.UTC(2026, 10, 26, 15),
        },
        answering(ambiguous),
        parse,
      ),
    ).toBe("unknown");
  });
  it("still calls an absent pid ended whatever was recorded", async () => {
    expect(
      await observeLeaseProcess(
        {
          pid: 4000,
          processStart: "Sun Nov  1 01:30:00 2026",
          startedAtMs: null,
        },
        absent,
      ),
    ).toBe("ended");
  });
  it("compares instants, not text, after the zone changes", async () => {
    // Recorded under one zone; the same process now prints a different text.
    const tokyo = localStartParser(() => -540);
    expect(
      await observeLeaseProcess(
        {
          pid: 4000,
          processStart: START,
          startedAtMs: Date.UTC(2026, 10, 26, 15),
        },
        answering("Fri Nov 27 00:00:00 2026"),
        tokyo,
      ),
    ).toBe("live");
    // The text equals the recorded text, yet in this zone it is an earlier
    // instant: not the recorded process, and not provably a later one either.
    const recorded = {
      pid: 4000,
      processStart: START,
      startedAtMs: Date.UTC(2026, 10, 26, 15),
    };
    expect(await observeLeaseProcess(recorded, answering(START), tokyo)).toBe(
      "unknown",
    );
    expect(
      await observeLeaseProcess(
        recorded,
        answering("Fri Nov 27 10:00:00 2026"),
        tokyo,
      ),
    ).toBe("ended");
  });
});
