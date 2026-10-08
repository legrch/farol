import { computerSetup } from "./computer-setup";
import type { RendererFacade, SetupStep, WindowSnapshot } from "./contract";
import { Settings } from "./settings";
import { nextSetupStep, setupSteps } from "./setup-navigation";

type Props = { snapshot: WindowSnapshot; facade: RendererFacade };

const stepContext: Record<SetupStep, { title: string; description: string }> = {
  overview: {
    title: "Setup",
    description:
      "A guided path to connect ChatGPT and decide what it can access.",
  },
  folders: {
    title: "Workspaces",
    description:
      "Choose the workspaces Farol may access, review each access level, then verify a workspace. Removing access keeps its files.",
  },
  connection: {
    title: "Connection",
    description:
      "Connect this Mac using your tunnel details. A local connection and access from ChatGPT have separate checks.",
  },
  attachment: {
    title: "Add to ChatGPT",
    description:
      "Add this connection in ChatGPT, then send the current verification request to check access.",
  },
  finish: {
    title: "Finish",
    description: "Review the recorded checks, then open Home for everyday use.",
  },
};

export function SetupNavigation({ snapshot, facade }: Props) {
  const selected = snapshot.destination.setupStep ?? "overview";
  return (
    <nav aria-label="Setup steps">
      {setupSteps.map(([step, label], index) => (
        <button
          key={step}
          aria-label={label}
          aria-current={step === selected ? "step" : undefined}
          onClick={() => facade.navigate({ area: "setup", setupStep: step })}
        >
          <span className="setup-step-number">{index + 1}</span>
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

/** Guided presentation of Settings' existing commands and retained evidence. */
export function Setup({ snapshot, facade }: Props) {
  const step = snapshot.destination.setupStep ?? "overview";
  const index = setupSteps.findIndex(([key]) => key === step);
  const setup = computerSetup(snapshot);
  return (
    <div className="setup-page" data-setup-step={step}>
      <header className="setup-intro">
        <p className="setup-eyebrow">
          Set up this Mac · {index + 1} of {setupSteps.length}
        </p>
        <h1>{stepContext[step].title}</h1>
        <p className="description">{stepContext[step].description}</p>
      </header>
      {step === "overview" && (
        <section className="setup-overview" aria-label="Setup overview">
          {!setup.ready && <span className="badges">{setup.label}</span>}
          <h2>{setup.ready ? "Computer ready" : "Set up Computer"}</h2>
          <p>{setup.next}</p>
          <div className="setup-overview-steps">
            {(
              [
                [
                  "folders",
                  "Workspaces",
                  "Choose folders and access for each one.",
                  setup.workspacesVerified
                    ? "Workspace verified"
                    : "Workspace check needed",
                ],
                [
                  "connection",
                  "Connection",
                  "Connect this Mac to ChatGPT.",
                  setup.localConnectionCurrent
                    ? "Local connection current"
                    : "Connection check needed",
                ],
                [
                  "attachment",
                  "Add to ChatGPT",
                  "Add the connection and review verification.",
                  setup.externalAccessVerified
                    ? "External access verified"
                    : "External verification needed",
                ],
              ] as const
            ).map(([destination, label, description, status], position) => (
              <div className="setup-overview-row" key={destination}>
                <span className="setup-overview-number" aria-hidden="true">
                  {position + 1}
                </span>
                <span className="setup-overview-copy">
                  <strong>{label}</strong>
                  <small>{description}</small>
                  <small>{status}</small>
                </span>
                <button
                  className="subtle"
                  onClick={() =>
                    facade.navigate({ area: "setup", setupStep: destination })
                  }
                >
                  {setup.ready ? "Review" : "Open"} {label}
                </button>
              </div>
            ))}
          </div>
          <button
            className="primary"
            onClick={() =>
              facade.navigate({
                area: "setup",
                setupStep: setup.ready ? "folders" : nextSetupStep(snapshot),
              })
            }
          >
            {setup.ready ? "Review workspaces" : "Continue setup"}
          </button>
          <p className="description setup-optional">
            Embedded ChatGPT sign-in is optional for Computer access from
            ChatGPT. You can review it in Settings → Connection.
          </p>
        </section>
      )}
      <div hidden={step === "finish" || step === "overview"}>
        <Settings
          snapshot={snapshot}
          facade={facade}
          setupStep={
            step === "finish" || step === "overview" ? "connection" : step
          }
        />
      </div>
      <section
        className="setup-finish"
        hidden={step !== "finish"}
        aria-label="Computer setup status"
      >
        {!setup.ready && <span className="badges">{setup.label}</span>}
        <h2>{setup.ready ? "Computer ready" : "A few checks remain"}</h2>
        <p>{setup.next}</p>
        <p className="description">
          Folder access, the local connection and verification from ChatGPT have
          separate checks. Embedded ChatGPT sign-in and Model configuration are
          optional.
        </p>
        {!setup.ready && (
          <button
            className="primary"
            onClick={() =>
              facade.navigate({
                area: "setup",
                setupStep: nextSetupStep(snapshot),
              })
            }
          >
            Continue setup
          </button>
        )}
      </section>
      <footer className="setup-navigation">
        <p className="description setup-navigation-note">
          Opening a step does not change access or run a check.
        </p>
        <button
          className="subtle"
          disabled={index === 0}
          onClick={() =>
            facade.navigate({
              area: "setup",
              setupStep: setupSteps[index - 1]![0],
            })
          }
        >
          Previous step
        </button>
        {index > 0 && index < setupSteps.length - 1 && (
          <button
            className="primary"
            onClick={() =>
              facade.navigate({
                area: "setup",
                setupStep: setupSteps[index + 1]![0],
              })
            }
          >
            Continue
          </button>
        )}
        <button
          className="text-button"
          onClick={() =>
            facade.navigate({
              area: "home",
              homeView: "overview",
              homeSelection: null,
            })
          }
        >
          Open Home
        </button>
      </footer>
    </div>
  );
}
