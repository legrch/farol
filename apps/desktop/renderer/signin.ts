import {
  ProductConfigurationCommandSchema,
  ProductConfigurationResultSchema,
  type ProductConfigurationCommand,
} from "../../../src/pkg/product-settings/contract";
import { commandAllowed } from "../../../src/ui/renderer/command-eligibility";
import { staleAutomaticSignInCheck } from "./configure";
import type {
  Destination,
  Intent,
  PreloadApi,
  WindowSnapshot,
} from "../../../src/ui/renderer/contract";

/*
 * The window's observation of ChatGPT sign-in. Two timers live here: the
 * 2.5 s settle timer that bounds one host read, and the saved-sign-in read
 * window that spaces the bounded passive re-reads of a loaded document. Both
 * are cleared on retirement and on disposal. The observation never upgrades
 * a status from unknown on its own: only an exact, in-time, same-build,
 * same-observation reply settles to anything else.
 *
 * The controller keeps every other piece of window state (navigation, the
 * automatic setup completion latches, the shared revision counters) and
 * reaches it only through the ports below.
 */

type TimerHandle = ReturnType<typeof setTimeout>;

/** What the sign-in observation reads and writes; the controller owns each. */
export type SignInPorts = Readonly<{
  /** The one bridge call an observation makes. */
  api: Pick<PreloadApi, "configure">;
  /** The live window snapshot, read again at every decision. */
  snapshot: () => WindowSnapshot;
  /** The controller's patch: publishes and applies its own retirement rules. */
  patch: (value: Partial<WindowSnapshot>) => void;
  /** The controller's `configure`, used for the one automatic verification. */
  configure: (
    command: ProductConfigurationCommand,
    intention: string,
  ) => Promise<Intent>;
  /** Timers and the monotonic clock the 2.5 s deadline is measured against. */
  timers: Readonly<{
    set: (run: () => void, ms: number) => TimerHandle;
    clear: (handle: TimerHandle) => void;
    now: () => number;
  }>;
  /**
   * The shared navigation revision. It is a getter on the controller's single
   * counter, never a copy, so a return attempt is fenced by every navigation.
   */
  navigationRevision: () => number;
  /** The controller's lifecycle flags, read again at every decision. */
  lifecycle: Readonly<{ disposed: () => boolean; booting: () => boolean }>;
  /** Setup effects the controller owns and the observation only triggers. */
  effects: Readonly<{ returnToSetup: () => void; completeSetup: () => void }>;
}>;

export type SignIn = Readonly<{
  /** Whether the window is on the setup sign-in step. */
  onEntry: () => boolean;
  /** Whether sign-in is still observed for this window's setup. */
  observationEntry: () => boolean;
  /** Start one bounded host read, unless one is pending or not eligible. */
  observe: () => void;
  /** Drop the pending read's timer and fence its late reply. */
  retire: () => void;
  /** Retire the pending read and clear the published observation. */
  invalidate: () => void;
  /** Re-read when facts a loaded browser waited on have arrived. */
  reconcile: () => void;
  /** Forget the bounded passive reads of the previous document. */
  resetReads: () => void;
  /** Arm the next bounded passive read of a loaded document. */
  scheduleReads: () => void;
  /** After navigation, observe again when entering or revisiting sign-in. */
  reobserveAfterNavigation: (wasSignIn: boolean) => void;
  /** Return to setup once the awaited sign-in is confirmed and verified. */
  returnAfterConfirmed: () => void;
  /** Request the one verification of a newly authenticated document. */
  confirm: () => void;
  /** An owner sign-in attempt began: forget the previous document's proof. */
  startAttempt: () => void;
  /** Remember the sign-in return a started attempt awaits, and read for it. */
  recordReturnAttempt: (destination: Destination, intention: string) => void;
  /** The owner returned to setup explicitly; consume the continuation. */
  clearReturnAttempt: () => void;
  /** Drop the continuation when a patch changes what it was bound to. */
  supersedeReturnAttempt: (value: Partial<WindowSnapshot>) => void;
  /** Window teardown: no timer may outlive the controller. */
  dispose: () => void;
}>;

