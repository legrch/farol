type OpeningSession<Value> = Readonly<{
  key: string;
  promise: Promise<Value>;
}>;

export class ProductAgentSessionReservation<Value> {
  private opening: OpeningSession<Value> | null = null;

  open(key: string, factory: () => Promise<Value>): Promise<Value> {
    if (this.opening) {
      return this.opening.key === key
        ? this.opening.promise
        : Promise.reject(new Error("PRODUCT_AGENT_SESSION_BUSY"));
    }

    const operation = Promise.resolve().then(factory);
    let tracked!: Promise<Value>;
    tracked = operation.then(
      (value) => {
        if (this.opening?.promise === tracked) this.opening = null;
        return value;
      },
      (error: unknown) => {
        if (this.opening?.promise === tracked) this.opening = null;
        throw error;
      },
    );
    this.opening = { key, promise: tracked };
    return tracked;
  }
}
