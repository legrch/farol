import { useEffect, useRef, useState } from "react";
import {
  RecoveryReadResultSchema,
  RecoveryStateSchema,
  type RecoveryState,
  type RecoveryReadRequest,
  type RecoveryReadResult,
  type StartupRecoveryAPI,
} from "./contract";

type ReadData = Extract<RecoveryReadResult, { status: "ok" }>["data"];
export function StartupRecovery({ api }: { api: StartupRecoveryAPI }) {
  const [state, setState] = useState<RecoveryState | { status: "loading" }>({
    status: "loading",
  });
  const [folderId, setFolderId] = useState("");
  const [listing, setListing] = useState<Extract<
    ReadData,
    { kind: "list" }
  > | null>(null);
  const [metadata, setMetadata] = useState<Extract<
    ReadData,
    { kind: "metadata" }
  > | null>(null);
  const [readState, setReadState] = useState<
    "idle" | "running" | "refused" | "unavailable" | "unknown"
  >("idle");
  const epoch = useRef(0);
  useEffect(() => {
    const current = ++epoch.current;
    void api
      .state()
      .then((value) => {
        const parsed = RecoveryStateSchema.parse(value);
        if (epoch.current === current) setState(parsed);
      })
      .catch(() => {
        if (epoch.current === current)
          setState({ status: "settings_unavailable" });
      });
    return () => {
      epoch.current = current + 1;
    };
  }, [api]);
  const paused = readState === "unknown" || readState === "unavailable";
  const available =
    state.status === "ready" && state.computer === "available" && !paused;
  const busy = readState === "running";
  const folder =
    state.status === "ready"
      ? state.folders.find((item) => item.workspaceId === folderId)
      : undefined;
  const read = async (
    kind: RecoveryReadRequest["kind"],
    relativePath: string,
  ) => {
    if (!available || busy || !folder) return;
    const current = epoch.current;
    setReadState("running");
    setMetadata(null);
    try {
      const result = RecoveryReadResultSchema.parse(
        await api.read({ kind, workspaceId: folder.workspaceId, relativePath }),
      );
      if (epoch.current !== current) return;
      if (result.status !== "ok") {
        setReadState(result.status);
        return;
      }
      if (
        result.data.kind !== kind ||
        result.data.relativePath !== relativePath
      )
        throw new Error("CROSSED_RECOVERY_RESULT");
      if (result.data.kind === "list") setListing(result.data);
      else setMetadata(result.data);
      setReadState("idle");
    } catch {
      if (epoch.current === current) setReadState("unknown");
    }
  };
  return (
    <main className="startup-recovery-view" aria-labelledby="recovery-title">
      <p className="recovery-eyebrow">Previous work unconfirmed</p>
      <h1 id="recovery-title">Your previous session needs recovery</h1>
      <p>
        The previous session did not finish cleanly. Recovery keeps its records
        while commands and connection actions stay paused.
      </p>
      {state.status === "loading" ? (
        <p role="status">Reading saved settings…</p>
      ) : state.status === "closing" ? (
        <p role="status">Closing recovery…</p>
      ) : state.status === "settings_unavailable" ? (
        <p className="recovery-note" role="alert">
          Saved settings are unavailable. Existing files have been left in
          place. Quit and review the retained diagnostics before continuing
          recovery.
        </p>
      ) : (
        <section
          className="recovery-settings"
          aria-labelledby="recovery-settings-title"
        >
          <div className="recovery-section-heading">
            <h2 id="recovery-settings-title">Saved settings</h2>
            <span>Revision {state.revision}</span>
          </div>
          <p className="recovery-note">
            Connection and commands are paused. You can inspect approved folders
            when the local read service is available.
          </p>
          {state.computer === "unavailable" ? (
            <p role="status">
              Folder reads are unavailable. Your saved folder selection is still
              shown below.
            </p>
          ) : null}
          {state.folders.length === 0 ? (
            <p>No approved folders are saved.</p>
          ) : (
            <>
              <div className="recovery-folder-controls">
                <label htmlFor="recovery-folder">Saved folder</label>
                <div>
                  <select
                    id="recovery-folder"
                    value={folderId}
                    disabled={busy}
                    onChange={(event) => {
                      setFolderId(event.target.value);
                      setListing(null);
                      setMetadata(null);
                      if (!paused) setReadState("idle");
                    }}
                  >
                    <option value="">Choose a folder</option>
                    {state.folders.map((item) => (
                      <option key={item.workspaceId} value={item.workspaceId}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={!available || busy || !folder}
                    onClick={() => void read("list", ".")}
                  >
                    Open folder
                  </button>
                </div>
              </div>
              {folder ? <p className="recovery-path">{folder.root}</p> : null}
            </>
          )}
          {busy ? <p role="status">Reading…</p> : null}
          {readState === "refused" ? (
            <p role="alert">
              Access was refused. Choose an approved folder or Quit; no
              permission was changed.
            </p>
          ) : null}
          {paused ? (
            <p role="alert">
              This read could not be confirmed. Folder reads are paused; no
              action was repeated.
            </p>
          ) : null}
          {listing ? (
            <div className="recovery-browser">
              <div className="recovery-location">
                <span>
                  {listing.relativePath === "."
                    ? "Folder contents"
                    : listing.relativePath}
                </span>
                {listing.relativePath !== "." ? (
                  <button
                    type="button"
                    disabled={!available || busy}
                    onClick={() =>
                      void read(
                        "list",
                        listing.relativePath
                          .split("/")
                          .slice(0, -1)
                          .join("/") || ".",
                      )
                    }
                  >
                    Up
                  </button>
                ) : null}
              </div>
              {listing.entries.length === 0 ? (
                <p>This folder is empty.</p>
              ) : (
                <ul aria-label="Folder contents">
                  {listing.entries.map((entry) => (
                    <li key={entry}>
                      <button
                        type="button"
                        disabled={!available || busy}
                        onClick={() => {
                          const child = entry.endsWith("/")
                            ? entry.slice(0, -1)
                            : entry;
                          const relative =
                            listing.relativePath === "."
                              ? child
                              : `${listing.relativePath}/${child}`;
                          void read(
                            entry.endsWith("/") ? "list" : "metadata",
                            relative,
                          );
                        }}
                      >
                        <span aria-hidden="true">
                          {entry.endsWith("/") ? "▸" : "·"}
                        </span>
                        {entry}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {listing.truncated ? (
                <p className="recovery-note">
                  The listing reached its result limit.
                </p>
              ) : null}
            </div>
          ) : null}
          {metadata ? (
            <div className="recovery-metadata" role="status">
              <strong>{metadata.relativePath}</strong>
              <span>{metadata.bytes} bytes</span>
              <code>SHA-256 {metadata.sha256}</code>
            </div>
          ) : null}
        </section>
      )}
      <footer>
        <p className="recovery-note">
          Recovery has not confirmed the previous operations or resumed them.
        </p>
        <button type="button" onClick={() => api.quit()}>
          Quit
        </button>
      </footer>
    </main>
  );
}
