import { useRef, useState } from "react";
import {
  SelfTestResponseSchema,
  type SelfTestCommand,
} from "../../../apps/desktop/renderer/self-test-contract";
import type { RendererFacade } from "./contract";

type Selection = Extract<SelfTestCommand, { kind: "observe" }>["selection"];
type Workspace = Readonly<{ workspaceId: string; label: string }>;

export function PreviousSelfTests({
  facade,
  workspaces,
}: Readonly<{ facade: RendererFacade; workspaces: readonly Workspace[] }>) {
  const [chosen, setChosen] = useState("");
  const [records, setRecords] = useState<
    readonly { selection: Selection; phase: string }[]
  >([]);
  const [message, setMessage] = useState("");
  const [report, setReport] = useState<string[]>([]);
  const flight = useRef(false);
  const generation = useRef(0);
  const workspaceId =
    workspaces.length === 1 ? workspaces[0]!.workspaceId : chosen;
  const latestWorkspace = useRef(workspaceId);
  latestWorkspace.current = workspaceId;
  async function read(selection?: Selection) {
    if (flight.current || !workspaceId || !facade.selfTest) return;
    const expected = generation.current;
    flight.current = true;
    setMessage("");
    setReport([]);
    try {
      const raw = await facade.selfTest(
        selection
          ? { kind: "observe", workspaceId, selection }
          : { kind: "history", workspaceId },
      );
      const parsed = SelfTestResponseSchema.safeParse(raw);
      if (
        generation.current !== expected ||
        latestWorkspace.current !== workspaceId
      )
        return;
      if (!parsed.success || !parsed.data.ok) throw Error("unavailable");
      if (selection && parsed.data.kind === "observe") {
        const result = parsed.data.observation;
        if (JSON.stringify(result.selection) !== JSON.stringify(selection))
          throw Error("crossed");
        setReport(
          result.report?.steps.map(
            (step) =>
              `${step.name} · ${step.status}${step.code ? ` · ${step.code}` : ""}`,
          ) ?? [],
        );
        setMessage(
          result.report
            ? `${result.state} · ${selection.operationId}`
            : `Result unavailable · ${selection.operationId}`,
        );
      } else if (!selection && parsed.data.kind === "history") {
        const history = parsed.data.history;
        if (
          history.markers.some(
            (entry) => entry.selection.workspaceId !== workspaceId,
          )
        )
          throw Error("crossed");
        const all = [
          ...history.records,
          ...history.unresolved.map((item) => ({
            selection: item,
            phase: "outcome_unknown",
          })),
          ...(history.pending
            ? [{ selection: history.pending, phase: "outcome_unknown" }]
            : []),
        ];
        if (all.some((entry) => entry.selection.workspaceId !== workspaceId))
          throw Error("crossed");
        setRecords([
          ...new Map(
            all.map((entry) => [entry.selection.operationId, entry]),
          ).values(),
        ]);
        setReport([]);
        setMessage(
          all.length
            ? "Previous local tests"
            : "No previous local tests found.",
        );
      } else throw Error("crossed");
    } catch {
      if (
        generation.current === expected &&
        latestWorkspace.current === workspaceId
      )
        setMessage(
          "Previous test results are unavailable. No test was repeated.",
        );
    } finally {
      flight.current = false;
    }
  }
  return (
    <section aria-label="Previous local tests">
      {workspaces.length > 1 && (
        <label>
          Workspace{" "}
          <select
            value={chosen}
            onChange={(event) => {
              generation.current++;
              setChosen(event.currentTarget.value);
              setRecords([]);
              setReport([]);
              setMessage("");
            }}
          >
            <option value="">Choose a workspace</option>
            {workspaces.map((workspace) => (
              <option key={workspace.workspaceId} value={workspace.workspaceId}>
                {workspace.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <button type="button" disabled={!workspaceId} onClick={() => void read()}>
        Previous local results
      </button>
      {message && <p role="status">{message}</p>}
      {records.map((entry) => (
        <p key={entry.selection.operationId}>
          {entry.phase} · {entry.selection.operationId}{" "}
          <button type="button" onClick={() => void read(entry.selection)}>
            View original result
          </button>
        </p>
      ))}
      {report.length > 0 && (
        <ul>
          {report.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
