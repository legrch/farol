import { InstalledUpdateViewSchema } from "../../../../src/modules/release/contract/installed-update";
import type {
  Intent,
  PreloadApi,
  RendererFacade,
  UpdateAction,
  WindowSnapshot,
} from "../../../../src/ui/renderer/contract";
import {
  automaticUpdateAvailable,
  confirmedRestartAllowed,
  updateCheckAllowed,
} from "../../../../src/ui/renderer/update-eligibility";
import {
  canSetInstallOnQuitPreference,
  installOnQuitPreferenceEligible,
} from "../snapshot";

/** What the update intents read and write; the controller owns every one. */
export type UpdateIntentPorts = Readonly<{
  /** The two bridge calls an update intent may make. */
  api: Pick<PreloadApi, "installedUpdate" | "settleUpdateDirect">;
  /** The live window snapshot, read again at every decision. */
  snapshot: () => WindowSnapshot;
  /** The controller's idempotent intention dispatcher. */
  dispatch: (
    key: string,
    payload: unknown,
    run: () => Promise<Intent>,
  ) => Promise<Intent>;
  /** Adopt an update observation; it also advances the shared revision. */
  adopt: (value: unknown) => void;
  /**
   * The shared update revision. It is a getter on the controller's single
   * counter, never a copy, so every adopted observation fences older replies.
   */
  revision: () => number;
}>;

export type UpdateIntents = Readonly<{
  update: (action: UpdateAction, noticeKey?: string) => Promise<Intent>;
  setAutomaticDownloads: (enabled: boolean) => Promise<Intent>;
  /** `facade` is the controller itself: the setter must be one it exposes. */
  setInstallOnQuitPreference: (
    enabled: boolean,
    facade: RendererFacade,
  ) => Promise<Intent>;
  /** Check when an Updates surface opens, unless an effect is retained. */
  checkOnOpen: () => Promise<Intent> | undefined;
  /** The Updates surface opened: check now, or once boot has finished. */
  requestCheckOnOpen: (booting: boolean) => void;
  /** Boot finished: run the check an earlier open requested, unless disposed. */
  settlePendingCheck: (disposed: boolean) => Promise<void>;
}>;

