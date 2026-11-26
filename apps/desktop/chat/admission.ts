import { z } from "zod";
import {
  ChatGptUpdateIdleSchema,
  chatGptUpdateIdleProbe,
  type BrowserUpdateAdmission,
  type BrowserUpdateCheck,
} from "../../../src/apps/desktop/chatgpt-update-idle";
import { ACTIVITY_PROBE_DEADLINE_MS } from "./activity";
import { isChatGptPage } from "./policy";

// Installed-update admission for the ChatGPT route. An update may replace the
// app only while no browser work can be lost, so admission is fail-closed: any
// state it cannot prove keeps refusing, with a fixed content-free diagnostic.
// Two paths exist. `close` takes the owner's explicit consent and closes the
// browser surfaces. `idle` keeps the page open, proves it idle with a public
// DOM classification, then holds the renderer paused under a debugger session
// it owns while the update runs. The route lends everything it owns as ports;
// the reservation flag itself stays route state, because the route's other
// entry points refuse to run while it is set.

/** Fixed classifications only: never attach URLs, DOM, probe replies or errors. */
export type ChatGptUpdateAdmissionDiagnostic =
  | Readonly<{
      stage: "admission";
      reason:
        "busy" | "reservation_lost" | "guard_invalid" | "deadline_expired";
    }>
  | Readonly<{
      stage: "surface";
      reason: "unavailable" | "not_embedded" | "destroyed" | "changed";
    }>
  | Readonly<{
      stage: "document";
      reason: "not_loaded" | "changed" | "url_changed" | "url_unrecognized";
    }>
  | Readonly<{
      stage: "probe" | "paused_probe";
      reason:
        "parse_failed" | "unknown" | "failed" | "timeout" | "running" | "draft";
    }>
  | Readonly<{
      stage: "debugger";
      reason:
        | "already_attached"
        | "devtools_open"
        | "attach_failed"
        | "enable_failed"
        | "timeout";
    }>
  | Readonly<{ stage: "pause"; reason: "failed" | "timeout" | "unconfirmed" }>
  | Readonly<{ stage: "resume"; reason: "failed" | "timeout" }>
  | Readonly<{ stage: "release"; reason: "detach_failed" }>;

type DiagnosticBrowserUpdateCheck =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      code: Extract<BrowserUpdateCheck, { ok: false }>["code"];
      diagnostic: ChatGptUpdateAdmissionDiagnostic;
    }>;

/** Host-only original Quit budget; never passed to a page or inspector. */
export type ChatGptUpdateIdleEffectGuard = Readonly<{
  deadlineAt: number;
  canStartEffect(): boolean;
}>;

// How long a closing page may take to confirm its destruction.
export const UPDATE_CLOSE_CONFIRMATION_MS = 2_000;

type InputEvent = { preventDefault(): void };

// The slice of Electron's inspector session admission drives.
export type UpdateDebugger = Readonly<{
  isAttached(): boolean;
  attach(protocolVersion: string): void;
  detach(): void;
  sendCommand(method: string, params?: object): Promise<unknown>;
  on(
    event: "message",
    listener: (event: unknown, method: string) => void,
  ): unknown;
  on(event: "detach", listener: () => void): unknown;
  removeListener(
    event: "message",
    listener: (event: unknown, method: string) => void,
  ): unknown;
  removeListener(event: "detach", listener: () => void): unknown;
}>;

// The slice of a web contents admission reads and fences.
export type UpdateContents = Readonly<{
  debugger: UpdateDebugger;
  isDestroyed(): boolean;
  getURL(): string;
  isDevToolsOpened(): boolean;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  on(
    event: "before-input-event" | "before-mouse-event",
    listener: (event: InputEvent) => void,
  ): unknown;
  removeListener(
    event: "before-input-event" | "before-mouse-event",
    listener: (event: InputEvent) => void,
  ): unknown;
  once(event: "destroyed", listener: () => void): unknown;
  removeListener(event: "destroyed", listener: () => void): unknown;
}>;

export type UpdateSurface<Contents extends UpdateContents = UpdateContents> =
  Readonly<{
    kind: "window" | "embedded";
    webContents: Contents;
    isDestroyed(): boolean;
  }>;

// What the route did to close its browser surfaces for an update. `contents`
// are the pages whose destruction admission must observe; `settled` says
// whether every surface is now gone; `forget` drops the route's references to
// them once that is confirmed.
export type UpdateClosing = Readonly<{
  contents: readonly UpdateContents[];
  settled(): boolean;
  forget(): void;
}>;

