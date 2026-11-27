import {
  dismissInstantPowerPickerScript,
  focusInstantPowerSliderScript,
  lowerInstantPowerSliderScript,
  openInstantPowerPickerScript,
  openTemporaryPersonalizationScript,
  selectTemporaryPersonalizationScript,
  temporaryInstantProfileProbe,
} from "../../../src/apps/desktop/chatgpt/scripts";
import type { ConnectionCheckSteps } from "../../../src/pkg/product-settings/evidence";
import type { InstantProfilePorts } from "./instant";
import {
  instantPowerSliderSchema,
  temporaryInstantProfileSchema,
} from "./probe";

// The connection check's profile preparation. It behaves like a person typing
// by hand: every step is a best-effort attempt whose outcome is reported, and
// none of them can stop the message. A temporary chat that could not be opened,
// an Instant model that could not be selected, a personalization control that
// is absent or renamed: each is recorded and the message still goes.
//
// The one thing that still holds the message back is the owner's own text. A
// draft is never cleared, appended to or mixed with the check: when the page
// still holds one after a fresh Temporary chat, nothing is typed or sent.
//
// This is used only by the explicit connection check. The ordinary task routes
// keep `createInstantProfilePreparer` and its refusals. No step here checks the
// document's identity: every read and click goes to whatever page is current,
// and a script the route cannot dispatch is one more failed step.

/** How long the page may take to show its composer and model control. */
export const BEST_EFFORT_SETTLE_MS = 5_000;
const PERSONALIZATION_SETTLE_MS = 2_000;

export type BestEffortProfileInput = Readonly<{
  homeUrl: string;
  taskDeadline: number;
  // Whether this may navigate. The connection check opens its fresh Temporary
  // chat just before this runs and passes false: a draft still in that chat is
  // then reported, not navigated away from, and a page that is not temporary
  // stays as it is.
  navigate: boolean;
}>;

export type BestEffortProfileResult = Readonly<{
  // Only a draft in the composer holds the message back.
  refusal: "CHATGPT_COMPOSER_DRAFT_PRESENT" | null;
  steps: ConnectionCheckSteps;
}>;

export type BestEffortProfilePreparer = (
  input: BestEffortProfileInput,
) => Promise<BestEffortProfileResult>;

