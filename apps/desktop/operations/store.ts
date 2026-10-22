import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
type QueuedEntry = { entry: OperationEntry; droppable: boolean };
type Labels = readonly { workspaceId: string; label: string }[];

/** One bounded, serial writer. No filesystem work runs in recording callers.
 * Each process owns its segments and diagnostics; readers validate disk data. */
export class OperationsStore implements OperationsRecorder {
  private segment = "";
  private segmentTime = 0;
  private readonly writer: string;
  private writeFailures = 0;
  private droppedEntries = 0;
  private unrecordedUncertainEntries = 0;
  private readonly queue: QueuedEntry[] = [];
  private labels: Labels | undefined;
  private running: Promise<void> | undefined;
  private scheduled: NodeJS.Immediate | undefined;
  private closed = false;
  private diagnosticsDirty = false;
  private cached: OperationsSnapshot = {
    entries: [],
    corruptLines: 0,
    writeFailures: 0,
    droppedEntries: 0,
    unrecordedUncertainEntries: 0,
  };
  private reading: Promise<OperationsSnapshot> | undefined;
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
  setWorkspaceLabels(workspaces: Labels): void {
    if (this.closed) return;
    // Coalesced and bounded, through the same writer as observations.
    this.labels = workspaces
      .slice(0, 128)
      .map(({ workspaceId, label }) => ({ workspaceId, label }));
    this.schedule();
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
  private async readLabels(): Promise<Record<string, unknown>> {
    try {
      const { handle, stat } = await this.open(
        path.join(this.directory, "workspace-labels.json"),
        fs.constants.O_RDONLY,
      );
      try {
        if (stat.size > 65536) return {};
        const labels: unknown = JSON.parse(await handle.readFile("utf8"));
        return labels && typeof labels === "object"
          ? (labels as Record<string, unknown>)
          : {};
      } finally {
        await handle.close();
      }
    } catch {
      return {};
    }
  }
  begin(metadata: OperationMetadata) {
    const id = randomUUID();
    this.append(metadata, "pending", null, 0, { id, phase: "started" });
    let observed = false;
    return (
      outcome: OperationEntry["outcome"],
      code: string | null,
      durationMs: number,
    ) => {
      if (observed) return;
      observed = true;
      this.append(metadata, outcome, code, durationMs, {
        id,
        phase: "observed",
      });
    };
  }
  record(
    metadata: OperationMetadata,
    outcome: OperationEntry["outcome"],
    code: string | null,
    durationMs: number,
  ): void {
    this.append(metadata, outcome, code, durationMs);
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
    try {
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
      if (this.queue.length >= this.queueLimit) {
        const index = this.queue.findIndex((q) => q.droppable);
        if (index < 0) {
          this.lost([item]);
          this.schedule();
          return;
        }
        this.lost(this.queue.splice(index, 1));
      }
      this.queue.push(item);
      this.schedule();
    } catch {
      this.writeFailures++;
      this.diagnosticsDirty = true;
      this.schedule();
    }
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
        if (this.queue.length || this.labels) this.schedule();
      });
    return this.running;
  }
  private async drain(): Promise<void> {
    let diagnosticsFailed = false;
    do {
      diagnosticsFailed = false;
      const batch = this.queue.splice(0, 64);
      const labels = this.labels;
      this.labels = undefined;
      try {
        await this.prepare();
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
      (this.diagnosticsDirty && !diagnosticsFailed)
    );
  }
  private diagnostics() {
    return {
      writeFailures: this.writeFailures,
      droppedEntries: this.droppedEntries,
      unrecordedUncertainEntries: this.unrecordedUncertainEntries,
    };
  }
  private async writeBatch(batch: readonly QueuedEntry[]): Promise<void> {
    const labels = await this.readLabels();
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
        if (!handle) {
          if (!this.segment) {
            this.segmentTime = Math.max(this.now(), this.segmentTime + 1);
            this.segment = `${String(this.segmentTime).padStart(13, "0")}-${randomUUID()}.jsonl`;
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
        const workspace = entry.target.workspace;
        const label =
          workspace && Object.hasOwn(labels, workspace)
            ? labels[workspace]
            : undefined;
        const resolved =
          typeof label === "string" &&
          label.length <= 160 &&
          !/[\x00-\x1f\x7f]/u.test(label)
            ? { ...entry, target: { ...entry.target, workspace: label } }
            : entry;
        const line = JSON.stringify(resolved) + "\n";
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
  private async prune(): Promise<void> {
    const files = (await this.io.readdir(this.directory))
      .filter((name) => segmentName.test(name))
      .sort()
      .reverse();
    let bytes = 0,
      entries = 0;
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
      let count: number;
      try {
        count =
          stat.size > this.limits.segmentBytes + 16384
            ? this.limits.entries
            : (await handle.readFile("utf8")).split("\n").length - 1;
      } finally {
        await handle.close();
      }
      bytes += stat.size;
      entries += count;
      if (
        Number(name.slice(0, 13)) < this.now() - this.limits.days * 86400000 ||
        bytes > this.limits.bytes ||
        entries > this.limits.entries
      ) {
        await this.io.unlink(file);
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
      if (
        diagnosticBytes > 65536 ||
        Number(name.slice(0, 13)) < this.now() - this.limits.days * 86400000
      )
        await this.io.unlink(file);
    }
  }
  /** A referenced deadline bounds shutdown even if a filesystem promise never settles. */
  async flush(deadlineMs = 250): Promise<boolean> {
    if (this.scheduled) {
      clearImmediate(this.scheduled);
      this.scheduled = undefined;
    }
    const previousFailures = this.writeFailures;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.start().then(() => this.writeFailures === previousFailures),
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
                corruptLines: this.cached.corruptLines + 1,
              }),
            deadlineMs,
          );
        }),
      ]);
      return { ...snapshot, ...this.mergeDiagnostics(snapshot) };
    } finally {
      clearTimeout(timer);
    }
  }
  private mergeDiagnostics(snapshot: OperationsSnapshot) {
    // readSnapshot includes other writers only; our counters are always current.
    return {
      writeFailures: snapshot.writeFailures + this.writeFailures,
      droppedEntries: snapshot.droppedEntries + this.droppedEntries,
      unrecordedUncertainEntries:
        snapshot.unrecordedUncertainEntries + this.unrecordedUncertainEntries,
    };
  }
  private async readSnapshot(): Promise<OperationsSnapshot> {
    let corruptLines = 0;
    const entries: OperationEntry[] = [];
    const diagnostics = {
      writeFailures: 0,
      droppedEntries: 0,
      unrecordedUncertainEntries: 0,
    };
    try {
      await this.validateDirectory();
      const names = (await this.io.readdir(this.directory)).sort();
      for (const name of names) {
        if (!segmentName.test(name) && !diagnosticsName.test(name)) continue;
        if (
          Number(name.slice(0, 13)) <
          this.now() - this.limits.days * 86400000
        )
          continue;
        if (name === `${this.writer}.diagnostics.json`) continue;
        try {
          const { handle, stat } = await this.open(
            path.join(this.directory, name),
            fs.constants.O_RDONLY,
          );
          let text: string;
          try {
            if (stat.size > this.limits.segmentBytes + 16384) {
              corruptLines++;
              continue;
            }
            text = await handle.readFile("utf8");
          } finally {
            await handle.close();
          }
          if (diagnosticsName.test(name)) {
            const parsed = OperationsDiagnosticsSchema.parse(JSON.parse(text));
            diagnostics.writeFailures += parsed.writeFailures;
            diagnostics.droppedEntries += parsed.droppedEntries;
            diagnostics.unrecordedUncertainEntries +=
              parsed.unrecordedUncertainEntries;
          } else
            for (const line of text.split("\n")) {
              if (!line) continue;
              try {
                const parsed = OperationEntrySchema.safeParse(JSON.parse(line));
                if (parsed.success) entries.push(parsed.data);
                else corruptLines++;
              } catch {
                corruptLines++;
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
