export type QualificationStage = "core-resources" | "shell-runtime";
export type QualificationResult = "passed" | "refused" | "deadline-expired";
type Work =
  "read" | "hash" | "stat" | "directory" | "recheck" | "open" | "setup";
export type QualificationObservation = Readonly<{
  stage: QualificationStage;
  event: "begin" | "end";
  result: QualificationResult | "pending";
  monotonicMs: number;
  deadlineMs: number | null;
  elapsedMs: number;
  files: number;
  entries: number;
  bytes: number;
  readCalls: number;
  statCalls: number;
  readMs: number;
  hashMs: number;
  statMs: number;
  directoryMs: number;
  recheckMs: number;
  openMs: number;
  setupMs: number;
  otherMs: number;
  cpuUserMs: number;
  cpuSystemMs: number;
}>;
export type QualificationObserver = (value: QualificationObservation) => void;

// Content-free observation only. No file names, inputs or error text enter a
// snapshot, and a diagnostic sink cannot grant authority or change an outcome.
export function qualificationMetrics(
  stage: QualificationStage,
  deadline: number,
  observer?: QualificationObserver,
) {
  const started = observer ? performance.now() : 0;
  const cpu = observer ? process.cpuUsage() : undefined;
  const times: Record<Work, number> = {
    read: 0,
    hash: 0,
    stat: 0,
    directory: 0,
    recheck: 0,
    open: 0,
    setup: 0,
  };
  let files = 0,
    entries = 0,
    bytes = 0,
    readCalls = 0,
    statCalls = 0;
  const emit = (
    event: "begin" | "end",
    result: QualificationObservation["result"],
  ) => {
    if (!observer) return;
    const now = performance.now();
    const used = process.cpuUsage(cpu);
    try {
      observer(
        Object.freeze({
          stage,
          event,
          result,
          monotonicMs: now,
          deadlineMs: Number.isFinite(deadline) ? deadline : null,
          elapsedMs: Math.max(0, now - started),
          files,
          entries,
          bytes,
          readCalls,
          statCalls,
          readMs: times.read,
          hashMs: times.hash,
          statMs: times.stat,
          directoryMs: times.directory,
          recheckMs: times.recheck,
          openMs: times.open,
          setupMs: times.setup,
          otherMs: Math.max(
            0,
            now -
              started -
              Object.values(times).reduce((sum, value) => sum + value, 0),
          ),
          cpuUserMs: used.user / 1000,
          cpuSystemMs: used.system / 1000,
        }),
      );
    } catch {
      // Logging failure is not qualification evidence.
    }
  };
  emit("begin", "pending");
  return {
    file: () => {
      files++;
    },
    entry: () => {
      entries++;
    },
    bytes: (count: number) => {
      bytes += count;
    },
    async time<T>(kind: Work, run: () => Promise<T>): Promise<T> {
      if (!observer) return run();
      if (kind === "read") readCalls++;
      if (kind === "stat" || kind === "recheck") statCalls++;
      const before = performance.now();
      try {
        return await run();
      } finally {
        times[kind] += Math.max(0, performance.now() - before);
      }
    },
    sync<T>(kind: Work, run: () => T): T {
      if (!observer) return run();
      const before = performance.now();
      try {
        return run();
      } finally {
        times[kind] += Math.max(0, performance.now() - before);
      }
    },
    finish: (result: QualificationResult) => emit("end", result),
  };
}
