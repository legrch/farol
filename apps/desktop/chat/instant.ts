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

/** Pre-submission evidence; only the allowlisted public model label is text. */
export type ChatGptProfilePreparationDiagnostic = Readonly<{
  stage: "hydrate" | "picker" | "slider" | "selected-model";
  expectedTemporary: boolean;
  logicalDocumentChanged: boolean;
  physicalDocumentChanged: boolean;
  urlChanged: boolean;
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
// frame identity is opaque: only its equality with an earlier reading, and the
// two facts beside it, are used.
export type InstantSurfaceSnapshot = Readonly<{
  // The candidate is still the route window and is not destroyed.
  surfaceCurrent: boolean;
  disposing: boolean;
  documentLoadFailed: boolean;
  documentAwaitingCommit: boolean;
  documentGeneration: number;
  physicalDocumentGeneration: number;
  operationGeneration: number;
  url: string;
  frame: Readonly<{
    identity: object;
    // Asked only after the identity matched, as before.
    isDestroyed: () => boolean;
    url: string;
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
  // One best-effort notification per refused Instant profile.
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
    const execute = (
      script: string,
      gesture: boolean,
      deadline = taskDeadline,
    ) => {
      if (originalDocumentCurrent && !originalDocumentCurrent())
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
    const temporaryUrl = new URL(homeUrl);
    if (temporary) temporaryUrl.searchParams.set("temporary-chat", "true");
    else temporaryUrl.searchParams.delete("temporary-chat");
    const start = ports.snapshot();
    const waitForExistingTemporary =
      temporary && start.url === temporaryUrl.href;
    const initialFrame = start.frame?.identity ?? null;
    const initialIdentityLost = () => {
      const now = ports.snapshot();
      return (
        (originalDocumentCurrent !== undefined && !originalDocumentCurrent()) ||
        !now.surfaceCurrent ||
        now.disposing ||
        now.documentLoadFailed ||
        now.documentAwaitingCommit ||
        now.documentGeneration !== start.documentGeneration ||
        now.physicalDocumentGeneration !== start.physicalDocumentGeneration ||
        now.operationGeneration !== start.operationGeneration ||
        now.url !== temporaryUrl.href ||
        (now.frame?.identity ?? null) !== initialFrame ||
        (now.frame !== null &&
          (now.frame.isDestroyed() || now.frame.url !== temporaryUrl.href))
      );
    };
    const initialDeadline = Math.min(taskDeadline, ports.now() + 12_000);
    if (
      waitForExistingTemporary &&
      (initialIdentityLost() || ports.now() >= initialDeadline)
    )
      return "CHATGPT_TEMPORARY_CHAT_REQUIRED";
    let initial = await read(
      waitForExistingTemporary ? initialDeadline : taskDeadline,
    );
    if (waitForExistingTemporary && initialIdentityLost())
      return "CHATGPT_TEMPORARY_CHAT_REQUIRED";
    if (!initial.success) return "CHATGPT_TEMPORARY_CHAT_REQUIRED";
    if (initial.data.draftPresent) return "CHATGPT_COMPOSER_DRAFT_PRESENT";
    if (!initial.data.composerReady) return "CHATGPT_TEMPORARY_CHAT_REQUIRED";
    if (waitForExistingTemporary) {
      while (!initial.data.temporary && ports.now() < initialDeadline) {
        await ports.delay(
          Math.min(200, Math.max(0, initialDeadline - ports.now())),
        );
        if (initialIdentityLost() || ports.now() >= initialDeadline)
          return "CHATGPT_TEMPORARY_CHAT_REQUIRED";
        initial = await read(initialDeadline);
        if (initialIdentityLost() || !initial.success)
          return "CHATGPT_TEMPORARY_CHAT_REQUIRED";
        if (initial.data.draftPresent) return "CHATGPT_COMPOSER_DRAFT_PRESENT";
        if (!initial.data.composerReady)
          return "CHATGPT_TEMPORARY_CHAT_REQUIRED";
      }
      if (
        !initial.data.temporary ||
        ports.now() >= initialDeadline ||
        initialIdentityLost()
      )
        return "CHATGPT_TEMPORARY_CHAT_REQUIRED";
    }

    try {
      if (originalDocumentCurrent && !originalDocumentCurrent())
        return "CHATGPT_TEMPORARY_CHAT_REQUIRED";
      if (
        !temporary ||
        ports.snapshot().url !== temporaryUrl.href ||
        initial.data.temporary !== temporary
      )
        await ports.navigate(temporaryUrl.href, taskDeadline);
    } catch {
      return "CHATGPT_TEMPORARY_CHAT_REQUIRED";
    }
    const profileBase = ports.snapshot();
    if (!profileBase.surfaceCurrent) return "CHATGPT_TEMPORARY_CHAT_REQUIRED";
    const profileUrl = profileBase.url;
    let profileDocumentGeneration = profileBase.documentGeneration;
    const profilePhysicalDocumentGeneration =
      profileBase.physicalDocumentGeneration;
    const profileObservationGeneration = profileBase.operationGeneration;
    const profileIdentityLost = () => {
      const now = ports.snapshot();
      return (
        (originalDocumentCurrent !== undefined && !originalDocumentCurrent()) ||
        !now.surfaceCurrent ||
        now.documentGeneration !== profileDocumentGeneration ||
        now.operationGeneration !== profileObservationGeneration ||
        now.url !== profileUrl
      );
    };
    let stage: ChatGptProfilePreparationDiagnostic["stage"] = "hydrate";
    let sliderReady = false;
    let sliderAtMinimum = false;
    const refuseInstant = (): "CHATGPT_INSTANT_MODEL_REQUIRED" => {
      try {
        const now = ports.snapshot();
        ports.report?.({
          stage,
          expectedTemporary: temporary,
          logicalDocumentChanged:
            now.documentGeneration !== profileDocumentGeneration,
          physicalDocumentChanged:
            now.physicalDocumentGeneration !==
            profilePhysicalDocumentGeneration,
          urlChanged: now.url !== profileUrl,
          operationChanged:
            now.operationGeneration !== profileObservationGeneration,
          surfaceChanged: !now.surfaceCurrent,
          probe: observed,
          sliderReady,
          sliderAtMinimum,
        });
      } catch {
        // Observers cannot change admission or make a refused action retryable.
      }
      return "CHATGPT_INSTANT_MODEL_REQUIRED";
    };
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
        return "CHATGPT_TEMPORARY_CHAT_REQUIRED";
      profile = await read();
    }
    if (
      !profile.success ||
      !profile.data.composerReady ||
      profile.data.temporary !== temporary ||
      !profile.data.modelReady ||
      profile.data.draftPresent
    )
      return "CHATGPT_TEMPORARY_CHAT_REQUIRED";
    // Hydration can emit an in-place navigation before we interact with the
    // page. Bind the subsequent picker to the newly observed document only
    // when the physical document, URL, operation and surface are unchanged.
    // Once interaction begins, every later navigation still fences the action.
    const hydrated = ports.snapshot();
    if (
      hydrated.surfaceCurrent &&
      hydrated.physicalDocumentGeneration ===
        profilePhysicalDocumentGeneration &&
      hydrated.operationGeneration === profileObservationGeneration &&
      hydrated.url === profileUrl &&
      hydrated.documentGeneration !== profileDocumentGeneration
    ) {
      profileDocumentGeneration = hydrated.documentGeneration;
      profile = await read();
    }
    if (
      !profile.success ||
      !profile.data.composerReady ||
      profile.data.draftPresent ||
      profile.data.temporary !== temporary ||
      !profile.data.modelReady ||
      profileIdentityLost()
    )
      return refuseInstant();

    // ChatGPT already shows Instant, including the "6 Instant" label and the
    // reasoning-effort control. That screen has no separate power slider.
    // Opening one and refusing the test leaves an empty temporary chat.
    const alreadyInstant = profile.success && profile.data.instant === true;
    let selected: Awaited<ReturnType<typeof read>> = profile;
    if (!alreadyInstant) {
      stage = "picker";
      try {
        // A false result guarantees the opener did not click. Wait for a
        // temporarily disabled/replaced control, but never repeat an action
        // after an acknowledged click, exception or changed document identity.
        const openDeadline = ports.now() + 2_000;
        let opened = false;
        for (let attempt = 0; attempt < 20 && !opened; attempt += 1) {
          if (ports.now() >= openDeadline || profileIdentityLost())
            return refuseInstant();
          const result = await execute(openInstantPowerPickerScript, true);
          if (profileIdentityLost()) return refuseInstant();
          if (result === true) {
            opened = true;
            break;
          }
          if (result !== false || ports.now() >= openDeadline)
            return refuseInstant();
          await ports.delay(100);
          if (profileIdentityLost()) return refuseInstant();
        }
        if (!opened) return refuseInstant();
        // Opening a provider menu does not acknowledge that its controls have
        // rendered. Observe the same opened picker for a bounded interval; never
        // click it again or reinterpret an unrecognized result as readiness.
        stage = "slider";
        const pickerDeadline = ports.now() + 2_000;
        let minimumObserved = false;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          if (profileIdentityLost()) return refuseInstant();
          let slider = instantPowerSliderSchema.safeParse(
            await execute(focusInstantPowerSliderScript, true),
          );
          while (
            slider.success &&
            !slider.data.ready &&
            ports.now() < pickerDeadline
          ) {
            await ports.delay(100);
            if (profileIdentityLost()) return refuseInstant();
            slider = instantPowerSliderSchema.safeParse(
              await execute(focusInstantPowerSliderScript, true),
            );
          }
          sliderReady = slider.success && slider.data.ready;
          sliderAtMinimum =
            slider.success &&
            slider.data.ready &&
            slider.data.atMinimum === true;
          if (profileIdentityLost() || !slider.success || !slider.data.ready)
            return refuseInstant();
          if (slider.data.atMinimum) {
            minimumObserved = true;
            break;
          }
          if (
            (await execute(lowerInstantPowerSliderScript, true)) !== true ||
            profileIdentityLost()
          )
            return refuseInstant();
          await ports.delay(80);
        }
        if (!minimumObserved) return refuseInstant();
        if (
          (await execute(dismissInstantPowerPickerScript, true)) !== true ||
          profileIdentityLost()
        )
          return refuseInstant();
      } catch {
        return refuseInstant();
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
        if (profileIdentityLost()) return refuseInstant();
        selected = await read();
      }
      if (
        profileIdentityLost() ||
        !selected.success ||
        !selected.data.composerReady ||
        selected.data.draftPresent ||
        selected.data.temporary !== temporary ||
        !selected.data.modelReady ||
        !selected.data.instant
      )
        return refuseInstant();
    }

    // An explicitly requested ordinary Instant profile needs no temporary-chat
    // personalization controls. Preserve the owner's account preferences.
    if (!temporary) return null;

    // Personalization controls may depend on the selected provider model.
    // Confirm Instant before waiting for or selecting Personalized; neither
    // state alone authorizes preparation of a message or submission.
    const personalizationDeadline = ports.now() + 2_000;
    profile = selected;
    while (
      profile.success &&
      !profile.data.personalizationReady &&
      ports.now() < personalizationDeadline
    ) {
      await ports.delay(100);
      if (profileIdentityLost()) return "CHATGPT_TEMPORARY_CHAT_REQUIRED";
      profile = await read();
    }
    if (
      profileIdentityLost() ||
      !profile.success ||
      !profile.data.composerReady ||
      profile.data.draftPresent ||
      profile.data.temporary !== temporary ||
      !profile.data.instant ||
      !profile.data.personalizationReady
    )
      return "CHATGPT_TEMPORARY_CHAT_REQUIRED";
    if (!profile.data.personalized) {
      try {
        if (
          (await execute(openTemporaryPersonalizationScript, true)) !== true ||
          profileIdentityLost()
        )
          return "CHATGPT_TEMPORARY_CHAT_REQUIRED";
        let chosen = false;
        for (let attempt = 0; attempt < 10; attempt += 1) {
          if (profileIdentityLost()) return "CHATGPT_TEMPORARY_CHAT_REQUIRED";
          if (
            (await execute(selectTemporaryPersonalizationScript, true)) === true
          ) {
            chosen = true;
            break;
          }
          await ports.delay(100);
        }
        if (!chosen) return "CHATGPT_TEMPORARY_CHAT_REQUIRED";
        profile = await read();
        if (!profile.success || !profile.data.personalized)
          return "CHATGPT_TEMPORARY_CHAT_REQUIRED";
      } catch {
        return "CHATGPT_TEMPORARY_CHAT_REQUIRED";
      }
    }
    const ready = await read();
    if (ready.success && (!ready.data.modelReady || !ready.data.instant))
      return "CHATGPT_INSTANT_MODEL_REQUIRED";
    return !profileIdentityLost() &&
      ready.success &&
      ready.data.composerReady &&
      !ready.data.draftPresent &&
      ready.data.temporary &&
      ready.data.personalizationReady &&
      ready.data.personalized &&
      ready.data.modelReady &&
      ready.data.instant
      ? null
      : "CHATGPT_TEMPORARY_CHAT_REQUIRED";
  };
}