type ReturnAttempt = Readonly<{
  destination: Destination;
  navigationRevision: number;
  buildId: string | null;
  intention: string;
}>;

/** The 2.5 s host bound, and the delays between bounded passive reads. */
const settleDelayMs = 2_500;
const readDelaysMs = [500, 1_500, 3_000, 5_000, 8_000, 10_000];

export function createSignIn(ports: SignInPorts): SignIn {
  let counter = 0;
  const automaticChecks = new Set<string>();
  let automaticRequested = false;
  let returnAttempt: ReturnAttempt | null = null;
  let settleTimer: TimerHandle | null = null;
  let readTimer: TimerHandle | null = null;
  let readAttempts = 0;

  function onEntry(): boolean {
    const state = ports.snapshot();
    return (
      state.destination.area === "setup" &&
      state.destination.setupStep === "signin"
    );
  }

  function setupSettled(): boolean {
    const state = ports.snapshot();
    return (
      state.configuration?.status === "ready" &&
      state.configuration.settings.setup.journey.dismissed
    );
  }

  function observationEntry(): boolean {
    const state = ports.snapshot();
    // Finished setup does not keep reading or renewing ChatGPT sign-in.
    if (setupSettled()) return false;
    return (
      onEntry() ||
      (automaticRequested &&
        state.destination.area === "chatgpt" &&
        state.setupSignInReturn !== null) ||
      (state.configuration?.status === "ready" &&
        state.configuration.settings.setup.chatgpt.verified !== null)
    );
  }

  function retire(): void {
    counter++;
    if (settleTimer !== null) ports.timers.clear(settleTimer);
    settleTimer = null;
  }

  function invalidate(): void {
    retire();
    ports.patch({ signInObservation: null });
  }

  function observe(): void {
    const current = ports.snapshot();
    if (
      ports.lifecycle.disposed() ||
      ports.lifecycle.booting() ||
      !observationEntry() ||
      current.status !== "current" ||
      current.runtime !== "ready" ||
      current.update.phase === "applying" ||
      current.configuration?.status !== "ready" ||
      !current.buildId ||
      current.signInObservation?.pending === true
    )
      return;
    const command = ProductConfigurationCommandSchema.safeParse({
      kind: "chatgpt.observe-sign-in",
      observationId: crypto.randomUUID(),
      buildId: current.buildId,
    });
    if (!command.success || command.data.kind !== "chatgpt.observe-sign-in")
      return;
    const request = command.data;
    const startedAt = ports.timers.now();
    const deadlineAt = startedAt + settleDelayMs;
    if (!Number.isFinite(startedAt) || !Number.isFinite(deadlineAt)) return;
    const mine = ++counter;
    const pending = {
      observationId: request.observationId,
      buildId: request.buildId,
      counter: mine,
      pending: true,
      state: "unknown" as const,
      binding: null,
    };
    // Publish the latch before transport; subscriptions/remounts cannot submit it.
    ports.patch({ signInObservation: pending });
    const active = () => {
      const state = ports.snapshot();
      return (
        !ports.lifecycle.disposed() &&
        counter === mine &&
        state.signInObservation === pending &&
        observationEntry() &&
        state.status === "current" &&
        state.runtime === "ready" &&
        state.update.phase !== "applying" &&
        state.configuration?.status === "ready" &&
        state.buildId === request.buildId
      );
    };
    const settle = (raw?: unknown) => {
      if (!active()) return;
      if (settleTimer !== null) ports.timers.clear(settleTimer);
      settleTimer = null;
      const parsed = ProductConfigurationResultSchema.safeParse(raw);
      const evidence =
        parsed.success && parsed.data.ok ? parsed.data.evidence : null;
      const now = ports.timers.now();
      const exact =
        Number.isFinite(now) &&
        now >= startedAt &&
        now < deadlineAt &&
        evidence?.kind === "chatgpt.sign-in-status" &&
        evidence.observationId === request.observationId &&
        evidence.buildId === request.buildId;
      // Never adopt the response's settings snapshot, effect intent or evidence cache.
      ports.patch({
        signInObservation: {
          ...pending,
          pending: false,
          state: exact ? evidence.state : "unknown",
          binding: exact ? evidence.binding : null,
        },
      });
      if (exact && evidence.state === "authenticated") {
        confirm();
        returnAfterConfirmed();
        ports.effects.completeSetup();
      }
      scheduleReads();
    };
    // Host observation is bounded to two seconds. A lost IPC reply also expires;
    // its later delivery cannot revive or settle any original effect UNKNOWN.
    if (!active()) return;
    settleTimer = ports.timers.set(() => settle(), settleDelayMs);
    void (async () => {
      try {
        settle(await ports.api.configure(request));
      } catch {
        settle();
      }
    })();
  }

  // A loaded browser can precede current backend/configuration readiness.
  // Reconcile when those facts arrive too; no navigation or Send is needed.
  function reconcile(): void {
    const state = ports.snapshot();
    if (state.route === "loaded" && state.signInObservation === null) observe();
    // Configuration refresh can publish the final receipt after the sign-in
    // observation settled. Reevaluate the same one-shot completion predicate.
    ports.effects.completeSetup();
    returnAfterConfirmed();
    scheduleReads();
  }

  function resetReads(): void {
    if (readTimer !== null) ports.timers.clear(readTimer);
    readTimer = null;
    readAttempts = 0;
  }

  // Any loaded document can still be hydrating, including within the same
  // build. Bound passive reads per document; never retry a Settings write or
  // an external Send. A signed-out first login keeps its bounded read window.
  function scheduleReads(): void {
    const state = ports.snapshot();
    if (setupSettled()) return;
    const saved =
      state.configuration?.status === "ready"
        ? state.configuration.settings.setup.chatgpt.verified !== null ||
          (state.configuration.settings.setup.journey.dismissed &&
            state.configuration.settings.setup.chatgpt.configured)
        : null;
    if (
      ports.lifecycle.disposed() ||
      ports.lifecycle.booting() ||
      readTimer !== null ||
      readAttempts >= 6 ||
      state.route !== "loaded" ||
      state.status !== "current" ||
      state.runtime !== "ready" ||
      (!saved && !currentAttempt()) ||
      state.signInObservation?.pending === true ||
      state.signInObservation?.state === "authenticated" ||
      (state.signInObservation?.state === "signed_out" && !currentAttempt()) ||
      state.update.phase === "applying"
    )
      return;
    const delay = readDelaysMs[readAttempts];
    if (delay === undefined) return;
    // Restored provider sessions can hydrate slowly on a cold launch. These
    // bounded page reads never resend a login, verification or settings write.
    readTimer = ports.timers.set(() => {
      readTimer = null;
      const now = ports.snapshot();
      const verified =
        now.configuration?.status === "ready"
          ? now.configuration.settings.setup.chatgpt.verified !== null ||
            (now.configuration.settings.setup.journey.dismissed &&
              now.configuration.settings.setup.chatgpt.configured)
          : null;
      if (
        ports.lifecycle.disposed() ||
        (!verified && !currentAttempt()) ||
        now.signInObservation?.pending === true ||
        now.signInObservation?.state === "authenticated" ||
        (now.signInObservation?.state === "signed_out" && !currentAttempt()) ||
        now.status !== "current" ||
        now.runtime !== "ready" ||
        now.update.phase === "applying" ||
        now.route !== "loaded"
      )
        return;
      readAttempts++;
      observe();
    }, delay);
  }

  function currentAttempt(): boolean {
    const attempt = returnAttempt;
    const state = ports.snapshot();
    return (
      !!attempt &&
      ports.navigationRevision() === attempt.navigationRevision &&
      state.buildId === attempt.buildId &&
      state.destination.area === "chatgpt" &&
      state.destination.taskId === "" &&
      state.setupSignInReturn === attempt.destination &&
      state.intents[attempt.intention]?.state !== "unknown" &&
      state.intents[attempt.intention]?.state !== "refused"
    );
  }

  function returnAfterConfirmed(): void {
    const attempt = returnAttempt;
    const state = ports.snapshot();
    const observation = state.signInObservation;
    const check = state.setupSignInCheck;
    if (
      !attempt ||
      !currentAttempt() ||
      ports.lifecycle.disposed() ||
      state.status !== "current" ||
      state.runtime !== "ready" ||
      state.update.phase === "applying" ||
      state.route !== "loaded" ||
      state.intents[attempt.intention]?.state !== "applied" ||
      state.intents["settings:chatgpt.verify:"]?.state !== "applied" ||
      !commandAllowed(state, "chatgpt.sign-in-return") ||
      !observation ||
      observation.pending ||
      observation.state !== "authenticated" ||
      !observation.binding ||
      !check ||
      check.buildId !== observation.buildId ||
      check.binding.documentGeneration !==
        observation.binding.documentGeneration ||
      check.binding.sequence > observation.binding.sequence
    )
      return;
    returnAttempt = null;
    ports.effects.returnToSetup();
  }

  function confirm(): void {
    const state = ports.snapshot();
    const observation = state.signInObservation;
    const check = state.setupSignInCheck;
    if (setupSettled()) return;
    const saved =
      state.configuration?.status === "ready"
        ? state.configuration.settings.setup.chatgpt.verified
        : null;
    // Confirm only while the owner is still in first-run setup.
    if (!automaticRequested && !saved) return;
    if (
      !observationEntry() ||
      state.route !== "loaded" ||
      !observation ||
      observation.pending ||
      observation.state !== "authenticated" ||
      !observation.binding ||
      !commandAllowed(state, "chatgpt.verify")
    )
      return;
    if (
      check?.buildId === state.buildId &&
      check.binding.documentGeneration ===
        observation.binding.documentGeneration &&
      check.binding.sequence <= observation.binding.sequence
    )
      return;
    const key = `${observation.buildId}:${observation.binding.documentGeneration}`;
    if (automaticChecks.has(key)) return;
    // One existing verifier per authenticated document. A lost write/response
    // retains its original fence; neither refresh nor navigation retries it.
    automaticChecks.add(key);
    void ports.configure(
      { kind: "chatgpt.verify" },
      "settings:chatgpt.verify:",
    );
  }

  return {
    onEntry,
    observationEntry,
    observe,
    retire,
    invalidate,
    reconcile,
    resetReads,
    scheduleReads,
    returnAfterConfirmed,
    confirm,
    reobserveAfterNavigation(wasSignIn) {
      const state = ports.snapshot();
      if (
        observationEntry() &&
        (state.signInObservation === null ||
          (!wasSignIn &&
            onEntry() &&
            state.signInObservation.state !== "authenticated")) &&
        (onEntry() || state.route === "loaded")
      ) {
        invalidate();
        observe();
      }
    },
    startAttempt() {
      automaticRequested = true;
      const stale = staleAutomaticSignInCheck(ports.snapshot());
      if (stale !== null) automaticChecks.delete(stale);
      // A new owner sign-in attempt cannot inherit the previous document's
      // authenticated observation or its Settings verification correlation.
      ports.patch({ setupSignInCheck: null });
      invalidate();
    },
    recordReturnAttempt(destination, intention) {
      returnAttempt = {
        destination,
        navigationRevision: ports.navigationRevision(),
        buildId: ports.snapshot().buildId,
        intention,
      };
      resetReads();
      scheduleReads();
    },
    clearReturnAttempt() {
      returnAttempt = null;
    },
    supersedeReturnAttempt(value) {
      const attempt = returnAttempt;
      if (
        attempt &&
        (ports.navigationRevision() !== attempt.navigationRevision ||
          (value.buildId !== undefined && value.buildId !== attempt.buildId) ||
          value.update?.phase === "applying")
      )
        returnAttempt = null;
    },
    dispose() {
      retire();
      if (readTimer !== null) ports.timers.clear(readTimer);
      readTimer = null;
    },
  };
}
