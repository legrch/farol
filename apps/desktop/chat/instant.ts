import {
  dismissInstantPowerPickerScript,
  focusInstantPowerSliderScript,
  lowerInstantPowerSliderScript,
  openInstantPowerPickerScript,
  openTemporaryPersonalizationScript,
  selectTemporaryPersonalizationScript,
  temporaryInstantProfileProbe,
} from "../../../src/apps/desktop/chatgpt/scripts";
import {
  instantPowerSliderSchema,
  temporaryInstantProfileSchema,
} from "./probe";

// Preparing the owner's temporary (or ordinary) Instant ChatGPT profile before a
// task is sent: wait for the composer, make sure the page is the temporary or
// ordinary chat that was asked for, lower the Instant power slider, choose
// Personalized, and read the page once more. Every step drives the page only
// through `execute`, and every step is fenced by the document identity the route
// reports: a navigation, a replaced frame, a retired operation or a lost window
// ends the preparation as a refusal. No click is ever repeated after an
// acknowledged click, an exception or a changed identity, and an unrecognized
// answer is never read as success.

// Why one preparation was refused. A closed, content-free vocabulary: it names
// the check that failed and never carries page text, an address, an identifier
// or anything the owner typed.
export const instantProfileRefusalReasons = [
  // The probe could not be read, or answered something unrecognized.
  "read_failed",
  "composer_not_ready",
  "draft_present",
  // The document, its frame, the operation or the route lost its identity.
  "identity_lost",
  // The bound expired before any observation could be taken.
  "deadline",
  "not_temporary",
  "model_not_ready",
  "navigation_failed",
  "surface_not_current",
  // The owner's original document is no longer the current one.
  "document_replaced",
  // A page script or step threw, or was refused by the route's fence.
  "script_failed",
  "picker_not_opened",
  "picker_not_dismissed",
  "slider_not_ready",
  "slider_not_minimum",
  "instant_not_selected",
  "personalization_not_ready",
  "personalization_not_selected",
] as const;
export type InstantProfileRefusalReason =
  (typeof instantProfileRefusalReasons)[number];

/** Pre-submission evidence; only the allowlisted public model label is text.
 * Reported once for every refused profile preparation, with the closed
 * `reason` and `code` of that refusal. */
export type ChatGptProfilePreparationDiagnostic = Readonly<{
  stage:
    | "initial"
    | "navigate"
    | "hydrate"
    | "picker"
    | "slider"
    | "selected-model"
    | "personalization"
    | "final";
  code: InstantProfileRefusal;
  reason: InstantProfileRefusalReason;
  // Monotonic time from the start of the preparation to the refusal.
  elapsedMs: number;
  expectedTemporary: boolean;
  logicalDocumentChanged: boolean;
  physicalDocumentChanged: boolean;
  // null before the profile document is bound: the address is not read then.
  urlChanged: boolean | null;
  operationChanged: boolean;
  surfaceChanged: boolean;
  probe: Readonly<{
    composerReady: boolean;
    draftPresent: boolean;
    temporary: boolean;
    modelReady: boolean;
    instant: boolean;
    visibleModelLabel: string | null;
    modelControlCount: number;
    labelHasInstant: boolean;
    labelHasThinkingEffort: boolean;
    labelHasFormatMarks: boolean;
  }> | null;
  sliderReady: boolean;
  sliderAtMinimum: boolean;
}>;

export type InstantProfileRefusal =
  | "CHATGPT_COMPOSER_DRAFT_PRESENT"
  | "CHATGPT_TEMPORARY_CHAT_REQUIRED"
  | "CHATGPT_INSTANT_MODEL_REQUIRED";

// What the route says about the document under preparation at one moment. The
// plain facts are cheap and never throw. The address and the frame are read on
// demand, by function, and only after the cheaper facts allowed it: a destroyed
// window or frame may throw on access, and an earlier refusal must not turn
// into an unavailable submission because something was read too soon. The frame
// identity is opaque: only its equality with an earlier reading, and the facts
// beside it, are used.
export type InstantSurfaceSnapshot = Readonly<{
  // The candidate is still the route window and is not destroyed.
  surfaceCurrent: boolean;
  disposing: boolean;
  documentLoadFailed: boolean;
  documentAwaitingCommit: boolean;
  documentGeneration: number;
  physicalDocumentGeneration: number;
  operationGeneration: number;
  // The route document address; may throw once the window is gone.
  url: () => string;
  // The main frame now, or null; may throw once the window is gone.
  frame: () => Readonly<{
    identity: object;
    // Asked only after the identity matched, as before.
    isDestroyed: () => boolean;
    // Asked only while the frame is not destroyed.
    url: () => string;
  }> | null;
}>;

