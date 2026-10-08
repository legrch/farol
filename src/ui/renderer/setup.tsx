import type { RendererFacade, WindowSnapshot } from "./contract";
import { Settings } from "./settings";
import { setupChecklist, setupSteps } from "./setup-navigation";
import { adjacentSetupSection, visibleSetupSection } from "./setup-checklist";
import type { SetupCheckState, SetupSection } from "./setup-checklist";

type Props = { snapshot: WindowSnapshot; facade: RendererFacade };
const context: Record<SetupSection, { title: string; description: string }> = {
  overview: {
    title: "Setup",
    description:
      "A guided path to connect ChatGPT and decide what it can access.",
  },
  signin: {
    title: "Sign in",
    description:
      "Use your own ChatGPT account inside Farol. This step is optional for an external ChatGPT connection.",
  },
  folders: {
    title: "Workspaces",
    description: "Choose what ChatGPT can read and change.",
  },
  connection: {
    title: "Connection",
    description: "Connect this Mac using your tunnel details.",
  },
  attachment: {
    title: "Add to ChatGPT",
    description: "Add the Farol app, then check the connection from ChatGPT.",
  },
};
function CheckMark({ state }: { state: SetupCheckState | "overview" }) {
  const path =
    state === "verified"
      ? "m4 10 4 4 8-8"
      : state === "pending"
        ? "M10 3a7 7 0 1 1-7 7"
        : state === "unknown"
          ? "M10 5v6m0 3v1"
          : state === "overview"
            ? "M3 3h5v5H3zM12 3h5v5h-5zM3 12h5v5H3zM12 12h5v5h-5z"
            : "M10 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12";
  return (
    <span
      className="setup-check-mark"
      data-check-state={state}
      aria-hidden="true"
    >
      <svg viewBox="0 0 20 20">
        <path d={path} />
      </svg>
    </span>
  );
}
export function SetupNavigation({ snapshot, facade }: Props) {
  const selected = visibleSetupSection(snapshot.destination.setupStep);
  const checklist = setupChecklist(snapshot);
  return (
    <nav className="setup-checklist-navigation" aria-label="Setup steps">
      {setupSteps.map(([step, label]) => {
        const entry = checklist.entries.find((item) => item.step === step);
        return (
          <button
            key={step}
            type="button"
            aria-label={label}
            aria-description={entry?.status}
            aria-current={step === selected ? "step" : undefined}
            onClick={() => facade.navigate({ area: "setup", setupStep: step })}
          >
            <CheckMark state={entry?.state ?? "overview"} />
            <span>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
/** Presentation over existing Settings commands. No action executes on mount. */
export function Setup({ snapshot, facade }: Props) {
  const step = visibleSetupSection(snapshot.destination.setupStep);
  const checklist = setupChecklist(snapshot);
  const previous = adjacentSetupSection(step, -1);
  const next = adjacentSetupSection(step, 1);
  return (
    <div className="setup-page setup-wizard" data-setup-step={step}>
      <header className="setup-wizard-intro">
        <h1 className="setup-visually-hidden">{context[step].title}</h1>
        <p className="description">{context[step].description}</p>
      </header>
      {step === "overview" && (
        <section className="setup-checklist" aria-label="Setup overview">
          {checklist.entries.map((entry) => (
            <article
              className="setup-checklist-row"
              key={entry.step}
              data-setup-check={entry.step}
            >
              <CheckMark state={entry.state} />
              <div className="setup-checklist-copy">
                <h2>
                  {entry.label}
                  {entry.optional && (
                    <span className="setup-optional-tag">Optional</span>
                  )}
                </h2>
                <p className="description">{entry.description}</p>
                <p
                  className="setup-check-status"
                  data-check-state={entry.state}
                >
                  {entry.status}
                </p>
              </div>
              <button
                type="button"
                className="setup-review-button"
                aria-label={`${entry.action} ${entry.label}`}
                onClick={() =>
                  facade.navigate({ area: "setup", setupStep: entry.step })
                }
              >
                {entry.action}
              </button>
            </article>
          ))}
          <p className="description setup-checklist-note">
            After setup, Home is your everyday starting point. Sign-in inside
            Farol is optional when you use ChatGPT outside the app.
          </p>
          {checklist.ready && (
            <button
              type="button"
              className="primary"
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
          )}
        </section>
      )}
      {/* Keep the same Settings component mounted so pending drafts/receipts survive navigation. */}
      <div className="setup-panel" hidden={step === "overview"}>
        <Settings
          snapshot={snapshot}
          facade={facade}
          setupStep={step === "overview" ? "connection" : step}
        />
      </div>
      {step !== "overview" && (
        <footer className="setup-wizard-footer">
          {previous && (
            <button
              type="button"
              className="subtle"
              onClick={() =>
                facade.navigate({ area: "setup", setupStep: previous })
              }
            >
              Previous
            </button>
          )}
          <button
            type="button"
            className="primary"
            onClick={() =>
              facade.navigate({ area: "setup", setupStep: next ?? "overview" })
            }
          >
            {next ? "Continue" : "Review setup"}
          </button>
        </footer>
      )}
    </div>
  );
}
