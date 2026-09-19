// One authority transition at a time. A command that changes what the Computer
// authorizes holds the reservation from its admission through its commit; a
// connector start and a native Agent admission take the same reservation for
// their own admission. When the two interleave, exactly one of them proceeds:
// neither can start carrying the authority the other is about to replace.
export type AuthorityTransitionKind =
  "authority-change" | "connector-start" | "agent-admission";

export type AuthorityTransitionHandle = Readonly<{
  kind: AuthorityTransitionKind;
  release: () => void;
}>;

export class AuthorityTransitionReservation {
  private holder: symbol | null = null;
  private holderKind: AuthorityTransitionKind | null = null;

  // Returns a handle when the reservation was free, or null when another
  // transition holds it. Never waits: the caller refuses with its own reason.
  tryReserve(kind: AuthorityTransitionKind): AuthorityTransitionHandle | null {
    if (this.holder !== null) return null;
    const token = Symbol(kind);
    this.holder = token;
    this.holderKind = kind;
    let released = false;
    return {
      kind,
      release: () => {
        if (released) return;
        released = true;
        if (this.holder === token) {
          this.holder = null;
          this.holderKind = null;
        }
      },
    };
  }

  // Holds the reservation for the whole of `work`, including every await in
  // it, and releases it however `work` ends.
  async withReservation<T>(
    kind: AuthorityTransitionKind,
    work: () => Promise<T>,
  ): Promise<
    | Readonly<{ admitted: true; value: T }>
    | Readonly<{ admitted: false; heldBy: AuthorityTransitionKind }>
  > {
    const handle = this.tryReserve(kind);
    if (!handle) {
      return { admitted: false, heldBy: this.holderKind ?? kind };
    }
    try {
      return { admitted: true, value: await work() };
    } finally {
      handle.release();
    }
  }

  current(): AuthorityTransitionKind | null {
    return this.holderKind;
  }
}
