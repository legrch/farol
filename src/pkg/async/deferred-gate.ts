export class DeferredGate {
  private released = false;
  private readonly promise: Promise<void>;
  private releasePromise: (() => void) | null = null;

  constructor(readonly name: string) {
    this.promise = new Promise<void>((resolve) => {
      this.releasePromise = resolve;
    });
  }

  wait(): Promise<void> {
    return this.promise;
  }

  release(): boolean {
    if (this.released) return false;
    this.released = true;
    this.releasePromise?.();
    this.releasePromise = null;
    return true;
  }

  isReleased(): boolean {
    return this.released;
  }
}
