import { useRef, useState } from "react";
import { setupStepCheck } from "./setup-gate";
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
      "ChatGPT can see only the workspaces you add here. Every change it wants to make still asks you first.",
  },
  connection: {
    title: "Connect this Mac",
    description: "You need two things from OpenAI: a tunnel ID and its key.",
  },
  attachment: {
    title: "Add Farol to ChatGPT",
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
          <li key={entry.step} data-check-state={entry.state}>
            <button
              type="button"
              className="setup-progress-step"
              aria-label={`${index + 1}. ${entry.label}${entry.state === "verified" ? ", completed" : ""}`}
              aria-current={entry.step === selected ? "step" : undefined}
              onClick={() => onNavigate(entry.step)}
            >
              <span aria-hidden="true">
                {entry.state === "verified" && entry.step !== selected
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
  const local = useSetupIntents(facade, snapshot);
  const checklist = setupChecklist(snapshot, inputsChanged, local);
  const completedCount = checklist.entries.filter(
    (entry) => entry.state === "verified",
  ).length;
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
          {step === "overview" && completedCount > 0
            ? "Your setup"
            : context[step].title}
        </h1>
        <p className="description">
          {step === "overview" && completedCount > 0
            ? "Your progress is saved. Review any step or finish the remaining setup."
            : context[step].description}
        </p>
      </header>
      {step === "overview" && (
        <section className="setup-welcome" aria-label="Setup overview">
          <div className="setup-overview-summary" role="status">
            <strong>{completedCount} of 4 steps ready</strong>
            <p className="description">
              {checklist.ready
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
              <li key={entry.step} data-check-state={entry.state}>
                <button
                  type="button"
                  className="setup-overview-step"
                  aria-label={entry.label}
                  aria-describedby={`setup-overview-${entry.step}-status`}
                  onClick={() => navigateToStep(entry.step)}
                >
                  <span className="setup-overview-marker" aria-hidden="true">
                    {entry.state === "verified" ? "✓" : index + 1}
                  </span>
                  <span className="setup-overview-copy">
                    <strong>{entry.label}</strong>
                    <span
                      className="description"
                      id={`setup-overview-${entry.step}-status`}
                    >
                      {entry.state === "verified"
                        ? {
                            signin: "Signed in to ChatGPT",
                            folders: "Workspace access checked",
                            connection: "Tunnel connected",
                            attachment: "App confirmed in ChatGPT",
                          }[entry.step]
                        : entry.state === "pending"
                          ? "Checking…"
                          : entry.state === "unknown"
                            ? "Waiting for confirmation"
                            : {
                                signin: "Sign in with your ChatGPT account",
                                folders: "Choose folders for ChatGPT",
                                connection: "Connect this Mac with your tunnel",
                                attachment:
                                  "Add your app and confirm the connection",
                              }[entry.step]}
                    </span>
                  </span>
                  <span className="setup-overview-state">
                    {entry.state === "verified"
                      ? "Ready"
                      : entry.state === "pending"
                        ? "Checking"
                        : entry.state === "needed"
                          ? "Set up"
                          : "Review"}
                  </span>
                </button>
              </li>
            ))}
          </ol>
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
            {checklist.ready
              ? "Review setup"
              : checklist.entries.some((entry) => entry.state === "verified")
                ? "Continue setup"
                : "Start setup"}
          </button>
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
          <button
            type="button"
            className="primary"
            disabled={!passed || (step === "attachment" && !checklist.ready)}
            onClick={async () => {
              const latest = facade.getSnapshot();
              if (
                latest.destination.area !== "setup" ||
                visibleSetupSection(latest.destination.setupStep) !== step
              )
                return;
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
            {next ? "Continue" : "Start using Farol"}
          </button>
        </footer>
      )}
    </div>
  );
}
