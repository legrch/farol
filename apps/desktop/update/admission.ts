// The installed-update admission fence. The host acquires an admission before
// any helper dispatch and holds it until the attempt settles. Nothing here
// retries: a throwing acquire or release, or an unreadable recheck, proves no
// idle desktop, so each of them fails closed.

export type Admission =
  | Readonly<{ ok: false; code: string }>
  | Readonly<{
      ok: true;
      release(): Promise<void>;
      recheck?(): Promise<
        Readonly<{ ok: true }> | Readonly<{ ok: false; code: string }>
      >;
    }>;

export type HeldAdmission = Extract<Admission, { ok: true }>;

export type Handoff =
  | Readonly<{ status: "accepted" }>
  | Readonly<{ status: "blocked"; code: string }>
  | Readonly<{ status: "unknown"; code: string }>;

export async function recheckAdmission(
  admission: HeldAdmission,
): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; code: string }>> {
  try {
    return (await admission.recheck?.()) ?? { ok: true };
  } catch {
    // An observation failure proves no idle state. No helper has been dispatched
    // at these boundaries; preparation cleanup still owns its existing proof.
    return { ok: false, code: "UPDATE_BROWSER_STATE_UNKNOWN" };
  }
}

export type AdmissionPorts<Quit, Confirmation> = Readonly<{
  // The host's acquire; it receives the desktop-settled probe and only the
  // optional arguments the caller actually supplied.
  acquire(
    settled: () => Promise<boolean>,
    quit?: Quit,
    confirmation?: Confirmation,
  ): Promise<Admission>;
  // Whether the desktop's outstanding work has drained.
  drained(beforeEffect: () => void): Promise<boolean>;
}>;

export function createAdmissionGate<Quit, Confirmation>(
  ports: AdmissionPorts<Quit, Confirmation>,
) {
  // The admission closure owns the kernel lease. Keep it reachable after the
  // request returns, including unknown outcomes and the normal Quit drain.
  let held: HeldAdmission | null = null;
  let releaseUnconfirmed = false;
  return {
    held: (): boolean => held !== null,
    hold(admission: HeldAdmission | null): void {
      held = admission;
    },
    releaseUnconfirmed: (): boolean => releaseUnconfirmed,
    async acquire(
      beforeEffect: () => void = () => undefined,
      quit?: Quit,
      confirmation?: Confirmation,
    ): Promise<Admission> {
      if (releaseUnconfirmed)
        return { ok: false, code: "UPDATE_BROWSER_RELEASE_UNCONFIRMED" };
      try {
        beforeEffect();
        const settled = () => ports.drained(beforeEffect);
        const admission = confirmation
          ? await ports.acquire(settled, quit, confirmation)
          : quit
            ? await ports.acquire(settled, quit)
            : await ports.acquire(settled);
        if (
          !admission.ok &&
          admission.code === "UPDATE_BROWSER_RELEASE_UNCONFIRMED"
        )
          releaseUnconfirmed = true;
        return admission;
      } catch {
        // Admission precedes every dispatch. An exception here cannot prove a
        // released desktop, but it is not an unknown helper launch.
        releaseUnconfirmed = true;
        return { ok: false, code: "UPDATE_BROWSER_RELEASE_UNCONFIRMED" };
      }
    },
    async settle(
      admission: HeldAdmission,
      keep: () => boolean,
      attempt: () => Promise<Handoff>,
      unexpectedCode: () => string,
    ): Promise<Handoff> {
      let outcome: Handoff;
      try {
        outcome = await attempt();
      } catch {
        // Cleanup's own durable error must still settle the original admission.
        outcome = { status: "unknown", code: unexpectedCode() };
      }
      if (keep()) {
        held = admission;
        return outcome;
      }
      try {
        await admission.release();
      } catch {
        held = admission;
        releaseUnconfirmed = true;
        // A throwing finally must not replace a classified unknown copy/cleanup
        // outcome, or invent helper uncertainty on a confirmed blocked attempt.
        if (outcome.status !== "unknown")
          return {
            status: "blocked",
            code: "UPDATE_BROWSER_RELEASE_UNCONFIRMED",
          };
      }
      return outcome;
    },
  };
}
