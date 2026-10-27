import { useRef, useState } from "react";
import { connectorVerificationInFlight, setupStepCheck } from "./setup-gate";
import type { RendererFacade, WindowSnapshot } from "./contract";
import { Settings, retainedSetupIntents, useSetupIntents } from "./settings";
import { setupChecklist } from "./setup-navigation";
import { adjacentSetupSection, visibleSetupSection } from "./setup-checklist";
import type { SetupSection } from "./setup-checklist";

type Props = { snapshot: WindowSnapshot; facade: RendererFacade };
const context: Record<SetupSection, { title: string; description: string }> = {
  overview: {
    title: "Welcome to Farol",
    description:
      "Let ChatGPT work with workspaces on this Mac. Setup takes about five minutes, and every step checks itself.",
  },
  signin: {
    title: "Sign in to ChatGPT",
    description:
      "Use your own ChatGPT account. Farol checks sign-in before you continue.",
  },
  folders: {
    title: "Choose workspaces",
    description:
      "Farol enforces the workspace access you approve here. ChatGPT manages action confirmations.",
  },
  connection: {
    title: "Connect this Mac",
    description: "You need two things from OpenAI: a tunnel ID and its key.",
  },
  attachment: {
    title: "4. Add Farol to ChatGPT",
    description:
      "Create the app in ChatGPT with your tunnel, then test it end to end.",
  },
};
/** Inline, read-only progress. Navigation cannot bypass a step's check. */
export function SetupNavigation({
  snapshot,
  facade,
  inputsChanged = false,
  onNavigate,
}: Props & {
  inputsChanged?: boolean;
  onNavigate: (step: SetupSection) => void;
}) {
  const local = useSetupIntents(facade, snapshot);
  const selected = visibleSetupSection(snapshot.destination.setupStep);
  return (
    <ol className="setup-progress" aria-label="Setup progress">
      <li>
        <button
          type="button"
          className="setup-progress-step"
          aria-current={selected === "overview" ? "step" : undefined}
          onClick={() => onNavigate("overview")}
        >
          Overview
        </button>
      </li>
      {setupChecklist(snapshot, inputsChanged, local).entries.map(
        (entry, index) => (
          <li key={entry.step} data-check-state={entry.liveState}>
            <button
              type="button"
              className="setup-progress-step"
              aria-label={`${index + 1}. ${entry.label}${entry.liveState === "verified" ? ", completed" : ""}`}
              aria-current={entry.step === selected ? "step" : undefined}
              onClick={() => onNavigate(entry.step)}
            >
              <span aria-hidden="true">
                {entry.liveState === "verified" && entry.step !== selected
                  ? "✓"
                  : index + 1}
              </span>{" "}
              {entry.label}
            </button>
          </li>
        ),
      )}
    </ol>
  );
}
export function Setup({ snapshot, facade }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const step = visibleSetupSection(snapshot.destination.setupStep);
  const [inputsChanged, setInputsChanged] = useState(false);
  const changed = useRef(false);
  const [testActionHost, setTestActionHost] = useState<HTMLElement | null>(
    null,
  );
  const local = useSetupIntents(facade, snapshot);
  const checklist = setupChecklist(snapshot, inputsChanged, local);
  const finishPending =
    snapshot.intents["settings:setup.progress:"]?.state === "pending";
  const completedCount = checklist.entries.filter(
    (entry) => entry.liveState === "verified",
  ).length;
  const setupChecking = connectorVerificationInFlight(snapshot, local);
  const returnDestination = snapshot.setupReturn ?? { area: "home" as const };
  const returnLabel = `Back to ${{ home: "Home", chatgpt: "ChatGPT", activity: "Activity", settings: "Settings", setup: "Setup" }[returnDestination.area]}`;
  const previous = adjacentSetupSection(step, -1);
  const next = adjacentSetupSection(step, 1);
  function navigateToStep(setupStep: SetupSection) {
    // Shell owns scrolling in this main element and remembers per-destination
    // positions. Reset it before changing setup destination so a reviewed step
    // opens at its title even when the previous step was scrolled down.
    const stage = root.current?.closest<HTMLElement>("main.stage");
    if (stage) {
      stage.scrollTop = 0;
      stage.scrollLeft = 0;
    }
    facade.navigate({ area: "setup", setupStep });
  }
  const passed =
    step !== "overview" &&
    setupStepCheck(
      snapshot,
      step,
      inputsChanged && (step === "connection" || step === "attachment"),
      local,
    ).allowed;
  return (
    <div ref={root} className="setup-page setup-wizard" data-setup-step={step}>
      <SetupNavigation
        snapshot={snapshot}
        facade={facade}
        inputsChanged={inputsChanged}
        onNavigate={navigateToStep}
      />
      <header className="setup-wizard-intro">
        <h1>
          {step === "overview" && (checklist.completed || completedCount > 0)
            ? "Your setup"
            : context[step].title}
        </h1>
        <p className="description">
          {step === "overview" && (checklist.completed || completedCount > 0)
            ? checklist.completed
              ? "Setup is complete. Current connection checks are shown on Home."
              : "Your progress is saved. Review any step or finish the remaining setup."
            : context[step].description}
        </p>
      </header>
      {step === "overview" && (
        <section className="setup-welcome" aria-label="Setup overview">
          <div className="setup-overview-summary" role="status">
            <strong>
              {checklist.completed
                ? "Setup complete"
                : `${completedCount} of 4 steps ready`}
            </strong>
            <p className="description">
              {checklist.completed
                ? setupChecking
                  ? `Checking your setup. ${completedCount} of 4 current checks are ready.`
                  : `Setup was completed. ${completedCount} of 4 current checks are ready.`
                : checklist.ready
                  ? "Everything is ready. You can review any step."
                  : checklist.entries
                        .slice(0, 3)
                        .every((entry) => entry.state === "verified")
                    ? "Your Mac is ready. Confirm the app in ChatGPT to finish setup."
                    : "Follow the steps below. Your progress is saved as you go."}
            </p>
          </div>
          <ol>
            {checklist.entries.map((entry, index) => (
              <li key={entry.step} data-check-state={entry.liveState}>
                <button
                  type="button"
                  className="setup-overview-step"
                  aria-label={entry.label}
                  aria-describedby={`setup-overview-${entry.step}-status`}
                  onClick={() => navigateToStep(entry.step)}
                >
                  <span className="setup-overview-marker" aria-hidden="true">
                    {entry.liveState === "verified" ? "✓" : index + 1}
                  </span>
                  <span className="setup-overview-copy">
                    <strong>{entry.label}</strong>
                    <span
                      className="description"
                      id={`setup-overview-${entry.step}-status`}
                    >
                      {entry.liveState === "verified"
                        ? {
                            signin: "Signed in to ChatGPT",
                            folders: "Workspace access checked",
                            connection: "Tunnel connected",
                            attachment: "App confirmed in ChatGPT",
                          }[entry.step]
                        : entry.liveState === "pending"
                          ? "Checking…"
                          : entry.liveState === "unknown"
                            ? "Waiting for confirmation"
                            : checklist.completed
                              ? {
                                  signin: "Check sign-in in ChatGPT",
                                  folders: "Check workspace access",
                                  connection:
                                    "Check the connection to this Mac",
                                  attachment:
                                    "Check the app connection in ChatGPT",
                                }[entry.step]
                              : {
                                  signin: "Sign in with your ChatGPT account",
                                  folders: "Choose folders for ChatGPT",
                                  connection:
                                    "Connect this Mac with your tunnel",
                                  attachment:
                                    "Add your app and confirm the connection",
                                }[entry.step]}
                    </span>
                  </span>
                  <span className="setup-overview-state">
                    {entry.liveState === "verified"
                      ? "Ready"
                      : entry.liveState === "pending"
                        ? "Checking"
                        : entry.liveState === "needed"
                          ? "Set up"
                          : "Review"}
                  </span>
                </button>
              </li>
            ))}
          </ol>
          {!checklist.completed && (
            <button
              type="button"
              className="primary"
              onClick={() =>
                navigateToStep(
                  checklist.entries.find((entry) => entry.state !== "verified")
                    ?.step ?? "attachment",
                )
              }
            >
              {checklist.completed || checklist.ready
                ? "Review setup"
                : checklist.entries.some((entry) => entry.state === "verified")
                  ? "Continue setup"
                  : "Start setup"}
            </button>
          )}
          <button
            type="button"
            className="text-button"
            onClick={() =>
              void facade.configure(
                { kind: "onboarding.open-help", destination: "setup-guide" },
                "setup:guide",
              )
            }
          >
            Read the setup guide
          </button>
        </section>
      )}
      {/* Preserve connection drafts and unresolved receipts across step navigation. */}
      <div className="setup-panel" hidden={step === "overview"}>
        <Settings
          snapshot={snapshot}
          facade={facade}
          setupStep={step === "overview" ? "connection" : step}
          setupInputsChanged={inputsChanged}
          setupTestActionHost={testActionHost}
          onSetupInputsChange={(dirty) => {
            changed.current = dirty;
            setInputsChanged(dirty);
          }}
        />
      </div>
      {snapshot.intents["settings:setup.progress:"]?.code ===
        "SETUP_INCOMPLETE" && (
        <p role="status">Finish the remaining steps before using Farol.</p>
      )}
      {step !== "overview" && (
        <footer className="setup-wizard-footer">
          <button
            type="button"
            className="subtle"
            onClick={() => navigateToStep(previous ?? "overview")}
          >
            Back
          </button>
          {step === "attachment" &&
          !checklist.ready &&
          !finishPending &&
          (!checklist.completed || returnDestination.area === "home") ? (
            <div ref={setTestActionHost} className="setup-test-action-slot" />
          ) : (
            <button
              type="button"
              className="primary"
              disabled={
                !checklist.completed &&
                (!passed || (step === "attachment" && !checklist.ready))
              }
              onClick={async () => {
                const latest = facade.getSnapshot();
                if (
                  latest.destination.area !== "setup" ||
                  visibleSetupSection(latest.destination.setupStep) !== step
                )
                  return;
                if (
                  latest.configuration?.status === "ready" &&
                  latest.configuration.settings.setup.journey.dismissed
                ) {
                  if (next) navigateToStep(next);
                  else
                    facade.navigate(
                      latest.setupReturn ?? {
                        area: "home",
                        homeView: "overview",
                        homeSelection: null,
                      },
                    );
                  return;
                }
                const local = retainedSetupIntents(facade, latest);
                const current = setupChecklist(latest, changed.current, local);
                if (
                  !setupStepCheck(
                    latest,
                    step,
                    changed.current &&
                      (step === "connection" || step === "attachment"),
                    local,
                  ).allowed
                )
                  return;
                if (next) navigateToStep(next);
                else if (current.ready) {
                  const result = await facade.configure(
                    {
                      kind: "setup.progress",
                      currentStep: "connect",
                      dismissed: true,
                    },
                    "settings:setup.progress:",
                  );
                  const saved = facade.getSnapshot();
                  if (
                    result.state === "applied" &&
                    saved.configuration?.status === "ready" &&
                    saved.configuration.settings.setup.journey.dismissed &&
                    saved.destination === latest.destination
                  )
                    facade.navigate({
                      area: "home",
                      homeView: "overview",
                      homeSelection: null,
                    });
                }
              }}
            >
              {checklist.completed
                ? next
                  ? "Next"
                  : returnLabel
                : next
                  ? "Continue"
                  : "Start using Farol"}
            </button>
          )}
        </footer>
      )}
    </div>
  );
}
