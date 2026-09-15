export type SetupStep = Readonly<{
  id: "chatgpt" | "computer" | "connect" | "hosts" | "verify";
  eyeline: string;
  title: string;
  copy: string;
  status: string;
  tone: "available" | "limited" | "blocked";
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
    title: "Keep the signed-in route separate",
    copy: "Farol Next will use its own authenticated Browser route. This preview never borrows or changes the installed provider profile.",
    status: "Not connected",
    tone: "blocked",
    details: [
      "The controlled local provider remains available for this preview.",
      "No ChatGPT login, cookies, or provider slot are read from the old lane.",
    ],
  },
  {
    id: "computer",
    eyeline: "Computer",
    title: "Confirm what This Mac may expose",
    copy: "Computer access starts closed and capability-bound. The preview offers one synthetic fixture check and nothing from your filesystem.",
    status: "Preview only",
    tone: "limited",
    details: [
      "Available: synthetic workspace status after explicit approval.",
      "Unavailable: files, commands, screenshots, and native host actions.",
    ],
  },
  {
    id: "connect",
    eyeline: "Connect",
    title: "Use the isolated local runtime",
    copy: "The desktop shell and its utility runtime communicate over an OS-assigned loopback endpoint with per-run capabilities.",
    status: "Local only",
    tone: "available",
    details: [
      "Two task surfaces have distinct read capabilities and retained state.",
      "No tunnel, global MCP registration, login item, or update channel is enabled.",
    ],
  },
  {
    id: "hosts",
    eyeline: "Codex and Agent apps",
    title: "Leave native hosts untouched",
    copy: "Host integrations require their own bounded live proof. They remain disabled instead of being inferred from configuration files.",
    status: "Not configured",
    tone: "blocked",
    details: [
      "Native Codex task creation has not been exercised.",
      "Native Agent creation and a real Consult have not been exercised.",
    ],
  },
  {
    id: "verify",
    eyeline: "Verify",
    title: "Know exactly what is ready",
    copy: "The local Browser stream and fixture Computer round-trip are available. Live ChatGPT, native hosts, and filesystem access remain separate gates.",
    status: "Verified locally",
    tone: "available",
    details: [
      "Ready here: isolated Browser tasks, local streaming, Activity, and fixture Computer.",
      "Not run: live provider, native Codex, native Agent, and local filesystem.",
    ],
  },
];

export function createSetupJourney(): SetupJourney {
  return { open: true, mode: "first-run", step: 0 };
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

export function reopenSetup(_journey: SetupJourney): SetupJourney {
  return { open: true, mode: "review", step: 0 };
}
