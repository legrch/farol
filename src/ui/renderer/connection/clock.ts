import {
  ConnectionStatusViewSchema,
  unavailableConnectionStatus,
  type ConnectionStatusView,
} from "../../../../apps/desktop/renderer/connection-status";
import type { WindowSnapshot } from "../contract";

export type ConnectionStatusRead = Readonly<{
  clockEpoch: number;
  malformedRevision: number;
  validClock: boolean;
  buildId: string | null;
  environment: WindowSnapshot["environment"];
}>;

/** The part of a parsed bootstrap projection this clock reads. */
export type ConnectionStatusBootstrap = Readonly<{
  environment: WindowSnapshot["environment"];
  build: Readonly<{ buildId: string }>;
  connectionStatus?: unknown;
}>;

/** What the window gives the clock; it owns no window state. */
export type ConnectionStatusHost = Readonly<{
  disposed(): boolean;
  current(): ConnectionStatusView | undefined;
  buildId(): string | null;
  environment(): WindowSnapshot["environment"];
  publish(view: ConnectionStatusView): void;
  /** One local read-only bootstrap, parsed; null when it does not parse. */
  readBootstrap(): Promise<ConnectionStatusBootstrap | null>;
}>;

// The renderer's own presentation clock for the connection status: it spends
// the original Go deadline against the renderer's monotonic clock, and a wall
// or monotonic discontinuity retires a positive view until a fresh read lands.
// Moved verbatim from WindowController.
export class ConnectionStatusClock {
  constructor(private readonly host: ConnectionStatusHost) {}
  private connectionStatusTimer: ReturnType<typeof setTimeout> | null = null;
  retire(): void {
    if (this.connectionStatusTimer !== null)
      clearTimeout(this.connectionStatusTimer);
    this.connectionStatusTimer = null;
  }
  private connectionClock: {
    wall: number;
    monotonic: number;
    lastWall: number;
    lastMonotonic: number;
  } | null = null;
  private connectionClockEpoch = 0;
  private connectionClockBlocked = false;
  private connectionClockRead: Promise<void> | null = null;
  private connectionClockReadEpoch = -1;
  private connectionMalformedRevision = 0;
  private sampleConnectionClock(): { wall: number; monotonic: number } | null {
    const wall = Date.now(),
      monotonic = performance.now();
    const valid =
      Number.isSafeInteger(wall) &&
      wall > 0 &&
      Number.isFinite(monotonic) &&
      monotonic >= 0;
    const previous = this.connectionClock;
    if (
      !valid ||
      (previous &&
        (wall < previous.lastWall ||
          monotonic < previous.lastMonotonic ||
          Math.abs(wall - previous.wall - (monotonic - previous.monotonic)) >
            1000))
    ) {
      this.connectionClockEpoch++;
      this.connectionClockBlocked = true;
      this.connectionClock = null;
    }
    if (!valid) return null;
    // Continuity belongs to the window, including unavailable/malformed views
    // and expired leases. A newer revision must not reset the clock origin.
    this.connectionClock ??= {
      wall,
      monotonic,
      lastWall: wall,
      lastMonotonic: monotonic,
    };
    this.connectionClock.lastWall = wall;
    this.connectionClock.lastMonotonic = monotonic;
    return { wall, monotonic };
  }
  private withdrawConnectionStatus(
    revision = this.host.current()?.revision ?? 0,
  ): void {
    this.retire();
    this.host.publish({ ...unavailableConnectionStatus, revision });
  }
  beginRead(): ConnectionStatusRead {
    const validClock = this.sampleConnectionClock() !== null;
    if (
      this.connectionClockBlocked &&
      this.host.current()?.validUntilMillis != null
    )
      this.withdrawConnectionStatus();
    return {
      clockEpoch: this.connectionClockEpoch,
      malformedRevision: this.connectionMalformedRevision,
      validClock,
      buildId: this.host.buildId(),
      environment: this.host.environment(),
    };
  }
  adoptRead(data: ConnectionStatusBootstrap, read: ConnectionStatusRead): void {
    if (this.host.disposed() || data.connectionStatus === undefined) return;
    const clock = this.sampleConnectionClock();
    const sourceCurrent =
      read.buildId === null ||
      (read.buildId === this.host.buildId() &&
        data.build.buildId === read.buildId &&
        read.environment === this.host.environment() &&
        data.environment === read.environment);
    const reconciled = Boolean(
      clock &&
      read.validClock &&
      sourceCurrent &&
      read.clockEpoch === this.connectionClockEpoch &&
      this.connectionClockBlocked,
    );
    // A valid fresh read settles the clock fence even when a later publication
    // supersedes its body. Revision/publication ordering is checked separately.
    if (reconciled) this.connectionClockBlocked = false;
    if (
      this.connectionClockBlocked &&
      this.host.current()?.validUntilMillis != null
    )
      this.withdrawConnectionStatus();
    if (read.malformedRevision !== this.connectionMalformedRevision) return;
    this.adopt(data.connectionStatus, reconciled);
  }
  private reconcileConnectionClock(): void {
    if (
      this.host.disposed() ||
      !this.connectionClock ||
      !this.host.buildId() ||
      this.connectionClockRead ||
      this.connectionClockReadEpoch === this.connectionClockEpoch
    )
      return;
    const read = this.beginRead();
    const epoch = read.clockEpoch,
      build = this.host.buildId();
    const environment = this.host.environment();
    this.connectionClockReadEpoch = epoch;
    // One local, read-only IPC snapshot issued after the discontinuity fences
    // queued positive events. It grants nothing and adopts no other UI state.
    this.connectionClockRead = Promise.resolve().then(async () => {
      try {
        if (this.host.disposed() || epoch !== this.connectionClockEpoch) return;
        const data = await this.host.readBootstrap();
        if (
          this.host.disposed() ||
          epoch !== this.connectionClockEpoch ||
          build !== this.host.buildId() ||
          environment !== this.host.environment()
        )
          return;
        if (
          !data ||
          data.build.buildId !== build ||
          data.environment !== environment ||
          !data.connectionStatus
        )
          return;
        this.adoptRead(data, read);
      } catch {
        // Failed or unsettled reads never renew the retired presentation.
      } finally {
        this.connectionClockRead = null;
      }
    });
  }
  adopt(value: unknown, reconciled = false): void {
    if (this.host.disposed()) return;
    const clock = this.sampleConnectionClock();
    const parsed = ConnectionStatusViewSchema.safeParse(value);
    if (!parsed.success) {
      this.connectionMalformedRevision++;
      this.withdrawConnectionStatus();
      if (this.connectionClockBlocked) this.reconcileConnectionClock();
      return;
    }
    const projection = parsed.data;
    const revision = this.host.current()?.revision ?? -1;
    if (
      projection.revision < revision ||
      (!reconciled && projection.revision === revision)
    ) {
      if (this.connectionClockBlocked) {
        this.withdrawConnectionStatus();
        this.reconcileConnectionClock();
      }
      return;
    }
    this.retire();
    const until = projection.validUntilMillis;
    if (projection.state !== "recent_transport" && until == null) {
      this.host.publish(projection);
      if (this.connectionClockBlocked) this.reconcileConnectionClock();
      return;
    }
    if (
      !clock ||
      this.connectionClockBlocked ||
      until == null ||
      until <= clock.wall
    ) {
      this.withdrawConnectionStatus(projection.revision);
      if (this.connectionClockBlocked) this.reconcileConnectionClock();
      return;
    }
    const { wall, monotonic } = clock;
    // Consume the original Go deadline. Neither another message nor bootstrap
    // can replenish the independent renderer's monotonic presentation budget.
    const budget = until - wall;
    const expire = () => {
      const shown = this.host.current();
      if (
        this.host.disposed() ||
        shown?.revision !== projection.revision ||
        shown.state !== projection.state
      )
        return;
      this.connectionStatusTimer = null;
      const current = this.sampleConnectionClock();
      const elapsed = current ? current.monotonic - monotonic : NaN;
      if (
        !current ||
        this.connectionClockBlocked ||
        !Number.isFinite(elapsed) ||
        elapsed < 0 ||
        current.wall >= until ||
        elapsed >= budget
      ) {
        this.withdrawConnectionStatus();
        if (this.connectionClockBlocked) this.reconcileConnectionClock();
        return;
      }
      this.connectionStatusTimer = setTimeout(
        expire,
        Math.min(1000, until - current.wall, budget - elapsed),
      );
    };
    // Establish cleanup ownership before synchronous snapshot subscribers run.
    this.connectionStatusTimer = setTimeout(expire, Math.min(1000, budget));
    this.host.publish(projection);
  }
}