export type UpdateAdmissionClock = Readonly<{
  now(): number;
  // Arms one timer and returns what cancels it.
  after(callback: () => void, ms: number): () => void;
}>;

// The route's state, read when a check runs, never captured. `setReserved`
// is the only write admission makes to route state outside `beginClose`.
export type UpdateAdmissionRoute<Surface extends UpdateSurface> = Readonly<{
  reserved(): boolean;
  setReserved(reserved: boolean): void;
  opening(): boolean;
  taskInFlight(): boolean;
  signInMode(): boolean;
  hasLivePopup(): boolean;
  hasOpenSurface(): boolean;
  surface(): Surface | null;
  loaded(): boolean;
  documentGeneration(): number;
  // Stops the activity watch, remembers the conversation, destroys every
  // surface with ordinary close navigation suppressed, and says what to wait
  // for. `endClose` always follows, whatever happened in between.
  beginClose(): UpdateClosing;
  endClose(): void;
}>;

export type UpdateAdmissionPorts<Surface extends UpdateSurface> = Readonly<{
  homeUrl: string;
  route: UpdateAdmissionRoute<Surface>;
  clock: UpdateAdmissionClock;
  // Best effort and content-free; it can never change admission.
  report: (diagnostic: ChatGptUpdateAdmissionDiagnostic) => void;
}>;

export type UpdateAdmission = Readonly<{
  close: () => Promise<BrowserUpdateAdmission>;
  idle: (
    guard?: ChatGptUpdateIdleEffectGuard,
  ) => Promise<BrowserUpdateAdmission>;
}>;

