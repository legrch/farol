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
}: Props & { inputsChanged?: boolean }) {
  const local = useSetupIntents(facade, snapshot);
  const selected = visibleSetupSection(snapshot.destination.setupStep);
  if (selected === "overview") return null;
  return (
    <ol className="setup-progress" aria-label="Setup progress">
      {setupChecklist(snapshot, inputsChanged, local).entries.map(
        (entry, index) => (
          <li
            key={entry.step}
            aria-current={entry.step === selected ? "step" : undefined}
            data-check-state={entry.state}
          >
            <span aria-hidden="true">
              {entry.state === "verified" && entry.step !== selected
                ? "✓"
                : index + 1}
            </span>{" "}
            {entry.label}
          </li>
        ),
      )}
    </ol>
  );
}
export function Setup({ snapshot, facade }: Props) {
  const step = visibleSetupSection(snapshot.destination.setupStep);
  const [inputsChanged, setInputsChanged] = useState(false);
  const changed = useRef(false);
  const local = useSetupIntents(facade, snapshot);
  const checklist = setupChecklist(snapshot, inputsChanged, local);
  const previous = adjacentSetupSection(step, -1);
  const next = adjacentSetupSection(step, 1);
  const passed =
    step !== "overview" &&
    setupStepCheck(
      snapshot,
      step,
      inputsChanged && (step === "connection" || step === "attachment"),
      local,
    ).allowed;
  return (
    <div className="setup-page setup-wizard" data-setup-step={step}>
      <SetupNavigation
        snapshot={snapshot}
        facade={facade}
        inputsChanged={inputsChanged}
      />
      <header className="setup-wizard-intro">
        <h1>{context[step].title}</h1>
        <p className="description">{context[step].description}</p>
      </header>
      {step === "overview" && (
        <section className="setup-welcome" aria-label="Setup overview">
          <ol>
            <li>Sign in to ChatGPT</li>
            <li>Choose workspaces</li>
            <li>Connect this Mac</li>
            <li>Add Farol to ChatGPT and test it</li>
          </ol>
          <button
            type="button"
            className="primary"
            onClick={() =>
              facade.navigate({ area: "setup", setupStep: "signin" })
            }
          >
            Start setup
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
      {step !== "overview" && (
        <footer className="setup-wizard-footer">
          <button
            type="button"
            className="subtle"
            onClick={() =>
              facade.navigate({
                area: "setup",
                setupStep: previous ?? "overview",
              })
            }
          >
            Back
          </button>
          <button
            type="button"
            className="primary"
            disabled={!passed || (step === "attachment" && !checklist.ready)}
            onClick={() => {
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
              if (next) facade.navigate({ area: "setup", setupStep: next });
              else if (current.ready)
                facade.navigate({
                  area: "home",
                  homeView: "overview",
                  homeSelection: null,
                });
            }}
          >
            {next ? "Continue" : "Start using Farol"}
          </button>
        </footer>
      )}
    </div>
  );
}
