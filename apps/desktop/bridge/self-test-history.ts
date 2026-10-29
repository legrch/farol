import { randomUUID } from "node:crypto";
import { BridgeError, type Client } from "./client.ts";
import {
  validate,
  type ComputerSelfTestHistory,
  type Context,
  type Json,
} from "./wire.ts";
import type { SelfTestSelection } from "./self-test.ts";

// An unsuccessful or crossed inventory is never an empty history. Prepared
// records are observations only; this read does not reconstruct a start permit.
export async function readSelfTestHistory(
  client: Pick<Client, "request">,
  context: Context,
  workspaceId: string,
): Promise<
  ReadonlyArray<Readonly<{ selection: SelfTestSelection; phase: string }>>
> {
  const body = { workspaceId };
  if (
    !validate("Context", context) ||
    !validate("ComputerSelfTestHistoryRequest", body)
  )
    throw new BridgeError("refused", "invalid_self_test_history");
  const id = randomUUID();
  const out = await client.request("computer.selftest.history", body as Json, {
    id,
    timeoutMs: 30000,
  });
  if (
    !validate("Outcome", out) ||
    out.status !== "ok" ||
    out.requestId !== id ||
    out.operationId !== undefined ||
    out.code !== undefined ||
    out.context.profileId !== context.profileId ||
    out.context.backendGeneration !== context.backendGeneration ||
    !validate("ComputerSelfTestHistory", out.data)
  )
    throw new BridgeError("unavailable", "self_test_history_unavailable");
  const history = out.data as unknown as ComputerSelfTestHistory;
  const seen = new Set<string>();
  if (
    history.workspaceId !== workspaceId ||
    history.entries.some((entry) => {
      const selection = entry.selection;
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
    throw new BridgeError("unavailable", "self_test_history_unavailable");
  return Object.freeze(
    history.entries.map((entry) =>
      Object.freeze({
        selection: Object.freeze({
          ...entry.selection,
          planVersion: entry.selection.planVersion!,
        }),
        phase: entry.phase,
      }),
    ),
  );
}
