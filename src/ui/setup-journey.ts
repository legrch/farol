export type SetupStep = Readonly<{
  id: "chatgpt" | "computer" | "connect" | "hosts" | "verify";
  eyeline: string;
  title: string;
  copy: string;
  details: readonly string[];
}>;

export type SetupJourney = Readonly<{
  open: boolean;
  mode: "first-run" | "review";
  step: number;
}>;

export const setupSteps: readonly SetupStep[] = [
  {
    id: "chatgpt",
    eyeline: "ChatGPT",
    title: "Sign in on the isolated Next route",
    copy: "Open the dedicated ChatGPT window, sign in there, then deliberately check that the real composer is available. Farol Next never borrows another application's cookies or profile.",
    details: [
      "The persistent partition belongs only to Farol Next.",
      "Readiness stores only a content-free result; credentials, page text, conversations, prompts, and answers are never copied into settings.",
    ],
  },
  {
    id: "computer",
    eyeline: "Computer",
    title: "Confirm what This Mac may expose",
    copy: "Computer access starts closed and capability-bound. Choose a folder with the native picker, then verify its read-only boundary before a task may use it.",
    details: [
      "This verification lists only the selected workspace root; it does not read file contents.",
      "Writes require a separate per-workspace grant. Commands and screenshots remain unavailable.",
    ],
  },
  {
    id: "connect",
    eyeline: "Connect",
    title: "Configure the Next-owned route",
    copy: "A Computer connection is ready only after its Next-owned endpoint is saved, reached, and verified. Local shell transport alone is not connection proof.",
    details: [
      "The isolated local shell runtime is available.",
      "No Computer endpoint, tunnel, global registration, or login item is configured yet.",
    ],
  },
  {
    id: "hosts",
    eyeline: "Codex and Agent apps",
    title: "Choose and verify the native Codex host",
    copy: "Select the exact Codex executable Farol Next may start. The app runs only a bounded version and App Server schema probe, then stores the verified executable and contract digests for rechecking.",
    details: [
      "A successful probe proves host compatibility, not task or Agent completion.",
      "Native Agent creation and a real Consult have not been exercised.",
    ],
  },
  {
    id: "verify",
    eyeline: "Verify",
    title: "Know exactly what is ready",
    copy: "Readiness is recorded per capability. A workspace counts only after the native read-only check; live ChatGPT, Computer routing, and native hosts remain separate gates.",
    details: [
      "Ready when shown: local shell runtime and explicitly verified workspace boundary.",
      "Not run: live provider, Next-owned Computer route, native Codex, and native Agent.",
    ],
  },
];

export function createSetupJourney(
  initial: Readonly<{ open?: boolean; step?: number }> = {},
): SetupJourney {
  const step = Math.min(
    setupSteps.length - 1,
    Math.max(0, Math.trunc(initial.step ?? 0)),
  );
  return { open: initial.open ?? true, mode: "first-run", step };
}

export function advanceSetup(journey: SetupJourney): SetupJourney {
  if (!journey.open) return journey;
  if (journey.step >= setupSteps.length - 1) {
    return { ...journey, open: false, step: setupSteps.length - 1 };
  }
  return { ...journey, step: journey.step + 1 };
}

export function retreatSetup(journey: SetupJourney): SetupJourney {
  if (!journey.open || journey.step === 0) return journey;
  return { ...journey, step: journey.step - 1 };
}

export function reopenSetup(journey: SetupJourney): SetupJourney {
  return { open: true, mode: "review", step: journey.step };
}
