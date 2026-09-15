export class DeferredGate {
  private outcome: "released" | "cancelled" | null = null;
  private readonly promise: Promise<"released" | "cancelled">;
  private settlePromise: ((outcome: "released" | "cancelled") => void) | null =
    null;

  constructor(readonly name: string) {
    this.promise = new Promise<"released" | "cancelled">((resolve) => {
      this.settlePromise = resolve;
    });
  }

  wait(): Promise<"released" | "cancelled"> {
    return this.promise;
  }

  release(): boolean {
    return this.settle("released");
  }

  cancel(): boolean {
    return this.settle("cancelled");
  }

  private settle(outcome: "released" | "cancelled"): boolean {
    if (this.outcome !== null) return false;
    this.outcome = outcome;
    this.settlePromise?.(outcome);
    this.settlePromise = null;
    return true;
  }

  isReleased(): boolean {
    return this.outcome === "released";
  }
}
