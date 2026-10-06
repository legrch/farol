import { computerSetup } from "./computer-setup";
import type { RendererFacade, WindowSnapshot } from "./contract";
import { Settings } from "./settings";
import { nextSetupStep, setupSteps } from "./setup-navigation";

type Props = { snapshot: WindowSnapshot; facade: RendererFacade };

export function SetupNavigation({ snapshot, facade }: Props) {
  const selected = snapshot.destination.setupStep ?? nextSetupStep(snapshot);
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
  const step = snapshot.destination.setupStep ?? nextSetupStep(snapshot);
  const index = setupSteps.findIndex(([key]) => key === step);
  const setup = computerSetup(snapshot);
  return (
    <div className="setup-page" data-setup-step={step}>
      <header className="setup-intro">
        <p className="setup-eyebrow">
          Set up this Mac · {index + 1} of {setupSteps.length}
        </p>
        <h1>{setupSteps[index]?.[1]}</h1>
        <p className="description">
          Review your saved connection and access. Opening a step makes no
          changes and runs no checks.
        </p>
      </header>
      <div hidden={step === "finish"}>
        <Settings
          snapshot={snapshot}
          facade={facade}
          setupStep={step === "finish" ? "connection" : step}
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
          Back to Home
        </button>
      </footer>
    </div>
  );
}