export function createBestEffortProfilePreparer(
  ports: InstantProfilePorts,
): BestEffortProfilePreparer {
  return async ({ homeUrl, taskDeadline, navigate }) => {
    const temporaryUrl = new URL(homeUrl);
    temporaryUrl.searchParams.set("temporary-chat", "true");
    const bound = (ms: number) => Math.min(taskDeadline, ports.now() + ms);

    const read = async (deadline: number) => {
      try {
        return temporaryInstantProfileSchema.safeParse(
          await ports.execute(temporaryInstantProfileProbe, true, deadline),
        );
      } catch {
        return temporaryInstantProfileSchema.safeParse(null);
      }
    };
    type Probe = Awaited<ReturnType<typeof read>>;
    // A script that did not run, threw or was refused by the route's fence is
    // a step that failed, nothing more.
    const run = async (script: string, deadline: number): Promise<unknown> => {
      try {
        return await ports.execute(script, true, deadline);
      } catch {
        return undefined;
      }
    };
    // Read until the page shows a composer and a model control, a draft, or the
    // bound passes; the last answer stands whatever it is.
    const settle = async (ms: number): Promise<Probe> => {
      const deadline = bound(ms);
      let probe = await read(deadline);
      while (
        ports.now() < deadline &&
        !(
          probe.success &&
          (probe.data.draftPresent ||
            (probe.data.composerReady &&
              (probe.data.modelReady || probe.data.modelControlCount === 0)))
        )
      ) {
        await ports.delay(
          Math.min(200, Math.max(0, Math.ceil(deadline - ports.now()))),
        );
        probe = await read(deadline);
      }
      return probe;
    };

    const steps: {
      temporary: ConnectionCheckSteps["temporary"];
      model: ConnectionCheckSteps["model"];
      personalization: ConnectionCheckSteps["personalization"];
    } = {
      temporary: "not_temporary",
      model: "model_unrecognized",
      personalization: "unavailable",
    };
    const draft = (probe: Probe) => probe.success && probe.data.draftPresent;
    const held = (): BestEffortProfileResult => ({
      refusal: "CHATGPT_COMPOSER_DRAFT_PRESENT",
      steps: { ...steps },
    });
    const goToTemporaryChat = async (): Promise<void> => {
      try {
        await ports.navigate(temporaryUrl.href, taskDeadline);
      } catch {
        // The page stays as it is; the step says so.
      }
    };

    let page = await settle(BEST_EFFORT_SETTLE_MS);

    // A draft is the owner's text: go to a new Temporary chat, whose composer
    // is empty, and send there. If that composer still has text, send nothing.
    if (draft(page)) {
      if (!navigate) return held();
      await goToTemporaryChat();
      page = await settle(BEST_EFFORT_SETTLE_MS);
      if (draft(page)) return held();
    }

    // 1. A Temporary chat, decided by its address.
    if (!(page.success && page.data.temporary) && navigate) {
      await goToTemporaryChat();
      page = await settle(BEST_EFFORT_SETTLE_MS);
      if (draft(page)) return held();
    }
    steps.temporary =
      page.success && page.data.temporary ? "temporary" : "not_temporary";

    // 2. Instant.
    const chips = page.success ? page.data.modelControlCount : undefined;
    if (page.success && chips !== undefined && chips !== 1) {
      steps.model = "model_unrecognized";
    } else if (page.success && page.data.instant) {
      steps.model = "instant";
    } else if (page.success && !page.data.modelReady) {
      // A model control that is there but not usable.
      steps.model = "instant_unavailable";
    } else if (page.success) {
      let controlsUsable = false;
      let opened = false;
      const openDeadline = bound(2_000);
      for (let attempt = 0; attempt < 20 && !opened; attempt += 1) {
        const result = await run(openInstantPowerPickerScript, taskDeadline);
        if (result === true) {
          opened = true;
          break;
        }
        if (result !== false || ports.now() >= openDeadline) break;
        await ports.delay(100);
      }
      if (opened) {
        const sliderDeadline = bound(2_000);
        for (let attempt = 0; attempt < 8; attempt += 1) {
          let slider = instantPowerSliderSchema.safeParse(
            await run(focusInstantPowerSliderScript, taskDeadline),
          );
          while (
            slider.success &&
            !slider.data.ready &&
            ports.now() < sliderDeadline
          ) {
            await ports.delay(100);
            slider = instantPowerSliderSchema.safeParse(
              await run(focusInstantPowerSliderScript, taskDeadline),
            );
          }
          if (!slider.success || !slider.data.ready) break;
          if (slider.data.atMinimum) {
            controlsUsable = true;
            break;
          }
          if ((await run(lowerInstantPowerSliderScript, taskDeadline)) !== true)
            break;
          await ports.delay(80);
        }
        // Close the menu this step opened, whatever came of it.
        await run(dismissInstantPowerPickerScript, taskDeadline);
      }
      const selectedDeadline = bound(2_000);
      page = await read(selectedDeadline);
      while (
        controlsUsable &&
        page.success &&
        !page.data.instant &&
        ports.now() < selectedDeadline
      ) {
        await ports.delay(100);
        page = await read(selectedDeadline);
      }
      if (draft(page)) return held();
      steps.model =
        page.success && page.data.instant
          ? "instant"
          : controlsUsable
            ? "other_model"
            : "instant_unavailable";
    }

    // 3. Personalization, in the legacy layout. Any other layout has no control
    // this can use, and a Temporary chat stays out of history without it.
    const personalizationDeadline = bound(PERSONALIZATION_SETTLE_MS);
    while (
      page.success &&
      !page.data.personalizationReady &&
      ports.now() < personalizationDeadline
    ) {
      await ports.delay(100);
      page = await read(personalizationDeadline);
    }
    if (page.success && page.data.personalizationReady) {
      if (page.data.personalized) {
        steps.personalization = "set";
      } else {
        let chosen = false;
        const opened =
          (await run(openTemporaryPersonalizationScript, taskDeadline)) ===
          true;
        if (opened) {
          for (let attempt = 0; attempt < 10 && !chosen; attempt += 1) {
            if (
              (await run(
                selectTemporaryPersonalizationScript,
                taskDeadline,
              )) === true
            )
              chosen = true;
            else await ports.delay(100);
          }
          if (!chosen) await run(dismissInstantPowerPickerScript, taskDeadline);
        }
        page = await read(bound(2_000));
        steps.personalization =
          chosen && page.success && page.data.personalized
            ? "set"
            : "unavailable";
      }
    }

    // The owner's text must not meet the check's, wherever it came from.
    const last = await read(bound(2_000));
    if (draft(last)) return held();
    return { refusal: null, steps: { ...steps } };
  };
}
