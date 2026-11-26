import { useSettingsFeedback, useSetupIntents } from "./intents";
import { Command, type Actions, type SettingsProps } from "./page";
import { WorkspaceEditResults } from "./results";
import { unresolvedActions } from "./unresolved-actions";

export function UnresolvedActionsContent({
  snapshot,
  facade,
  actions,
}: SettingsProps & { actions: Actions }) {
  const retained = useSetupIntents(facade, snapshot);
  const feedback = useSettingsFeedback(facade);
  const rows = unresolvedActions(snapshot, retained);
  const settings =
    snapshot.configuration?.status === "ready"
      ? snapshot.configuration.settings
      : null;
  const evidence =
    settings && snapshot.evidence?.revision === settings.revision
      ? snapshot.evidence.value
      : null;
  return (
    <>
      {rows.length === 0 ? (
        <p role="status">No unresolved actions.</p>
      ) : (
        <ul aria-label="Unresolved operations">
          {rows.map((row) => (
            <li key={row.id}>
              <h3>{row.label}</h3>
              {row.id === "update-recovery" &&
                snapshot.environment === "preview" && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => facade.overlay("update-recovery")}
                  >
                    Review recovery options
                  </button>
                )}
              <p>
                {row.state === "pending" ? "Pending" : "Outcome unknown"}.{" "}
                {row.cause}
              </p>
              <p className="description">
                <code>{row.id}</code>
                {row.code ? (
                  <>
                    {" "}
                    · <code>{row.code}</code>
                  </>
                ) : null}
              </p>
              {Object.values(feedback.pages)
                .filter((entry) => entry?.result?.id === row.id)
                .map(
                  (entry) =>
                    entry && (
                      <button
                        key={row.id}
                        type="button"
                        className="text-button"
                        onClick={() => {
                          facade.overlay("none");
                          facade.navigate(
                            entry.origin.area === "setup"
                              ? {
                                  area: "setup",
                                  setupStep:
                                    entry.origin.setupStep ?? "overview",
                                }
                              : { area: "settings", page: entry.origin.page },
                          );
                        }}
                      >
                        Return to{" "}
                        {entry.origin.area === "setup" ? "Setup" : "Settings"}
                      </button>
                    ),
                )}
              {snapshot.intents[row.id]?.connectorAttempt && (
                <p className="description">
                  Original connection operation:{" "}
                  <code>
                    {snapshot.intents[row.id]!.connectorAttempt!.operationId}
                  </code>
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {settings && (
        <WorkspaceEditResults
          snapshot={snapshot}
          facade={facade}
          settings={settings}
        />
      )}
      <button
        type="button"
        className="subtle"
        onClick={() => void actions.refresh()}
      >
        Refresh status
      </button>
      <p className="description">
        Refreshing cannot prove that an unknown action did not run. Only
        existing workspace edits support operation readback.
      </p>
      <Command actions={actions} command={{ kind: "support.export" }}>
        Save support file…
      </Command>
      {evidence?.kind === "support.exported" && (
        <p role="status">
          Saved {evidence.fileName} · {evidence.bytes} bytes.
        </p>
      )}
    </>
  );
}