export function createUpdateIntents(ports: UpdateIntentPorts): UpdateIntents {
  let pendingCheck = false;

  function dispatchUpdate(
    key: string,
    payload: unknown,
    run: (operationId: string) => Promise<Intent>,
  ): Promise<Intent> {
    let operationId: string | undefined;
    const result = ports.dispatch(key, payload, () => {
      operationId = crypto.randomUUID();
      return run(operationId);
    });
    return result.then((intent) => {
      if (operationId && intent.state !== "pending")
        ports.api.settleUpdateDirect?.({
          operationId,
          outcome: intent.state,
        });
      return intent;
    });
  }

  function invokeTrackedUpdate(
    command: Parameters<PreloadApi["installedUpdate"]>[0],
    operationId: string,
  ): Promise<unknown> {
    return ports.api.settleUpdateDirect
      ? ports.api.installedUpdate(command, operationId)
      : ports.api.installedUpdate(command);
  }

  function update(action: UpdateAction, noticeKey?: string): Promise<Intent> {
    // A retained renderer may still name the retired command. Refuse locally
    // without replacing its current update intent or sending another effect.
    if (action === "rollback" || action === "recover")
      return Promise.resolve({
        id: "update",
        state: "refused",
        code: "UPDATE_FORWARD_ONLY",
      });
    if (action === "notice-seen") {
      const current = ports.snapshot().update;
      const notice = "notice" in current ? current.notice : undefined;
      const intents = ports.snapshot().intents;
      if (
        !notice ||
        notice.key !== noticeKey ||
        notice.seen ||
        notice.blockedBy ||
        intents.update?.state === "pending" ||
        intents.update?.state === "unknown" ||
        (current.phase === "failed" && current.code.includes("UNKNOWN")) ||
        (current.phase === "ready" && current.blockedBy?.includes("UNKNOWN"))
      )
        return Promise.resolve({
          id: "update-notice",
          state: "refused",
          code: "UPDATE_NOTICE_NOT_AVAILABLE",
        });
      return dispatchUpdate(
        "update-notice",
        { action, noticeKey },
        async (operationId) => {
          const revision = ports.revision();
          const value = InstalledUpdateViewSchema.safeParse(
            await invokeTrackedUpdate(
              {
                kind: "notice-seen",
                noticeKey: notice.key,
              },
              operationId,
            ),
          );
          if (
            !value.success ||
            !("notice" in value.data) ||
            !value.data.notice ||
            value.data.notice.key !== notice.key ||
            JSON.stringify({ ...value.data, notice: undefined }) !==
              JSON.stringify({ ...current, notice: undefined })
          )
            return {
              id: "update-notice",
              state: "unknown",
              code: "UPDATE_NOTICE_OUTCOME_UNKNOWN",
            };
          // The reply acknowledges its bound notice, not a newer event. The
          // command's own published event may already have supplied this state.
          if (ports.revision() === revision) ports.adopt(value.data);
          const blocked = value.data.notice.blockedBy;
          return {
            id: "update-notice",
            state: blocked?.includes("UNKNOWN")
              ? "unknown"
              : blocked || !value.data.notice.seen
                ? "refused"
                : "applied",
            code:
              blocked ??
              (value.data.notice.seen
                ? null
                : "UPDATE_NOTICE_NOT_ACKNOWLEDGED"),
          };
        },
      );
    }
    if (
      (action === "download" || action === "skip") &&
      ports.snapshot().update.phase !== "available"
    )
      return Promise.resolve({
        id: "update",
        state: "refused",
        code: "UPDATE_NOT_AVAILABLE",
      });
    if (action === "restart") {
      const state = ports.snapshot().update;
      if (state.phase !== "ready" || state.blockedBy !== null)
        return Promise.resolve({
          id: "update",
          state: "refused",
          code: "UPDATE_NOT_READY",
        });
    }
    if (action === "restart-confirmed") {
      const state = ports.snapshot().update;
      if (
        !confirmedRestartAllowed(state) ||
        state.phase !== "ready" ||
        state.version !== noticeKey
      )
        return Promise.resolve({
          id: "update",
          state: "refused",
          code: "UPDATE_NOT_READY",
        });
    }
    return dispatchUpdate(
      "update",
      { action, version: noticeKey },
      async (operationId) => {
        const revision = ports.revision();
        const value = InstalledUpdateViewSchema.safeParse(
          await invokeTrackedUpdate(
            action === "restart-confirmed"
              ? { kind: "restart-confirmed", version: noticeKey! }
              : { kind: action },
            operationId,
          ),
        );
        if (!value.success)
          return {
            id: "update",
            state: "unknown",
            code: "UPDATE_OUTCOME_UNKNOWN",
          };
        // The reply settles this command, not a more recent progress observation.
        if (ports.revision() === revision) ports.adopt(value.data);
        return {
          id: "update",
          state:
            value.data.phase === "unavailable"
              ? "refused"
              : value.data.phase === "failed"
                ? value.data.code.includes("UNKNOWN")
                  ? "unknown"
                  : "refused"
                : "applied",
          code:
            value.data.phase === "failed" || value.data.phase === "unavailable"
              ? value.data.code
              : null,
        };
      },
    );
  }

  function setAutomaticDownloads(enabled: boolean): Promise<Intent> {
    const key = "update-automatic-downloads";
    const current = ports.snapshot();
    const preference = current.update.automaticUpdatePreference;
    if (!automaticUpdateAvailable(current))
      return Promise.resolve({
        id: key,
        state: "refused",
        code: "UPDATE_AUTOMATIC_PREFERENCE_UNAVAILABLE",
      });
    if (
      preference?.status === "confirmed" &&
      preference.enabled === enabled &&
      preference.scope === "download-and-install"
    )
      return Promise.resolve({ id: key, state: "applied", code: null });
    return dispatchUpdate(key, enabled, async (operationId) => {
      const revision = ports.revision();
      const parsed = InstalledUpdateViewSchema.safeParse(
        await invokeTrackedUpdate(
          {
            kind: "set-automatic-update-preference",
            enabled,
            scope: "download-and-install",
          },
          operationId,
        ),
      );
      if (!parsed.success || !parsed.data.automaticUpdatePreference)
        return {
          id: key,
          state: "unknown",
          code: "UPDATE_AUTOMATIC_PREFERENCE_OUTCOME_UNKNOWN",
        };
      if (ports.revision() === revision) ports.adopt(parsed.data);
      const result = parsed.data.automaticUpdatePreference;
      return result.status === "confirmed" &&
        result.enabled === enabled &&
        result.scope === "download-and-install"
        ? { id: key, state: "applied", code: null }
        : result.status === "blocked"
          ? { id: key, state: "refused", code: result.code }
          : {
              id: key,
              state: "unknown",
              code:
                result.status === "unknown"
                  ? result.code
                  : "UPDATE_AUTOMATIC_PREFERENCE_ACK_MISMATCH",
            };
    });
  }

  function setInstallOnQuitPreference(
    enabled: boolean,
    facade: RendererFacade,
  ): Promise<Intent> {
    const key = "update-install-on-quit";
    const retained = ports.snapshot().intents[key];
    if (retained?.state === "unknown") return Promise.resolve(retained);
    if (
      typeof enabled !== "boolean" ||
      !canSetInstallOnQuitPreference(ports.snapshot(), facade)
    )
      return Promise.resolve({
        id: key,
        state: "refused",
        code: "UPDATE_QUIT_PREFERENCE_UNAVAILABLE",
      });
    if (ports.snapshot().update.installOnQuitPreference?.enabled === enabled)
      return Promise.resolve({ id: key, state: "applied", code: null });
    return dispatchUpdate(key, enabled, async (operationId) => {
      // The digest await may have delivered a new admission fence. This
      // command's own pending intent is a latch, not an eligibility failure.
      if (!installOnQuitPreferenceEligible(ports.snapshot()))
        return {
          id: key,
          state: "refused",
          code: "UPDATE_QUIT_PREFERENCE_UNAVAILABLE",
        };
      const revision = ports.revision();
      const parsed = InstalledUpdateViewSchema.safeParse(
        await invokeTrackedUpdate(
          {
            kind: "set-install-on-quit-preference",
            enabled,
          },
          operationId,
        ),
      );
      if (!parsed.success || !parsed.data.installOnQuitPreference)
        return {
          id: key,
          state: "unknown",
          code: "UPDATE_QUIT_PREFERENCE_OUTCOME_UNKNOWN",
        };
      if (ports.revision() === revision) ports.adopt(parsed.data);
      const result = parsed.data.installOnQuitPreference;
      return result.status === "confirmed" && result.enabled === enabled
        ? { id: key, state: "applied", code: null }
        : result.status === "blocked"
          ? { id: key, state: "refused", code: result.code }
          : {
              id: key,
              state: "unknown",
              code:
                result.status === "unknown"
                  ? result.code
                  : "UPDATE_QUIT_PREFERENCE_ACK_MISMATCH",
            };
    });
  }

  function checkOnOpen(): Promise<Intent> | undefined {
    const { update: current, intents } = ports.snapshot();
    // Opening the menu observes an existing download/install or retained unknown.
    if (
      intents.update?.state === "pending" ||
      intents.update?.state === "unknown" ||
      (current.phase === "failed" && current.code.includes("UNKNOWN")) ||
      !updateCheckAllowed(current)
    )
      return;
    return update("check");
  }

  return {
    update,
    setAutomaticDownloads,
    setInstallOnQuitPreference,
    checkOnOpen,
    requestCheckOnOpen(booting) {
      if (booting) pendingCheck = true;
      else void checkOnOpen();
    },
    async settlePendingCheck(disposed) {
      if (pendingCheck && !disposed) {
        pendingCheck = false;
        await checkOnOpen();
      }
    },
  };
}
