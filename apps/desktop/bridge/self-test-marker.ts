import { randomUUID } from "node:crypto";
import { BridgeError, type Client } from "./client.ts";
import type { SelfTestSelection } from "./self-test.ts";
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
    selection.planVersion !== "2" ||
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