export type InstantProfilePorts = Readonly<{
  // One page script. The route fences it by document, operation and deadline
  // and rejects when that fence is lost.
  execute: (
    script: string,
    gesture: boolean,
    deadline: number,
  ) => Promise<unknown>;
  // Load `url` in the route document, bounded by the route's open deadline and
  // by `taskDeadline`; rejects when the document does not become ready.
  navigate: (url: string, taskDeadline: number) => Promise<void>;
  snapshot: () => InstantSurfaceSnapshot;
  now: () => number;
  delay: (ms: number) => Promise<void>;
  // One best-effort notification per refused profile preparation.
  report:
    ((diagnostic: ChatGptProfilePreparationDiagnostic) => void) | undefined;
}>;

export type InstantProfileInput = Readonly<{
  homeUrl: string;
  // true: the temporary chat, personalized; false: an ordinary Instant chat.
  temporary: boolean;
  taskDeadline: number;
  // The owner's original document, when the caller binds one.
  originalDocumentCurrent: (() => boolean) | undefined;
}>;

export type InstantProfilePreparer = (
  input: InstantProfileInput,
) => Promise<InstantProfileRefusal | null>;

export function createInstantProfilePreparer(
  ports: InstantProfilePorts,
): InstantProfilePreparer {
  return async ({
    homeUrl,
    temporary,
    taskDeadline,
    originalDocumentCurrent,
  }) => {
    const startedAt = ports.now();
    const documentGone = () =>
      originalDocumentCurrent !== undefined && !originalDocumentCurrent();
    const execute = (
      script: string,
      gesture: boolean,
      deadline = taskDeadline,
    ) => {
      if (documentGone())
        throw new Error("ChatGPT preparation document changed");
      return ports.execute(script, gesture, deadline);
    };
    let observed: ChatGptProfilePreparationDiagnostic["probe"] = null;
    const read = async (deadline = taskDeadline) => {
      try {
        const result = temporaryInstantProfileSchema.safeParse(
          await execute(temporaryInstantProfileProbe, true, deadline),
        );
        observed = result.success
          ? {
              composerReady: result.data.composerReady,
              draftPresent: result.data.draftPresent,
              temporary: result.data.temporary,
              modelReady: result.data.modelReady,
              instant: result.data.instant,
              visibleModelLabel: result.data.visibleModelLabel ?? null,
              modelControlCount: result.data.modelControlCount ?? 0,
              labelHasInstant: result.data.labelHasInstant ?? false,
              labelHasThinkingEffort:
                result.data.labelHasThinkingEffort ?? false,
              labelHasFormatMarks: result.data.labelHasFormatMarks ?? false,
            }
          : null;
        return result;
      } catch {
        observed = null;
        return temporaryInstantProfileSchema.safeParse(null);
      }
    };
    type Probe = Awaited<ReturnType<typeof read>>;
    const temporaryUrl = new URL(homeUrl);
    if (temporary) temporaryUrl.searchParams.set("temporary-chat", "true");
    else temporaryUrl.searchParams.delete("temporary-chat");
    const start = ports.snapshot();
    const waitForExistingTemporary =
      temporary && start.url() === temporaryUrl.href;
    const initialFrame = start.frame()?.identity ?? null;

    // The document the diagnostic compares against: the one the preparation
    // started on, until the profile document is bound after the navigation.
    // The address is compared only once it is bound.
    let baseDocumentGeneration = start.documentGeneration;
    let basePhysicalDocumentGeneration = start.physicalDocumentGeneration;
    let baseOperationGeneration = start.operationGeneration;
    let baseUrl: string | null = null;
    let stage: ChatGptProfilePreparationDiagnostic["stage"] = "initial";
    let sliderReady = false;
    let sliderAtMinimum = false;
    let reported = false;
    // Every refusal goes through here, exactly once, with its closed reason.
    // The report is best effort: it never changes the answer, and a snapshot
    // that cannot be taken (the window is gone) reads as everything changed.
    const refuse = <Code extends InstantProfileRefusal>(
      code: Code,
      reason: InstantProfileRefusalReason,
    ): Code => {
      if (reported) return code;
      reported = true;
      try {
        let now: InstantSurfaceSnapshot | null = null;
        try {
          now = ports.snapshot();
        } catch {
          now = null;
        }
        // A window that is gone is not asked for its address: it changed.
        let urlChanged: boolean | null = null;
        if (baseUrl !== null) {
          try {
            urlChanged =
              now === null || !now.surfaceCurrent || now.url() !== baseUrl;
          } catch {
            urlChanged = true;
          }
        }
        const elapsed = ports.now() - startedAt;
        ports.report?.({
          stage,
          code,
          reason,
          elapsedMs: Number.isFinite(elapsed)
            ? Math.max(0, Math.round(elapsed))
            : 0,
          expectedTemporary: temporary,
          logicalDocumentChanged:
            now === null || now.documentGeneration !== baseDocumentGeneration,
          physicalDocumentChanged:
            now === null ||
            now.physicalDocumentGeneration !== basePhysicalDocumentGeneration,
          urlChanged,
          operationChanged:
            now === null || now.operationGeneration !== baseOperationGeneration,
          surfaceChanged: now === null || !now.surfaceCurrent,
          probe: observed,
          sliderReady,
          sliderAtMinimum,
        });
      } catch {
        // Observers cannot change admission or make a refused action retryable.
      }
      return code;
    };

    // What is wrong with one probe answer, most basic first; null when the
    // page shows a composer without a draft, in the requested chat, with a
    // model control.
    const gap = (probe: Probe): InstantProfileRefusalReason | null =>
      !probe.success
        ? "read_failed"
        : !probe.data.composerReady
          ? "composer_not_ready"
          : probe.data.draftPresent
            ? "draft_present"
            : probe.data.temporary !== temporary
              ? "not_temporary"
              : !probe.data.modelReady
                ? "model_not_ready"
                : null;

    // Before the profile document is bound. Only the cheap facts are asked of
    // a chat that will be navigated; a chat that is already the temporary one
    // must also keep its address and frame, read only after the cheaper facts.
    const initialLoss = (): InstantProfileRefusalReason | null => {
      if (documentGone()) return "document_replaced";
      const now = ports.snapshot();
      if (!now.surfaceCurrent || now.disposing) return "surface_not_current";
      if (!waitForExistingTemporary) return null;
      if (
        now.documentLoadFailed ||
        now.documentAwaitingCommit ||
        now.documentGeneration !== start.documentGeneration ||
        now.physicalDocumentGeneration !== start.physicalDocumentGeneration ||
        now.operationGeneration !== start.operationGeneration ||
        now.url() !== temporaryUrl.href
      )
        return "identity_lost";
      const frame = now.frame();
      return (frame?.identity ?? null) !== initialFrame ||
        (frame !== null &&
          (frame.isDestroyed() || frame.url() !== temporaryUrl.href))
        ? "identity_lost"
        : null;
    };

    // The page may still be loading and nothing has been sent or changed, so
    // an unreadable probe or a composer that is not there yet is polled within
    // the bound. A draft, a lost identity and an expired bound refuse at once.
    const initialDeadline = Math.min(taskDeadline, ports.now() + 12_000);
    const firstGone = initialLoss();
    if (firstGone) return refuse("CHATGPT_TEMPORARY_CHAT_REQUIRED", firstGone);
    if (ports.now() >= initialDeadline)
      return refuse("CHATGPT_TEMPORARY_CHAT_REQUIRED", "deadline");
    let initial = await read(
      waitForExistingTemporary ? initialDeadline : taskDeadline,
    );
    for (;;) {
      const gone = initialLoss();
      if (gone) return refuse("CHATGPT_TEMPORARY_CHAT_REQUIRED", gone);
      if (initial.success && initial.data.draftPresent)
        return refuse("CHATGPT_COMPOSER_DRAFT_PRESENT", "draft_present");
      if (
        initial.success &&
        initial.data.composerReady &&
        (!waitForExistingTemporary || initial.data.temporary)
      )
        break;
      const unmet = (): InstantProfileRefusalReason =>
        !initial.success
          ? "read_failed"
          : !initial.data.composerReady
            ? "composer_not_ready"
            : "not_temporary";
      if (ports.now() >= initialDeadline)
        return refuse("CHATGPT_TEMPORARY_CHAT_REQUIRED", unmet());
      await ports.delay(
        Math.min(200, Math.max(0, Math.ceil(initialDeadline - ports.now()))),
      );
      const goneAfterDelay = initialLoss();
      if (goneAfterDelay)
        return refuse("CHATGPT_TEMPORARY_CHAT_REQUIRED", goneAfterDelay);
      if (ports.now() >= initialDeadline)
        return refuse("CHATGPT_TEMPORARY_CHAT_REQUIRED", unmet());
      initial = await read(initialDeadline);
    }
    if (waitForExistingTemporary && ports.now() >= initialDeadline)
      return refuse("CHATGPT_TEMPORARY_CHAT_REQUIRED", "deadline");

    stage = "navigate";
    try {
      if (documentGone())
        return refuse("CHATGPT_TEMPORARY_CHAT_REQUIRED", "document_replaced");
      if (
        !temporary ||
        ports.snapshot().url() !== temporaryUrl.href ||
        initial.data.temporary !== temporary
      )
        await ports.navigate(temporaryUrl.href, taskDeadline);
    } catch {
      return refuse("CHATGPT_TEMPORARY_CHAT_REQUIRED", "navigation_failed");
    }
    const profileBase = ports.snapshot();
    if (!profileBase.surfaceCurrent)
      return refuse("CHATGPT_TEMPORARY_CHAT_REQUIRED", "surface_not_current");
    const profileUrl = profileBase.url();
    baseUrl = profileUrl;
    baseDocumentGeneration = profileBase.documentGeneration;
    basePhysicalDocumentGeneration = profileBase.physicalDocumentGeneration;
    baseOperationGeneration = profileBase.operationGeneration;
    // The profile document's identity: the logical document may be rebound once
    // by hydration, the rest never.
    const profileLoss = (): InstantProfileRefusalReason | null => {
      if (documentGone()) return "document_replaced";
      const now = ports.snapshot();
      if (!now.surfaceCurrent) return "surface_not_current";
      return now.documentGeneration !== baseDocumentGeneration ||
        now.operationGeneration !== baseOperationGeneration ||
        now.url() !== profileUrl
        ? "identity_lost"
        : null;
    };
    // The same question inside a handler that already caught a failure: asking
    // must not turn the refusal into a throw.
    const profileLossOrNull = (): InstantProfileRefusalReason | null => {
      try {
        return profileLoss();
      } catch {
        return "identity_lost";
      }
    };
    stage = "hydrate";
    const refuseInstant = (
      reason: InstantProfileRefusalReason,
    ): "CHATGPT_INSTANT_MODEL_REQUIRED" =>
      refuse("CHATGPT_INSTANT_MODEL_REQUIRED", reason);
    const deadline = Math.min(taskDeadline, ports.now() + 12_000);
    let profile = await read();
    while (
      ports.now() < deadline &&
      (!profile.success ||
        !profile.data.composerReady ||
        profile.data.temporary !== temporary ||
        !profile.data.modelReady)
    ) {
      await ports.delay(200);
      if (!ports.snapshot().surfaceCurrent)
        return refuse("CHATGPT_TEMPORARY_CHAT_REQUIRED", "surface_not_current");
      if (documentGone())
        return refuse("CHATGPT_TEMPORARY_CHAT_REQUIRED", "document_replaced");
      profile = await read();
    }
    const hydrationGap = gap(profile);
    if (hydrationGap)
      return refuse("CHATGPT_TEMPORARY_CHAT_REQUIRED", hydrationGap);
    // Hydration can emit an in-place navigation before we interact with the
    // page. Bind the subsequent picker to the newly observed document only
    // when the physical document, URL, operation and surface are unchanged.
    // Once interaction begins, every later navigation still fences the action.
    const hydrated = ports.snapshot();
    if (
      hydrated.surfaceCurrent &&
      hydrated.physicalDocumentGeneration === basePhysicalDocumentGeneration &&
      hydrated.operationGeneration === baseOperationGeneration &&
      hydrated.url() === profileUrl &&
      hydrated.documentGeneration !== baseDocumentGeneration
    ) {
      baseDocumentGeneration = hydrated.documentGeneration;
      profile = await read();
    }
    const reboundGap = gap(profile);
    if (reboundGap) return refuseInstant(reboundGap);
    const reboundLoss = profileLoss();
    if (reboundLoss) return refuseInstant(reboundLoss);

    // ChatGPT already shows Instant, including the "6 Instant" label and the
    // reasoning-effort control. That screen has no separate power slider.
    // Opening one and refusing the test leaves an empty temporary chat.
    const alreadyInstant = profile.success && profile.data.instant === true;
    let selected: Probe = profile;
    if (!alreadyInstant) {
      stage = "picker";
      try {
        // A false result guarantees the opener did not click. Wait for a
        // temporarily disabled/replaced control, but never repeat an action
        // after an acknowledged click, exception or changed document identity.
        const openDeadline = ports.now() + 2_000;
        let opened = false;
        for (let attempt = 0; attempt < 20 && !opened; attempt += 1) {
          if (ports.now() >= openDeadline)
            return refuseInstant("picker_not_opened");
          const before = profileLoss();
          if (before) return refuseInstant(before);
          const result = await execute(openInstantPowerPickerScript, true);
          const after = profileLoss();
          if (after) return refuseInstant(after);
          if (result === true) {
            opened = true;
            break;
          }
          if (result !== false || ports.now() >= openDeadline)
            return refuseInstant("picker_not_opened");
          await ports.delay(100);
          const waited = profileLoss();
          if (waited) return refuseInstant(waited);
        }
        if (!opened) return refuseInstant("picker_not_opened");
        // Opening a provider menu does not acknowledge that its controls have
        // rendered. Observe the same opened picker for a bounded interval; never
        // click it again or reinterpret an unrecognized result as readiness.
        stage = "slider";
        const pickerDeadline = ports.now() + 2_000;
        let minimumObserved = false;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const before = profileLoss();
          if (before) return refuseInstant(before);
          let slider = instantPowerSliderSchema.safeParse(
            await execute(focusInstantPowerSliderScript, true),
          );
          while (
            slider.success &&
            !slider.data.ready &&
            ports.now() < pickerDeadline
          ) {
            await ports.delay(100);
            const waited = profileLoss();
            if (waited) return refuseInstant(waited);
            slider = instantPowerSliderSchema.safeParse(
              await execute(focusInstantPowerSliderScript, true),
            );
          }
          sliderReady = slider.success && slider.data.ready;
          sliderAtMinimum =
            slider.success &&
            slider.data.ready &&
            slider.data.atMinimum === true;
          const afterSlider = profileLoss();
          if (afterSlider) return refuseInstant(afterSlider);
          if (!slider.success || !slider.data.ready)
            return refuseInstant("slider_not_ready");
          if (slider.data.atMinimum) {
            minimumObserved = true;
            break;
          }
          if ((await execute(lowerInstantPowerSliderScript, true)) !== true)
            return refuseInstant("slider_not_minimum");
          const afterLower = profileLoss();
          if (afterLower) return refuseInstant(afterLower);
          await ports.delay(80);
        }
        if (!minimumObserved) return refuseInstant("slider_not_minimum");
        if ((await execute(dismissInstantPowerPickerScript, true)) !== true)
          return refuseInstant("picker_not_dismissed");
        const afterDismiss = profileLoss();
        if (afterDismiss) return refuseInstant(afterDismiss);
      } catch {
        return refuseInstant(profileLossOrNull() ?? "script_failed");
      }
      stage = "selected-model";
      selected = await read();
      const selectedDeadline = ports.now() + 2_000;
      while (
        selected.success &&
        !selected.data.instant &&
        ports.now() < selectedDeadline
      ) {
        await ports.delay(100);
        const waited = profileLoss();
        if (waited) return refuseInstant(waited);
        selected = await read();
      }
      const selectedLoss = profileLoss();
      if (selectedLoss) return refuseInstant(selectedLoss);
      const selectedGap = gap(selected);
      if (selectedGap) return refuseInstant(selectedGap);
      if (!selected.success || !selected.data.instant)
        return refuseInstant("instant_not_selected");
    }

    // An explicitly requested ordinary Instant profile needs no temporary-chat
    // personalization controls. Preserve the owner's account preferences.
    if (!temporary) return null;

    // Personalization controls may depend on the selected provider model.
    // Confirm Instant before waiting for or selecting Personalized; neither
    // state alone authorizes preparation of a message or submission.
    stage = "personalization";
    const personalizationDeadline = ports.now() + 2_000;
    profile = selected;
    while (
      profile.success &&
      !profile.data.personalizationReady &&
      ports.now() < personalizationDeadline
    ) {
      await ports.delay(100);
      const waited = profileLoss();
      if (waited) return refuse("CHATGPT_TEMPORARY_CHAT_REQUIRED", waited);
      profile = await read();
    }
    const personalizationLoss = profileLoss();
    if (personalizationLoss)
      return refuse("CHATGPT_TEMPORARY_CHAT_REQUIRED", personalizationLoss);
    const personalizationGap = gap(profile);
    if (personalizationGap)
      return refuse("CHATGPT_TEMPORARY_CHAT_REQUIRED", personalizationGap);
    if (!profile.success || !profile.data.instant)
      return refuse("CHATGPT_TEMPORARY_CHAT_REQUIRED", "instant_not_selected");
    if (!profile.data.personalizationReady)
      return refuse(
        "CHATGPT_TEMPORARY_CHAT_REQUIRED",
        "personalization_not_ready",
      );
    if (!profile.data.personalized) {
      try {
        if ((await execute(openTemporaryPersonalizationScript, true)) !== true)
          return refuse(
            "CHATGPT_TEMPORARY_CHAT_REQUIRED",
            "personalization_not_selected",
          );
        const afterOpen = profileLoss();
        if (afterOpen)
          return refuse("CHATGPT_TEMPORARY_CHAT_REQUIRED", afterOpen);
        let chosen = false;
        for (let attempt = 0; attempt < 10; attempt += 1) {
          const before = profileLoss();
          if (before) return refuse("CHATGPT_TEMPORARY_CHAT_REQUIRED", before);
          if (
            (await execute(selectTemporaryPersonalizationScript, true)) === true
          ) {
            chosen = true;
            break;
          }
          await ports.delay(100);
        }
        if (!chosen)
          return refuse(
            "CHATGPT_TEMPORARY_CHAT_REQUIRED",
            "personalization_not_selected",
          );
        profile = await read();
        if (!profile.success)
          return refuse("CHATGPT_TEMPORARY_CHAT_REQUIRED", "read_failed");
        if (!profile.data.personalized)
          return refuse(
            "CHATGPT_TEMPORARY_CHAT_REQUIRED",
            "personalization_not_selected",
          );
      } catch {
        return refuse(
          "CHATGPT_TEMPORARY_CHAT_REQUIRED",
          profileLossOrNull() ?? "script_failed",
        );
      }
    }
    stage = "final";
    const ready = await read();
    if (ready.success && (!ready.data.modelReady || !ready.data.instant))
      return refuseInstant("instant_not_selected");
    const finalLoss = profileLoss();
    if (finalLoss) return refuse("CHATGPT_TEMPORARY_CHAT_REQUIRED", finalLoss);
    const finalGap = gap(ready);
    if (finalGap) return refuse("CHATGPT_TEMPORARY_CHAT_REQUIRED", finalGap);
    if (!ready.success || !ready.data.instant)
      return refuse("CHATGPT_TEMPORARY_CHAT_REQUIRED", "instant_not_selected");
    if (!ready.data.personalizationReady)
      return refuse(
        "CHATGPT_TEMPORARY_CHAT_REQUIRED",
        "personalization_not_ready",
      );
    if (!ready.data.personalized)
      return refuse(
        "CHATGPT_TEMPORARY_CHAT_REQUIRED",
        "personalization_not_selected",
      );
    return null;
  };
}
