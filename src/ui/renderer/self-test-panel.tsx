import { useEffect, useRef, useState } from "react";
import {
  SelfTestResponseSchema,
  type SelfTestCommand,
  type SelfTestResponse,
} from "../../../apps/desktop/renderer/self-test-contract";
import type { RendererFacade } from "./contract";

type Selection = Extract<SelfTestCommand, { kind: "observe" }>["selection"];
type Observation = Extract<
  SelfTestResponse,
  { ok: true; kind: "start" | "observe" }
>["observation"];
type Workspace = Readonly<{ workspaceId: string; label: string }>;
type HistoryRecord = Extract<
  SelfTestResponse,
  { ok: true; kind: "history" }
>["history"]["records"][number];

// A missing or invalid response is never evidence that an effect did not run.
export function SelfTestPanel({
  facade,
  workspaces,
}: {
  facade: RendererFacade;
  workspaces: readonly Workspace[];
}) {
  const [workspaceId, setWorkspaceId] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [unresolved, setUnresolved] = useState<Selection[]>([]);
  const [records, setRecords] = useState<HistoryRecord[]>([]);
  const [observation, setObservation] = useState<Observation | null>(null);
  const flight = useRef(false);
  const generation = useRef(0);

  useEffect(() => {
    const token = generation;
    const current = ++token.current;
    setReady(false);
    setUnresolved([]);
    setRecords([]);
    setObservation(null);
    setNotice("");
    if (!workspaceId || !facade.selfTest) return;
    void facade
      .selfTest({ kind: "history", workspaceId })
      .then((raw) => {
        if (token.current !== current) return;
        const response = SelfTestResponseSchema.safeParse(raw);
        if (
          !response.success ||
          !response.data.ok ||
          response.data.kind !== "history"
        ) {
          setNotice(
            "Test history is unavailable. A new test cannot be started.",
          );
          return;
        }
        if (
          [
            ...response.data.history.unresolved,
            ...response.data.history.records.map((entry) => entry.selection),
          ].some((item) => item.workspaceId !== workspaceId)
        ) {
          setNotice("Test history does not match this workspace.");
          return;
        }
        setUnresolved(response.data.history.unresolved);
        setRecords(response.data.history.records);
        setReady(true);
      })
      .catch(() => {
        if (token.current === current)
          setNotice(
            "Test history is unavailable. A new test cannot be started.",
          );
      });
    return () => {
      token.current++;
    };
  }, [facade, workspaceId]);

  async function run(command: Exclude<SelfTestCommand, { kind: "history" }>) {
    if (flight.current || !facade.selfTest) return;
    flight.current = true;
    setBusy(true);
    setNotice("");
    if (command.kind === "start") setReady(false);
    try {
      const raw = await facade.selfTest(command);
      const response = SelfTestResponseSchema.safeParse(raw);
      if (
        !response.success ||
        !response.data.ok ||
        response.data.kind === "history" ||
        response.data.kind !== command.kind
      ) {
        const selection =
          response.success && !response.data.ok
            ? response.data.selection
            : undefined;
        if (selection && selection.workspaceId === workspaceId)
          setUnresolved([selection]);
        setNotice(
          "The test result could not be confirmed. Do not start it again.",
        );
        setReady(false);
        return;
      }
      const result = response.data.observation;
      if (
        result.selection.workspaceId !== workspaceId ||
        (command.kind === "observe" &&
          (result.selection.operationId !== command.selection.operationId ||
            result.selection.computerGeneration !==
              command.selection.computerGeneration ||
            result.selection.planVersion !== command.selection.planVersion))
      ) {
        setNotice(
          "The test result could not be matched. Do not start it again.",
        );
        setReady(false);
        return;
      }
      setObservation(result);
      if (
        result.state === "unknown" ||
        !result.report ||
        result.report.status === "unknown"
      ) {
        setUnresolved((old) =>
          old.some((item) => item.operationId === result.selection.operationId)
            ? old
            : [...old, result.selection],
        );
        setReady(false);
      } else {
        setRecords((old) => [
          ...old.filter(
            (entry) =>
              entry.selection.operationId !== result.selection.operationId,
          ),
          {
            selection: result.selection,
            phase: result.report!.status === "fail" ? "failed" : "completed",
          },
        ]);
        setUnresolved((old) =>
          old.filter(
            (item) => item.operationId !== result.selection.operationId,
          ),
        );
        setReady(true);
      }
    } catch {
      setNotice(
        "The test result could not be confirmed. Do not start it again.",
      );
      setReady(false);
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }

  async function inspectSaved(selection: Selection) {
    if (flight.current || !facade.selfTest) return;
    flight.current = true;
    setBusy(true);
    setNotice("");
    try {
      const parsed = SelfTestResponseSchema.safeParse(
        await facade.selfTest({ kind: "observe", workspaceId, selection }),
      );
      if (!parsed.success || !parsed.data.ok || parsed.data.kind !== "observe")
        throw new Error("unavailable");
      const result = parsed.data.observation;
      if (
        result.selection.operationId !== selection.operationId ||
        result.selection.workspaceId !== selection.workspaceId ||
        result.selection.computerGeneration !== selection.computerGeneration ||
        result.selection.planVersion !== selection.planVersion
      )
        throw new Error("crossed");
      setObservation(result);
      if (!result.report)
        setNotice(
          "The saved result is currently unavailable. No action was repeated.",
        );
    } catch {
      setNotice(
        "The saved result is currently unavailable. No action was repeated.",
      );
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="home-self-test" aria-labelledby="self-test-title">
      <h2 id="self-test-title">Deep test</h2>
      <p>
        Choose a workspace to check file operations and commands. The test
        creates a temporary folder and removes it when safe.
      </p>
      <label>
        Workspace{" "}
        <select
          value={workspaceId}
          disabled={busy}
          onChange={(event) => setWorkspaceId(event.target.value)}
        >
          <option value="">Choose a workspace</option>
          {workspaces.map((workspace) => (
            <option key={workspace.workspaceId} value={workspace.workspaceId}>
              {workspace.label}
            </option>
          ))}
        </select>
      </label>{" "}
      <button
        disabled={!workspaceId || !ready || busy || unresolved.length > 0}
        onClick={() => void run({ kind: "start", workspaceId })}
      >
        {busy ? "Checking…" : "Run deep test"}
      </button>
      <div aria-live="polite">
        {notice && <p>{notice}</p>}
        {unresolved.map((selection) => (
          <p key={selection.operationId}>
            Result unconfirmed · {selection.operationId}{" "}
            <button
              disabled={busy}
              onClick={() =>
                void run({ kind: "observe", workspaceId, selection })
              }
            >
              Check original result
            </button>
          </p>
        ))}
        {observation?.report && (
          <>
            <p>
              {observation.state === "unknown"
                ? "Result unconfirmed"
                : observation.report.status === "partial"
                  ? "Partial result"
                  : "Test failed"}{" "}
              · {observation.selection.operationId}
            </p>
            <ul>
              {observation.report.steps.map((step) => (
                <li key={step.name}>
                  {step.name} ·{" "}
                  {step.status === "not_tested" ? "not tested" : step.status}
                  {step.code ? ` · ${step.code}` : ""}
                </li>
              ))}
            </ul>
            {observation.report.steps.some(
              (step) =>
                step.name === "directory search" && step.status === "pass",
            ) && (
              <p>
                Directory search covers the test folder. Nested folders and
                ignore rules are not checked.
              </p>
            )}
          </>
        )}
        {records.some(
          (entry) => entry.phase === "completed" || entry.phase === "failed",
        ) && (
          <details>
            <summary>Previous test results</summary>
            <ul>
              {records
                .filter(
                  (entry) =>
                    entry.phase === "completed" || entry.phase === "failed",
                )
                .map((entry) => (
                  <li key={entry.selection.operationId}>
                    {entry.phase === "completed" ? "Completed" : "Failed"} ·{" "}
                    {entry.selection.operationId}{" "}
                    <button
                      disabled={busy}
                      onClick={() => void inspectSaved(entry.selection)}
                    >
                      View result
                    </button>
                  </li>
                ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  );
}
