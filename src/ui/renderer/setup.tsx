import { computerSetup } from "./computer-setup";
import type { RendererFacade, WindowSnapshot } from "./contract";
import { Settings } from "./settings";
import { nextSetupStep, setupSteps } from "./setup-navigation";

type Props = { snapshot: WindowSnapshot; facade: RendererFacade };

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
        <p className="description">
          Review your connection and workspace access. Opening a step does not
          change permissions or repeat a check.
        </p>
      </header>
      {step === "overview" && (
        <section className="setup-overview" aria-label="Setup overview">
          <span className="badges">{setup.label}</span>
          <h2>{setup.ready ? "Computer ready" : "Set up Computer"}</h2>
          <p>{setup.next}</p>
          <p className="description">
            Embedded ChatGPT sign-in is optional for Computer access from
            ChatGPT.
          </p>
          <div className="setup-overview-steps">
            {(
              [
                [
                  "folders",
                  "Workspaces",
                  setup.workspacesVerified
                    ? "Workspace verified"
                    : "Workspace check needed",
                ],
                [
                  "connection",
                  "Connection",
                  setup.localConnectionCurrent
                    ? "Local connection current"
                    : "Connection check needed",
                ],
                [
                  "attachment",
                  "Add to ChatGPT",
                  setup.externalAccessVerified
                    ? "External access verified"
                    : "External verification needed",
                ],
              ] as const
            ).map(([destination, label, status]) => (
              <div className="setup-overview-row" key={destination}>
                <span>
                  <strong>{label}</strong>
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
        <span className="badges">{setup.label}</span>
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
        <button
          className={setup.ready ? "primary" : "subtle"}
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
      </section>
      <footer className="setup-navigation">
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
        {index < setupSteps.length - 1 && (
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
