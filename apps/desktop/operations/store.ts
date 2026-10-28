import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createTotalOperationsRecorder } from "./recorder";
import { resolveOperationTarget, resolveOperationsSnapshot } from "./target";
import {
  OperationEntrySchema,
  OperationsDiagnosticsSchema,
  type OperationMetadata,
  type OperationEntry,
  type OperationsRecorder,
  type OperationsSnapshot,
} from "../renderer/operations-contract";

export const operationsLimits = {
  days: 30,
  bytes: 8 * 1024 * 1024,
  segmentBytes: 64 * 1024,
  entries: 20000,
} as const;
const segmentName = /^[0-9]{13}-[a-f0-9-]{36}\.jsonl$/u;
const diagnosticsName = /^[0-9]{13}-[a-f0-9-]{36}\.diagnostics\.json$/u;
const dayMs = 86400000;
type SegmentIndex = {
  first: number | null;
  last: number | null;
  count: number;
};
type QueuedEntry = { entry: OperationEntry; droppable: boolean };
type Labels = readonly { workspaceId: string; label: string }[];

/** One bounded, serial writer. No filesystem work runs in recording callers.
 * Each process owns its segments and diagnostics; readers validate disk data. */
export class OperationsStore implements OperationsRecorder {
  private segment = "";
  private segmentTime = 0;
  private segmentDay: number | undefined;
  private readonly writer: string;
  private writeFailures = 0;
  private droppedEntries = 0;
  private unrecordedUncertainEntries = 0;
  private readonly queue: QueuedEntry[] = [];
  private labels: Labels | undefined;
  private currentLabels: Labels | undefined;
  private readLabelsCache: Labels = [];
  private running: Promise<void> | undefined;
  private scheduled: NodeJS.Immediate | undefined;
  private readonly retentionTimer: NodeJS.Timeout;
  private retentionPending = false;
  private closed = false;
  private readonly activeLifecycles = new Set<string>();
  private diagnosticsDirty = false;
  private cached: OperationsSnapshot = {
    entries: [],
    corruptLines: 0,
    writeFailures: 0,
    droppedEntries: 0,
    unrecordedUncertainEntries: 0,
    unmappedCodes: 0,
  };
  private reading: Promise<OperationsSnapshot> | undefined;
  private readonly recorder = createTotalOperationsRecorder(
    {
      begin: (metadata) => this.beginEntry(metadata),
      record: (metadata, outcome, code, durationMs) =>
        this.append(metadata, outcome, code, durationMs),
      setWorkspaceLabels: (workspaces) => this.updateLabels(workspaces),
    },
    () => {
      this.diagnosticsDirty = true;
      this.schedule();
    },
    () => this.currentLabels ?? [],
  );
  readonly begin = this.recorder.begin;
  readonly record = this.recorder.record;
  readonly setWorkspaceLabels = this.recorder.setWorkspaceLabels;
  constructor(
    readonly directory: string,
    private readonly now = Date.now,
    private readonly limits: {
      days: number;
      bytes: number;
      segmentBytes: number;
      entries: number;
    } = operationsLimits,
    private readonly io = fs.promises,
    private readonly queueLimit = 1024,
  ) {
    this.writer = `${String(this.now()).padStart(13, "0")}-${randomUUID()}`;
    this.requestRetention();
    this.retentionTimer = setInterval(() => this.requestRetention(), dayMs);
    this.retentionTimer.unref();
  }
  private requestRetention(): void {
    if (this.closed) return;
    // One coalesced request; maintenance never starts a second writer.
    this.retentionPending = true;
    this.schedule();
  }
  private async prepare(): Promise<void> {
    await this.io.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.validateDirectory();
  }
  private async validateDirectory(): Promise<void> {
    const stat = await this.io.lstat(this.directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o700
    )
      throw Error("OPERATIONS_DIRECTORY_UNSAFE");
  }
  private async open(file: string, flags: number) {
    const handle = await this.io.open(
      file,
      flags | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      0o600,
    );
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o777) !== 0o600
      )
        throw Error("OPERATIONS_FILE_UNSAFE");
      return { handle, stat };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  private updateLabels(workspaces: Labels): void {
    if (this.closed) return;
    // Coalesced and bounded, through the same writer as observations.
    const labels = workspaces
      .slice(0, 128)
      .map(({ workspaceId, label }) => ({ workspaceId, label }));
    this.schedule();
    this.labels = labels;
    this.currentLabels = labels;
  }
  private async replace(file: string, value: unknown): Promise<void> {
    const temporary = path.join(this.directory, `${randomUUID()}.tmp`);
    const { handle } = await this.open(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    );
    try {
      try {
        await handle.writeFile(JSON.stringify(value));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.io.rename(temporary, file);
    } finally {
      await this.io.unlink(temporary).catch(() => undefined);
    }
  }
  private async readLabels(): Promise<Labels> {
    try {
      await this.validateDirectory();
      const { handle, stat } = await this.open(
        path.join(this.directory, "workspace-labels.json"),
        fs.constants.O_RDONLY,
      );
      try {
        if (stat.size > 65536) return [];
        const value: unknown = JSON.parse(await handle.readFile("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value))
          return [];
        // Validate each owner label independently; one corrupt sibling grants nothing.
        return Object.entries(value)
          .flatMap(([workspaceId, label]) => {
            try {
              const target = resolveOperationTarget(
                { workspace: workspaceId },
                [{ workspaceId, label: label as string }],
                "identifier",
              );
              return [{ workspaceId, label: target.workspace! }];
            } catch {
              return [];
            }
          })
          .slice(0, 128);
      } finally {
        await handle.close();
      }
    } catch {
      return [];
    }
  }
  /** Load the private owner index before a separate MCP writer serves requests.
   * Missing/unreadable configuration leaves all workspace targets unresolved. */
  async loadWorkspaceLabels(deadlineMs = 100): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const labels = await Promise.race([
        this.readLabels(),
        new Promise<Labels>((resolve) => {
          timer = setTimeout(() => resolve([]), Math.max(0, deadlineMs));
        }),
      ]);
      this.currentLabels ??= labels;
    } finally {
      clearTimeout(timer);
    }
  }
  private beginEntry(metadata: OperationMetadata) {
    const id = randomUUID();
    this.append(metadata, "pending", null, 0, { id, phase: "started" });
    this.activeLifecycles.add(id);
    let observed = false;
    return (
      outcome: OperationEntry["outcome"],
      code: string | null,
      durationMs: number,
    ) => {
      if (observed) return;
      observed = true;
      this.activeLifecycles.delete(id);
      this.append(metadata, outcome, code, durationMs, {
        id,
        phase: "observed",
      });
    };
  }
  private lost(items: readonly QueuedEntry[]): void {
    this.droppedEntries += items.length;
    this.unrecordedUncertainEntries += items.filter(
      ({ droppable }) => !droppable,
    ).length;
    this.diagnosticsDirty = true;
  }
  private append(
    metadata: OperationMetadata,
    outcome: OperationEntry["outcome"],
    code: string | null,
    durationMs: number,
    lifecycle?: NonNullable<OperationEntry["lifecycle"]>,
  ): void {
    const entry = OperationEntrySchema.parse({
      ...metadata,
      ...(lifecycle ? { lifecycle } : {}),
      id: randomUUID(),
      at: this.now(),
      outcome,
      code,
      durationMs: Math.max(0, Math.round(durationMs)),
    });
    const item = {
      entry,
      droppable: outcome !== "pending" && outcome !== "unknown",
    };
    if (item.droppable && lifecycle?.phase === "observed") {
      const start = this.queue.find(
        (q) =>
          q.entry.lifecycle?.id === lifecycle.id &&
          q.entry.lifecycle.phase === "started",
      );
      if (start) start.droppable = true;
    }
    if (this.closed) {
      this.lost([item]);
      return;
    }
    this.schedule();
    if (this.queue.length >= this.queueLimit) {
      const index = this.queue.findIndex((q) => q.droppable);
      if (index < 0) {
        this.lost([item]);
        return;
      }
      this.lost(this.queue.splice(index, 1));
    }
    this.queue.push(item);
  }
  private schedule(): void {
    if (this.running || this.scheduled || this.closed) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined;
      this.start();
    });
  }
  private start(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.drain()
      .catch(() => {
        this.writeFailures++;
        this.diagnosticsDirty = true;
      })
      .finally(() => {
        this.running = undefined;
        if (this.queue.length || this.labels || this.retentionPending)
          this.schedule();
      });
    return this.running;
  }
  private async drain(): Promise<void> {
    let diagnosticsFailed = false;
    do {
      diagnosticsFailed = false;
      this.retentionPending = false;
      const batch = this.queue.splice(0, 64);
      const labels = this.labels;
      this.labels = undefined;
      try {
        await this.prepare();
      } catch {
        // Rejected preparation grants no maintenance through this path. Consume
        // the batch once and retain diagnostics in memory until a future pass.
        this.writeFailures++;
        this.lost(batch);
        diagnosticsFailed = true;
        continue;
      }
      try {
        if (labels)
          await this.replace(
            path.join(this.directory, "workspace-labels.json"),
            Object.fromEntries(labels.map((w) => [w.workspaceId, w.label])),
          );
        if (batch.length) await this.writeBatch(batch);
      } catch {
        // Never replay an uncertain/partially written batch. Keep counters only.
        this.writeFailures++;
        this.lost(batch);
      }
      try {
        await this.prune();
      } catch {
        this.writeFailures++;
        this.diagnosticsDirty = true;
      }
      if (this.diagnosticsDirty) {
        this.diagnosticsDirty = false;
        const diagnostics = this.diagnostics();
        try {
          await this.replace(
            path.join(this.directory, `${this.writer}.diagnostics.json`),
            diagnostics,
          );
        } catch {
          this.writeFailures++;
          this.diagnosticsDirty = true;
          diagnosticsFailed = true;
          // No busy retry on a failed disk. A future enqueue/flush can publish counts.
        }
      }
    } while (
      this.queue.length ||
      this.labels ||
      this.retentionPending ||
      (this.diagnosticsDirty && !diagnosticsFailed)
    );
  }
  private diagnostics() {
    const recorder = this.recorder.diagnostics();
    return {
      unmappedCodes: recorder.unmappedCodes,
      writeFailures: this.writeFailures + recorder.writeFailures,
      droppedEntries: this.droppedEntries + recorder.droppedEntries,
      unrecordedUncertainEntries:
        this.unrecordedUncertainEntries + recorder.unrecordedUncertainEntries,
    };
  }
  private async writeBatch(batch: readonly QueuedEntry[]): Promise<void> {
    let handle:
      Awaited<ReturnType<OperationsStore["open"]>>["handle"] | undefined;
    let size = 0;
    const close = async () => {
      if (!handle) return;
      const current = handle;
      handle = undefined;
      try {
        await current.sync();
      } finally {
        await current.close();
      }
    };
    try {
      for (const { entry } of batch) {
        const day = Math.floor(entry.at / dayMs);
        if (this.segment && day !== this.segmentDay) {
          await close();
          this.segment = "";
        }
        if (!handle) {
          if (!this.segment) {
            this.segmentTime = Math.max(this.now(), this.segmentTime + 1);
            this.segment = `${String(this.segmentTime).padStart(13, "0")}-${randomUUID()}.jsonl`;
            this.segmentDay = day;
          }
          const opened = await this.open(
            path.join(this.directory, this.segment),
            fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT,
          );
          handle = opened.handle;
          size = opened.stat.size;
          if (size > 0) {
            const tail = Buffer.alloc(1);
            await handle.read(tail, 0, 1, size - 1);
            if (tail[0] !== 10) {
              await handle.writeFile("\n");
              size++;
            }
          }
        }
        const line = JSON.stringify(entry) + "\n";
        await handle.writeFile(line);
        size += Buffer.byteLength(line);
        if (size >= this.limits.segmentBytes) {
          await close();
          this.segment = "";
        }
      }
    } finally {
      await close();
    }
  }
  private async segmentIndex(
    name: string,
    text: string,
  ): Promise<SegmentIndex> {
    const index: SegmentIndex = { first: null, last: null, count: 0 };
    for (const line of text.split("\n")) {
      if (!line) continue;
      index.count++;
      try {
        const parsed = OperationEntrySchema.safeParse(JSON.parse(line));
        if (!parsed.success) continue;
        const at = parsed.data.at;
        index.first = Math.min(index.first ?? at, at);
        index.last = Math.max(index.last ?? at, at);
      } catch {
        // Invalid lines remain visible as corruption diagnostics, never content.
      }
    }
    const file = path.join(this.directory, `${name}.index.json`);
    const serialized = JSON.stringify(index);
    let previous: string | undefined;
    try {
      const { handle, stat } = await this.open(file, fs.constants.O_RDONLY);
      try {
        if (stat.size <= 1024) previous = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
    } catch {
      // The content scan is authoritative, including after an interrupted append.
    }
    if (previous !== serialized) await this.replace(file, index);
    return index;
  }
  private async prune(): Promise<void> {
    const files = (await this.io.readdir(this.directory))
      .filter((name) => segmentName.test(name))
      .sort()
      .reverse();
    const segments = [];
    for (const name of files) {
      const file = path.join(this.directory, name);
      const inspected = await this.io.lstat(file).catch(() => undefined);
      if (
        !inspected?.isFile() ||
        inspected.nlink !== 1 ||
        inspected.uid !== process.getuid?.()
      )
        continue;
      const { handle, stat } = await this.open(file, fs.constants.O_RDONLY);
      let index: SegmentIndex;
      try {
        index =
          stat.size > this.limits.segmentBytes + 16384
            ? { first: null, last: null, count: this.limits.entries }
            : await this.segmentIndex(name, await handle.readFile("utf8"));
      } finally {
        await handle.close();
      }
      segments.push({ name, file, size: stat.size, index });
    }
    // Filename time orders writes with equal timestamps, never retention age.
    segments.sort(
      (a, b) =>
        (b.index.last ?? Infinity) - (a.index.last ?? Infinity) ||
        b.name.localeCompare(a.name),
    );
    const cutoff = this.now() - this.limits.days * dayMs;
    let bytes = 0,
      entries = 0;
    for (const { name, file, size, index } of segments) {
      bytes += size + Buffer.byteLength(JSON.stringify(index));
      entries += index.count;
      if (
        (index.last !== null && index.last < cutoff) ||
        bytes > this.limits.bytes ||
        entries > this.limits.entries
      ) {
        await this.io.unlink(file);
        await this.io.unlink(`${file}.index.json`).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
        if (name === this.segment) this.segment = "";
      }
    }
    // Diagnostics have a separate small bound; old processes cannot grow it forever.
    let diagnosticBytes = 0;
    const diagnosticFiles = (await this.io.readdir(this.directory))
      .filter((name) => diagnosticsName.test(name))
      .sort()
      .reverse();
    for (const name of diagnosticFiles) {
      const file = path.join(this.directory, name);
      const stat = await this.io.lstat(file).catch(() => undefined);
      if (
        !stat?.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.()
      )
        continue;
      diagnosticBytes += stat.size;
      if (diagnosticBytes > 65536 || Number(name.slice(0, 13)) < cutoff)
        await this.io.unlink(file);
    }
  }
  /** A referenced deadline bounds shutdown even if a filesystem promise never settles. */
  async flush(deadlineMs = 250): Promise<boolean> {
    if (this.scheduled) {
      clearImmediate(this.scheduled);
      this.scheduled = undefined;
    }
    const previousFailures = this.diagnostics().writeFailures;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.start().then(
          () => this.diagnostics().writeFailures === previousFailures,
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(0, deadlineMs));
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async shutdown(deadlineMs = 250): Promise<boolean> {
    this.closed = true;
    clearInterval(this.retentionTimer);
    // A clean, idle writer has nothing left to flush. Starting a new drain
    // would needlessly scan old segments inside the shutdown deadline. Any
    // queued work, retention request or in-flight writer still uses flush().
    if (
      !this.running &&
      !this.queue.length &&
      !this.labels &&
      !this.retentionPending &&
      !this.diagnosticsDirty
    ) {
      if (this.scheduled) clearImmediate(this.scheduled);
      this.scheduled = undefined;
      return true;
    }
    return this.flush(deadlineMs);
  }
  /** Reads never prune or wait for the writer. Slow reads return the last snapshot. */
  async snapshot(deadlineMs = 100): Promise<OperationsSnapshot> {
    this.reading ??= this.readSnapshot()
      .then((value) => {
        this.cached = value;
        return value;
      })
      .finally(() => {
        this.reading = undefined;
      });
    let timer: NodeJS.Timeout | undefined;
    try {
      const snapshot = await Promise.race([
        this.reading,
        new Promise<OperationsSnapshot>((resolve) => {
          timer = setTimeout(
            () =>
              resolve({
                ...this.cached,
                // A deadline is not a failed write or a corrupt record.
                // Retain conservative lifecycle handling until the read ends.
                readPending: true,
              }),
            deadlineMs,
          );
        }),
      ]);
      const diagnostics = this.mergeDiagnostics(snapshot);
      return resolveOperationsSnapshot(
        {
          ...snapshot,
          ...diagnostics,
          activeLifecycleIds:
            this.closed ||
            snapshot.readPending === true ||
            snapshot.corruptLines > 0 ||
            diagnostics.writeFailures > 0 ||
            diagnostics.droppedEntries > 0
              ? []
              : [...this.activeLifecycles].slice(0, 20000),
        },
        this.currentLabels ?? this.readLabelsCache,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  private mergeDiagnostics(snapshot: OperationsSnapshot) {
    // readSnapshot includes other writers only; our counters are always current.
    const current = this.diagnostics();
    return {
      unmappedCodes: snapshot.unmappedCodes + current.unmappedCodes,
      writeFailures: snapshot.writeFailures + current.writeFailures,
      droppedEntries: snapshot.droppedEntries + current.droppedEntries,
      unrecordedUncertainEntries:
        snapshot.unrecordedUncertainEntries +
        current.unrecordedUncertainEntries,
    };
  }
  private async readSnapshot(): Promise<OperationsSnapshot> {
    const cutoff = this.now() - this.limits.days * dayMs;
    let corruptLines = 0;
    const entries: OperationEntry[] = [];
    const labels = this.currentLabels ?? (await this.readLabels());
    this.readLabelsCache = labels;
    const parseLine = (line: string) => {
      const raw = JSON.parse(line) as OperationEntry;
      return OperationEntrySchema.safeParse({
        ...raw,
        target: resolveOperationTarget(raw.target, labels, "persisted"),
      });
    };
    const diagnostics = {
      writeFailures: 0,
      droppedEntries: 0,
      unrecordedUncertainEntries: 0,
      unmappedCodes: 0,
    };
    try {
      await this.validateDirectory();
      const names = (await this.io.readdir(this.directory)).sort();
      for (const name of names) {
        if (!segmentName.test(name) && !diagnosticsName.test(name)) continue;
        if (diagnosticsName.test(name) && Number(name.slice(0, 13)) < cutoff)
          continue;
        if (name === `${this.writer}.diagnostics.json`) continue;
        try {
          const { handle, stat } = await this.open(
            path.join(this.directory, name),
            fs.constants.O_RDONLY,
          );
          let text: string;
          let completedTail: string | undefined;
          try {
            if (stat.size > this.limits.segmentBytes + 16384) {
              corruptLines++;
              continue;
            }
            const snapshot = await handle.readFile();
            const after = await handle.stat();
            // Growth alone does not repair an invalid tail: an unrelated append
            // can follow durable corruption. Re-read this exact fragment through
            // the same descriptor and require a complete, valid record below.
            if (
              segmentName.test(name) &&
              after.size > stat.size &&
              after.size <= this.limits.segmentBytes + 16384 &&
              snapshot.length > 0 &&
              snapshot.at(-1) !== 10
            ) {
              const offset = snapshot.lastIndexOf(10) + 1;
              const fragment = snapshot.subarray(offset);
              const size = after.size - offset;
              if (size > 0) {
                try {
                  const tail = Buffer.alloc(size);
                  const { bytesRead } = await handle.read(
                    tail,
                    0,
                    size,
                    offset,
                  );
                  const observed = tail.subarray(0, bytesRead);
                  const newline = observed.indexOf(10);
                  if (
                    bytesRead === size &&
                    newline >= 0 &&
                    newline >= fragment.length &&
                    observed.subarray(0, fragment.length).equals(fragment)
                  )
                    completedTail = observed
                      .subarray(0, newline)
                      .toString("utf8");
                } catch {
                  // Keep the first snapshot and its warning if tail read fails.
                }
              }
            }
            text = snapshot.toString("utf8");
          } finally {
            await handle.close();
          }
          if (diagnosticsName.test(name)) {
            const parsed = OperationsDiagnosticsSchema.parse(JSON.parse(text));
            diagnostics.unmappedCodes += parsed.unmappedCodes;
            diagnostics.writeFailures += parsed.writeFailures;
            diagnostics.droppedEntries += parsed.droppedEntries;
            diagnostics.unrecordedUncertainEntries +=
              parsed.unrecordedUncertainEntries;
          } else {
            let tailCompleted = false;
            if (completedTail !== undefined) {
              try {
                tailCompleted = parseLine(completedTail).success;
              } catch {
                // An unrelated or malformed append cannot clear the failure.
              }
            }
            const lines = text.split("\n");
            for (const [index, line] of lines.entries()) {
              if (!line) continue;
              // A valid historical tail remains visible. Only an invalid,
              // unterminated fragment can belong to an append still in flight.
              const incomplete = index === lines.length - 1;
              try {
                const parsed = parseLine(line);
                if (parsed.success) {
                  if (parsed.data.at >= cutoff) entries.push(parsed.data);
                } else if (!incomplete) corruptLines++;
                else if (!tailCompleted) diagnostics.writeFailures++;
              } catch {
                if (!incomplete) corruptLines++;
                else if (!tailCompleted) diagnostics.writeFailures++;
              }
            }
          }
        } catch {
          corruptLines++;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") corruptLines++;
    }
    const observed = new Set(
      entries
        .filter((entry) => entry.lifecycle?.phase === "observed")
        .map((entry) => entry.lifecycle!.id),
    );
    return {
      entries: entries
        .filter(
          (entry) =>
            entry.lifecycle?.phase !== "started" ||
            !observed.has(entry.lifecycle.id),
        )
        .sort((a, b) => a.at - b.at)
        .slice(-this.limits.entries),
      corruptLines,
      ...diagnostics,
    };
  }
}
