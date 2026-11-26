import { useId } from "react";
import { Group, type PageProps } from "./page";

export function AppearancePage({ snapshot, facade }: PageProps) {
  const appearance = snapshot.appearance;
  const typefaceId = useId();
  return (
    <div className="appearance-page">
      <p className="appearance-intro">
        One interface, in the light that feels right for you.
      </p>
      <Group title="Interface appearance" showTitle={false}>
        <div className="appearance-row appearance-theme">
          <div className="appearance-copy">
            <h3>Theme</h3>
            <p>System follows the appearance of your Mac.</p>
          </div>
          <div className="theme-choices" role="group" aria-label="Theme">
            {(["light", "graphite", "system"] as const).map((theme) => (
              <button
                type="button"
                key={theme}
                className="theme-choice"
                aria-pressed={appearance.theme === theme}
                onClick={() =>
                  facade.appearance({
                    ...facade.getSnapshot().appearance,
                    theme,
                  })
                }
              >
                <span className={`theme-preview ${theme}`} aria-hidden="true" />
                {theme === "light"
                  ? "Light"
                  : theme === "graphite"
                    ? "Graphite"
                    : "System"}
              </button>
            ))}
          </div>
        </div>
        <div className="appearance-row">
          <div className="appearance-copy">
            <h3>Accent color</h3>
            <p>
              Highlights selection, focus and primary actions. Status stays
              distinct.
            </p>
          </div>
          <div
            className="accent-choices"
            role="group"
            aria-label="Accent color"
          >
            {(["iris", "cobalt", "amber"] as const).map((accent) => {
              const label =
                accent === "iris"
                  ? "Iris"
                  : accent === "cobalt"
                    ? "Cobalt"
                    : "Amber";
              return (
                <button
                  type="button"
                  key={accent}
                  className={`accent-choice ${accent}`}
                  aria-label={`${label} accent`}
                  aria-pressed={appearance.accent === accent}
                  onClick={() =>
                    facade.appearance({
                      ...facade.getSnapshot().appearance,
                      accent,
                    })
                  }
                >
                  <span className="accent-dot" aria-hidden="true" />
                  {label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="appearance-row">
          <div className="appearance-copy">
            <h3>
              <label htmlFor={typefaceId}>Typeface</label>
            </h3>
            <p>
              Geist gives Farol a consistent voice. System follows your
              platform.
            </p>
          </div>
          <select
            id={typefaceId}
            aria-label="Typeface"
            className="field"
            value={appearance.font}
            onChange={(event) =>
              facade.appearance({
                ...facade.getSnapshot().appearance,
                font: event.currentTarget.value as typeof appearance.font,
              })
            }
          >
            <option value="geist">Geist</option>
            <option value="system">System</option>
          </select>
        </div>
      </Group>
      <p className="description">
        Changes apply immediately. You can change them again at any time.
      </p>
    </div>
  );
}
