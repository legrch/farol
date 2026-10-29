import { randomUUID } from "node:crypto";
import { BridgeError, type Client } from "./client.ts";
import {
  SelfTestBridge,
  type PriorSelfTest,
  type SelfTestSelection,
} from "./self-test.ts";
import type { SelfTestMarker } from "./self-test-owner.ts";
import { readSelfTestHistory } from "./self-test-history.ts";
import {
  validate,
  type ComputerAuthorityPublication,
  type ComputerSelfTestMarkerHistory,
  type Context,
  type Json,
} from "./wire.ts";

export type SelfTestMarkerEntry = Readonly<{
  selection: SelfTestSelection;
  phase: "selected" | "settling" | "settled";
}>;

// Marker phases are never rewritten to settle a test. A known terminal is
// derived from read-only qualified history; old settling stays unresolved.
export class CoreSelfTestMarker implements SelfTestMarker {
  private readonly context: Readonly<Context>;
  constructor(
    private readonly client: Pick<Client, "request">,
    context: Context,
    private readonly workspaceId: string,
  ) {
    this.context = Object.freeze({ ...context });
  }

  async load(workspaceId: string): Promise<"none" | PriorSelfTest> {
    if (workspaceId !== this.workspaceId)
      throw new BridgeError("refused", "invalid_self_test_marker");
    const markers = await readSelfTestMarkers(
      this.client,
      this.context,
      workspaceId,
    );
    const parents = await readSelfTestHistory(
      this.client,
      this.context,
      workspaceId,
    );
    const pending: SelfTestMarkerEntry[] = [];
    for (const entry of markers) {
      const original = parents.find(
        (parent) =>
          sameSelection(parent.selection, entry.selection) &&
          (parent.phase === "completed" || parent.phase === "failed"),
      );
      if (entry.phase === "settling" || !original) {
        pending.push(entry);
        continue;
      }
      if (!(await this.observeTerminal(entry.selection, original.phase)))
        throw new BridgeError("unavailable", "self_test_report_unavailable");
    }
    if (pending.length > 1)
      throw new BridgeError("refused", "multiple_self_tests_unresolved");
    return pending[0]
      ? {
          selection: pending[0].selection,
          settlementAttempted: pending[0].phase === "settling",
        }
      : "none";
  }

  async begin(
    selection: SelfTestSelection,
    publication: ComputerAuthorityPublication,
  ): Promise<"durable" | "unknown"> {
    if (selection.workspaceId !== this.workspaceId) return "unknown";
    return beginSelfTestMarker(
      this.client,
      this.context,
      selection,
      publication,
    );
  }

  async finish(selection: SelfTestSelection): Promise<"durable" | "unknown"> {
    if (selection.workspaceId !== this.workspaceId) return "unknown";
    try {
      const markers = await readSelfTestMarkers(
        this.client,
        this.context,
        this.workspaceId,
      );
      const marker = markers.find((entry) =>
        sameSelection(entry.selection, selection),
      );
      if (!marker || marker.phase === "settling") return "unknown";
      const parents = await readSelfTestHistory(
        this.client,
        this.context,
        this.workspaceId,
      );
      const original = parents.find(
        (parent) =>
          sameSelection(parent.selection, selection) &&
          (parent.phase === "completed" || parent.phase === "failed"),
      );
      if (!original) return "unknown";
      return (await this.observeTerminal(selection, original.phase))
        ? "durable"
        : "unknown";
    } catch {
      return "unknown";
    }
  }

  private async observeTerminal(
    selection: SelfTestSelection,
    phase: string,
  ): Promise<boolean> {
    const observer = new SelfTestBridge(this.client, this.context, "none", {
      reserve: async () => "unknown",
      settle: async () => "unknown",
    });
    const report = await observer.observe(selection);
    return (
      report.state === "observed" &&
      report.report?.status === (phase === "completed" ? "partial" : "fail")
    );
  }
}

function sameSelection(a: SelfTestSelection, b: SelfTestSelection): boolean {
  return (
    a.operationId === b.operationId &&
    a.workspaceId === b.workspaceId &&
    a.computerGeneration === b.computerGeneration &&
    a.planVersion === b.planVersion
  );
}

export async function readSelfTestMarkers(
  client: Pick<Client, "request">,
  context: Context,
  workspaceId: string,
): Promise<readonly SelfTestMarkerEntry[]> {
  const body = { workspaceId };
  if (
    !validate("Context", context) ||
    !validate("ComputerSelfTestHistoryRequest", body)
  )
    throw new BridgeError("refused", "invalid_self_test_marker");
  const id = randomUUID();
  const out = await client.request(
    "computer.selftest.marker.history",
    body as Json,
    { id, timeoutMs: 30000 },
  );
  if (
    !validate("Outcome", out) ||
    out.status !== "ok" ||
    out.requestId !== id ||
    out.operationId !== undefined ||
    out.code !== undefined ||
    out.context.profileId !== context.profileId ||
    out.context.backendGeneration !== context.backendGeneration ||
    !validate("ComputerSelfTestMarkerHistory", out.data)
  )
    throw new BridgeError("unavailable", "self_test_marker_unavailable");
  const result = out.data as unknown as ComputerSelfTestMarkerHistory;
  const seen = new Set<string>();
  if (
    result.workspaceId !== workspaceId ||
    result.entries.some(({ selection }) => {
      if (
        selection.workspaceId !== workspaceId ||
        !selection.planVersion ||
        seen.has(selection.operationId)
      )
        return true;
      seen.add(selection.operationId);
      return false;
    })
  )
    throw new BridgeError("unavailable", "self_test_marker_unavailable");
  return Object.freeze(
    result.entries.map(({ selection, phase }) =>
      Object.freeze({
        selection: Object.freeze({
          ...selection,
          planVersion: selection.planVersion!,
        }),
        phase,
      }),
    ),
  );
}

// A lost acknowledgement is unknown; this function never retries the effect.
export async function beginSelfTestMarker(
  client: Pick<Client, "request">,
  context: Context,
  selection: SelfTestSelection,
  publication: ComputerAuthorityPublication,
): Promise<"durable" | "unknown"> {
  const body = { workspaceId: selection.workspaceId, publication };
  if (
    selection.planVersion !== "3" ||
    selection.computerGeneration !== publication.generation ||
    !validate("Context", context) ||
    !validate("ComputerSelfTestObserve", selection) ||
    !validate("ComputerSelfTestStart", body)
  )
    return "unknown";
  const id = randomUUID();
  try {
    const out = await client.request(
      "computer.selftest.marker.begin",
      body as unknown as Json,
      { id, operationId: selection.operationId, timeoutMs: 30000 },
    );
    if (
      !validate("Outcome", out) ||
      out.status !== "ok" ||
      out.requestId !== id ||
      out.operationId !== selection.operationId ||
      out.code !== undefined ||
      out.context.profileId !== context.profileId ||
      out.context.backendGeneration !== context.backendGeneration ||
      !validate("ComputerSelfTestObserve", out.data)
    )
      return "unknown";
    return sameSelection(selection, out.data as unknown as SelfTestSelection)
      ? "durable"
      : "unknown";
  } catch {
    return "unknown";
  }
}