export function createUpdateAdmission<Surface extends UpdateSurface>(
  ports: UpdateAdmissionPorts<Surface>,
): UpdateAdmission {
  const { route, clock } = ports;

  /** Explicit update consent closes browser work instead of inferring DOM idle. */
  const close = async (): Promise<BrowserUpdateAdmission> => {
    // Programmatic tasks retain their own cancellation/journal owner. Browser
    // interruption consent does not invent a terminal result for those tasks.
    if (route.reserved() || route.opening() || route.taskInFlight())
      return { ok: false, code: "UPDATE_BROWSER_BUSY" };
    route.setReserved(true);
    try {
      const closing = route.beginClose();
      // WebContents.close may complete on a later native event-loop turn.
      // Observe the same close; never send it again after a lost result.
      await Promise.all(
        closing.contents.map(async (contents) => {
          if (contents.isDestroyed()) return;
          await new Promise<void>((resolve, reject) => {
            const closed = () => {
              cancel();
              resolve();
            };
            const cancel = clock.after(() => {
              contents.removeListener("destroyed", closed);
              reject(new Error("UPDATE_BROWSER_CLOSE_UNCONFIRMED"));
            }, UPDATE_CLOSE_CONFIRMATION_MS);
            contents.once("destroyed", closed);
          });
        }),
      );
      if (!closing.settled())
        throw new Error("UPDATE_BROWSER_CLOSE_UNCONFIRMED");
      closing.forget();
    } catch {
      // An uncertain native close holds the reservation, never retries destroy.
      return { ok: false, code: "UPDATE_BROWSER_RELEASE_UNCONFIRMED" };
    } finally {
      route.endClose();
    }
    let released = false;
    return {
      ok: true,
      recheck: async () =>
        released || !route.reserved() || route.hasOpenSurface()
          ? { ok: false, code: "UPDATE_BROWSER_STATE_UNKNOWN" }
          : { ok: true },
      release: async () => {
        if (released) return;
        released = true;
        route.setReserved(false);
      },
    };
  };

  const idle = async (
    guard?: ChatGptUpdateIdleEffectGuard,
  ): Promise<BrowserUpdateAdmission> => {
    const refuse = (
      code: Extract<BrowserUpdateCheck, { ok: false }>["code"],
      diagnostic: ChatGptUpdateAdmissionDiagnostic,
    ): Extract<DiagnosticBrowserUpdateCheck, { ok: false }> => ({
      ok: false,
      code,
      diagnostic,
    });
    const report = (
      check: Extract<DiagnosticBrowserUpdateCheck, { ok: false }>,
    ): Extract<BrowserUpdateCheck, { ok: false }> => {
      ports.report(check.diagnostic);
      return { ok: false, code: check.code };
    };
    const unknown = (
      diagnostic: ChatGptUpdateAdmissionDiagnostic,
    ): Extract<DiagnosticBrowserUpdateCheck, { ok: false }> =>
      refuse("UPDATE_BROWSER_STATE_UNKNOWN", diagnostic);
    // Capture the original budget once. Mutable caller state cannot extend it.
    let deadlineAt: number | undefined;
    let canStartEffect: (() => boolean) | undefined;
    if (guard !== undefined) {
      try {
        if (guard === null || typeof guard !== "object")
          return report(
            unknown({ stage: "admission", reason: "guard_invalid" }),
          );
        const originalDeadline = guard.deadlineAt;
        const originalAdmission = guard.canStartEffect;
        if (
          typeof originalDeadline !== "number" ||
          !Number.isFinite(originalDeadline) ||
          typeof originalAdmission !== "function"
        )
          return report(
            unknown({ stage: "admission", reason: "guard_invalid" }),
          );
        deadlineAt = originalDeadline;
        canStartEffect = originalAdmission.bind(guard);
      } catch {
        return report(unknown({ stage: "admission", reason: "guard_invalid" }));
      }
    }
    const effectGuard = (): ChatGptUpdateAdmissionDiagnostic | null => {
      if (deadlineAt === undefined) return null;
      if (clock.now() >= deadlineAt)
        return { stage: "admission", reason: "deadline_expired" };
      try {
        if (canStartEffect?.() !== true)
          return { stage: "admission", reason: "reservation_lost" };
      } catch {
        return { stage: "admission", reason: "guard_invalid" };
      }
      // The host callback itself may consume the remaining budget.
      return clock.now() < deadlineAt
        ? null
        : { stage: "admission", reason: "deadline_expired" };
    };
    const initialGuard = effectGuard();
    if (initialGuard) return report(unknown(initialGuard));
    if (
      route.reserved() ||
      route.opening() ||
      route.taskInFlight() ||
      route.signInMode() ||
      route.hasLivePopup()
    )
      return report(
        refuse("UPDATE_BROWSER_BUSY", { stage: "admission", reason: "busy" }),
      );
    if (!route.hasOpenSurface()) {
      const invalid = effectGuard();
      if (invalid) return report(unknown(invalid));
      route.setReserved(true);
      let released = false;
      return {
        ok: true,
        recheck: async () => {
          const invalid = effectGuard();
          if (invalid) return report(unknown(invalid));
          if (released || !route.reserved() || route.hasOpenSurface())
            return report(
              unknown({ stage: "admission", reason: "reservation_lost" }),
            );
          const changed = effectGuard();
          return changed ? report(unknown(changed)) : { ok: true };
        },
        release: async () => {
          if (released) return;
          released = true;
          route.setReserved(false);
        },
      };
    }
    const surface = route.surface();
    if (!surface)
      return report(unknown({ stage: "surface", reason: "unavailable" }));
    if (surface.kind !== "embedded")
      return report(unknown({ stage: "surface", reason: "not_embedded" }));
    if (surface.isDestroyed())
      return report(unknown({ stage: "surface", reason: "destroyed" }));
    if (!route.loaded())
      return report(unknown({ stage: "document", reason: "not_loaded" }));
    const contents = surface.webContents;
    const generation = route.documentGeneration();
    const url = contents.getURL();
    if (!isChatGptPage(url, ports.homeUrl))
      return report(unknown({ stage: "document", reason: "url_unrecognized" }));
    route.setReserved(true);
    const blockInput = (event: InputEvent): void => event.preventDefault();
    contents.on("before-input-event", blockInput);
    contents.on("before-mouse-event", blockInput);
    const debuggerClient = contents.debugger;
    let attached = false;
    let paused = false;
    let pauseRequired = false;
    let confirmPause: (() => void) | undefined;
    let confirmResume: (() => void) | undefined;
    const message = (_event: unknown, method: string): void => {
      if (method === "Debugger.paused") {
        paused = true;
        confirmPause?.();
      } else if (method === "Debugger.resumed") {
        paused = false;
        confirmResume?.();
      }
    };
    const detached = (): void => {
      attached = false;
      paused = false;
    };
    let released = false;
    let effectsStopped = false;
    const effectError = new Error("UPDATE_BROWSER_STATE_UNKNOWN");
    let effectDiagnostic: ChatGptUpdateAdmissionDiagnostic | null = null;
    const assertEffectCurrent = (): void => {
      const invalid = current();
      if (invalid) {
        effectsStopped = true;
        effectDiagnostic = invalid;
        throw effectError;
      }
    };
    // Thunks fence actual invocation, including continuations after a lost reply.
    // Cleanup keeps its own existing timeout, independent of the Quit budget.
    const deadlineError = new Error("UPDATE_BROWSER_STATE_UNKNOWN");
    const bounded = async <T>(
      operation: () => Promise<T>,
      cleanup = false,
    ): Promise<T> => {
      if (!cleanup) assertEffectCurrent();
      const remaining =
        cleanup || deadlineAt === undefined
          ? ACTIVITY_PROBE_DEADLINE_MS
          : Math.min(ACTIVITY_PROBE_DEADLINE_MS, deadlineAt - clock.now());
      let cancelTimer: (() => void) | undefined;
      try {
        const timeout = new Promise<never>((_resolve, reject) => {
          cancelTimer = clock.after(() => {
            if (!cleanup) effectsStopped = true;
            reject(deadlineError);
          }, remaining);
        });
        if (!cleanup) assertEffectCurrent();
        const result = await Promise.race([operation(), timeout]);
        if (!cleanup) assertEffectCurrent();
        return result;
      } catch (error) {
        if (!cleanup) effectsStopped = true;
        throw error;
      } finally {
        if (cancelTimer !== undefined) cancelTimer();
      }
    };
    let releasePromise: Promise<void> | null = null;
    const release = (): Promise<void> => {
      if (releasePromise) return releasePromise;
      released = true;
      releasePromise = (async () => {
        // A failed/unconfirmed resume retains admission. Never repeat that
        // native command or expose the page as usable on uncertain state.
        if (!contents.isDestroyed() && attached) {
          if (paused) {
            const resumed = new Promise<void>((resolve) => {
              confirmResume = resolve;
            });
            try {
              await bounded(
                () =>
                  Promise.all([
                    debuggerClient.sendCommand("Debugger.resume"),
                    resumed,
                  ]),
                true,
              );
            } catch (error) {
              ports.report({
                stage: "resume",
                reason: error === deadlineError ? "timeout" : "failed",
              });
              throw new Error("UPDATE_BROWSER_RELEASE_UNCONFIRMED");
            }
          }
          if (attached) {
            try {
              debuggerClient.detach();
            } catch {
              ports.report({
                stage: "release",
                reason: "detach_failed",
              });
              throw new Error("UPDATE_BROWSER_RELEASE_UNCONFIRMED");
            }
            attached = false;
            paused = false;
          }
        }
        debuggerClient.removeListener("message", message);
        debuggerClient.removeListener("detach", detached);
        contents.removeListener("before-input-event", blockInput);
        contents.removeListener("before-mouse-event", blockInput);
        route.setReserved(false);
      })();
      return releasePromise;
    };
    const current = (): ChatGptUpdateAdmissionDiagnostic | null => {
      if (effectsStopped)
        return { stage: "admission", reason: "reservation_lost" };
      const invalidGuard = effectGuard();
      if (invalidGuard) return invalidGuard;
      if (released || !route.reserved())
        return { stage: "admission", reason: "reservation_lost" };
      if (route.surface() !== surface)
        return { stage: "surface", reason: "changed" };
      if (surface.isDestroyed() || contents.isDestroyed())
        return { stage: "surface", reason: "destroyed" };
      if (!route.loaded()) return { stage: "document", reason: "not_loaded" };
      if (route.documentGeneration() !== generation)
        return { stage: "document", reason: "changed" };
      if (contents.getURL() !== url)
        return { stage: "document", reason: "url_changed" };
      if (route.taskInFlight() || route.opening() || route.signInMode())
        return { stage: "admission", reason: "busy" };
      if (pauseRequired && !(attached && paused && debuggerClient.isAttached()))
        return { stage: "pause", reason: "unconfirmed" };
      if (route.hasLivePopup()) return { stage: "admission", reason: "busy" };
      return deadlineAt !== undefined && clock.now() >= deadlineAt
        ? { stage: "admission", reason: "deadline_expired" }
        : null;
    };
    const recheck = async (): Promise<DiagnosticBrowserUpdateCheck> => {
      const invalid = current();
      if (invalid) return unknown(invalid);
      const stage = pauseRequired ? "paused_probe" : "probe";
      try {
        let raw: unknown;
        if (pauseRequired) {
          // Inspector evaluation remains available while ordinary page scripts
          // are paused. Only this content-free DOM classification is evaluated.
          const reply: unknown = await bounded(() =>
            debuggerClient.sendCommand("Runtime.evaluate", {
              expression: chatGptUpdateIdleProbe,
              returnByValue: true,
            }),
          );
          const evaluated = z
            .object({
              result: z.object({
                type: z.literal("object"),
                value: ChatGptUpdateIdleSchema,
              }),
              exceptionDetails: z.never().optional(),
            })
            .safeParse(reply);
          if (!evaluated.success)
            return unknown({ stage, reason: "parse_failed" });
          raw = evaluated.data.result.value;
        } else {
          raw = await bounded(() =>
            contents.executeJavaScript(chatGptUpdateIdleProbe, true),
          );
        }
        const parsed = ChatGptUpdateIdleSchema.safeParse(raw);
        const changed = current();
        if (changed) return unknown(changed);
        if (!parsed.success) return unknown({ stage, reason: "parse_failed" });
        if (parsed.data.state === "unknown")
          return unknown({ stage, reason: "unknown" });
        if (parsed.data.state === "running")
          return refuse("UPDATE_BROWSER_BUSY", { stage, reason: "running" });
        if (parsed.data.state === "draft")
          return refuse("UPDATE_BROWSER_DRAFT", { stage, reason: "draft" });
        return { ok: true };
      } catch (error) {
        if (error === effectError && effectDiagnostic)
          return unknown(effectDiagnostic);
        return unknown({
          stage,
          reason: error === deadlineError ? "timeout" : "failed",
        });
      }
    };
    const result = await recheck();
    if (!result.ok) {
      await release();
      return report(result);
    }
    let pauseDiagnostic: ChatGptUpdateAdmissionDiagnostic = {
      stage: "debugger",
      reason: "attach_failed",
    };
    try {
      // Input fences do not stop a page timer from invoking its own handlers.
      // Pause only after initial idle proof, then inspect again under the held
      // pause. Never take over an existing debugger or use a lifecycle fallback.
      const alreadyAttached = debuggerClient.isAttached();
      if (alreadyAttached || contents.isDevToolsOpened()) {
        await release();
        return report(
          unknown({
            stage: "debugger",
            reason: alreadyAttached ? "already_attached" : "devtools_open",
          }),
        );
      }
      debuggerClient.on("message", message);
      debuggerClient.on("detach", detached);
      assertEffectCurrent();
      debuggerClient.attach("1.3");
      attached = true;
      pauseDiagnostic = { stage: "debugger", reason: "enable_failed" };
      await bounded(() => debuggerClient.sendCommand("Debugger.enable"));
      assertEffectCurrent();
      pauseDiagnostic = { stage: "pause", reason: "failed" };
      const stopped = new Promise<void>((resolve) => {
        confirmPause = resolve;
      });
      await bounded(async () => {
        assertEffectCurrent();
        await debuggerClient.sendCommand("Debugger.pause");
        assertEffectCurrent();
        if (!paused) {
          // A quiet hidden document has no next statement to acknowledge pause.
          // This no-op supplies one without touching DOM, credentials or tasks.
          // Its reply may wait for resume; only the actual paused event admits.
          assertEffectCurrent();
          void debuggerClient
            .sendCommand("Runtime.evaluate", {
              expression: "void 0",
              returnByValue: true,
            })
            .catch(() => undefined);
        }
        await stopped;
        assertEffectCurrent();
      });
      pauseRequired = true;
    } catch (error) {
      // Close late continuations before cleanup, including failed detach.
      effectsStopped = true;
      if (error === effectError && effectDiagnostic)
        pauseDiagnostic = effectDiagnostic;
      if (error === deadlineError)
        pauseDiagnostic = {
          stage: pauseDiagnostic.stage === "pause" ? "pause" : "debugger",
          reason: "timeout",
        };
      // Detach only this owned session when pause acquisition was unconfirmed.
      // Closing the inspector session also cancels its pending pause request.
      if (attached) {
        try {
          debuggerClient.detach();
        } catch {
          ports.report({
            stage: "release",
            reason: "detach_failed",
          });
          return { ok: false, code: "UPDATE_BROWSER_RELEASE_UNCONFIRMED" };
        }
        // Native detach success is sufficient; its event may arrive later.
        attached = false;
        paused = false;
      }
      try {
        await release();
      } catch {
        return { ok: false, code: "UPDATE_BROWSER_RELEASE_UNCONFIRMED" };
      }
      return report(unknown(pauseDiagnostic));
    }
    const held = await recheck();
    const finalInvalid = current();
    if (!held.ok || finalInvalid) {
      try {
        await release();
      } catch {
        return { ok: false, code: "UPDATE_BROWSER_RELEASE_UNCONFIRMED" };
      }
      return report(held.ok ? unknown(finalInvalid!) : held);
    }
    return {
      ok: true,
      recheck: async () => {
        const check = await recheck();
        const invalid = current();
        if (check.ok && invalid) return report(unknown(invalid));
        return check.ok ? check : report(check);
      },
      release,
    };
  };

  return { close, idle };
}
