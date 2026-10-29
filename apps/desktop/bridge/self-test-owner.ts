import { randomUUID } from "node:crypto";
import { BridgeError, type Client } from "./client.ts";
import { readSelfTestHistory } from "./self-test-history.ts";
import {
  SelfTestBridge,
  type SelfTestSelection,
  type SelfTestSelectionStore,
  type PriorSelfTest,
} from "./self-test.ts";
import {
  validate,
  type ComputerAuthorityPublication,
  type Context,
  type Json,
} from "./wire.ts";

function sameSelection(a: SelfTestSelection, b: SelfTestSelection): boolean {
  return (
    a.operationId === b.operationId &&
    a.workspaceId === b.workspaceId &&
    a.computerGeneration === b.computerGeneration &&
    a.planVersion === b.planVersion
  );
}

// The host must persist the selection before the core call. A failed begin
// never dispatches reserve; uncertain settlement must remain attempted across
// restarts. The implementation owns the single-writer and durability proof.
export interface SelfTestMarker {
  load(workspaceId: string): Promise<"none" | PriorSelfTest>;
  begin(
    selection: SelfTestSelection,
    publication: ComputerAuthorityPublication,
  ): Promise<"durable" | "unknown">;
  finish(selection: SelfTestSelection): Promise<"durable" | "unknown">;
}

class CoreSelectionStore implements SelfTestSelectionStore {
  constructor(
    private readonly client: Pick<Client, "request">,
    private readonly context: Context,
    private readonly workspaceId: string,
    private readonly marker: SelfTestMarker,
  ) {}

  async reserve(
    selection: SelfTestSelection,
    publication: ComputerAuthorityPublication,
  ): Promise<"durable" | "unknown"> {
    if (
      selection.workspaceId !== this.workspaceId ||
      selection.planVersion !== "2" ||
      selection.computerGeneration !== publication.generation ||
      !validate("ComputerSelfTestObserve", selection) ||
      !validate("ComputerSelfTestStart", {
        workspaceId: selection.workspaceId,
        publication,
      })
    )
      return "unknown";
    const id = randomUUID();
    try {
      if ((await this.marker.begin(selection, publication)) !== "durable")
        return "unknown";
      const out = await this.client.request(
        "computer.selftest.reserve",
        { workspaceId: selection.workspaceId, publication } as unknown as Json,
        { id, operationId: selection.operationId, timeoutMs: 30000 },
      );
      if (
        !validate("Outcome", out) ||
        out.status !== "ok" ||
        out.requestId !== id ||
        out.operationId !== selection.operationId ||
        out.code !== undefined ||
        out.context.profileId !== this.context.profileId ||
        out.context.backendGeneration !== this.context.backendGeneration ||
        !validate("ComputerSelfTestObserve", out.data)
      )
        return "unknown";
      const received = out.data as unknown as SelfTestSelection;
      return sameSelection(selection, received) ? "durable" : "unknown";
    } catch {
      return "unknown";
    }
  }

  async settle(selection: SelfTestSelection): Promise<"durable" | "unknown"> {
    try {
      if (selection.workspaceId !== this.workspaceId) return "unknown";
      const history = await readSelfTestHistory(
        this.client,
        this.context,
        selection.workspaceId,
      );
      const original = history.find((entry) =>
        sameSelection(entry.selection, selection),
      );
      if (
        !original ||
        (original.phase !== "completed" && original.phase !== "failed")
      )
        return "unknown";
      return await this.marker.finish(selection);
    } catch {
      return "unknown";
    }
  }
}

// Called once for the selected workspace. More than one interrupted attempt
// remains available through history; no single one is guessed as the owner.
export async function openSelfTestOwner(
  client: Pick<Client, "request">,
  context: Context,
  workspaceId: string,
  marker: SelfTestMarker,
): Promise<{
  bridge: SelfTestBridge;
  history: Awaited<ReturnType<typeof readSelfTestHistory>>;
}> {
  const snapshot = Object.freeze({ ...context });
  const history = await readSelfTestHistory(client, snapshot, workspaceId);
  const saved = await marker.load(workspaceId);
  if (
    saved !== "none" &&
    (!validate("ComputerSelfTestObserve", saved.selection) ||
      saved.selection.workspaceId !== workspaceId ||
      typeof saved.settlementAttempted !== "boolean")
  )
    throw new BridgeError("unavailable", "invalid_self_test_marker");
  const unresolved = history.filter(
    (entry) => entry.phase === "prepared" || entry.phase === "outcome_unknown",
  );
  if (
    unresolved.length > 1 ||
    (saved !== "none" &&
      unresolved.some(
        (entry) => !sameSelection(entry.selection, saved.selection),
      ))
  )
    throw new BridgeError("refused", "multiple_self_tests_unresolved");
  const prior =
    saved !== "none"
      ? saved
      : unresolved[0]
        ? { selection: unresolved[0].selection, settlementAttempted: false }
        : "none";
  const store = new CoreSelectionStore(client, snapshot, workspaceId, marker);
  // A terminal phase alone is not evidence that its original report can be read.
  const observer = new SelfTestBridge(client, snapshot, "none", store);
  for (const entry of history) {
    if (entry.phase !== "completed" && entry.phase !== "failed") continue;
    const result = await observer.observe(entry.selection);
    if (
      result.state !== "observed" ||
      !result.report ||
      result.report.status === "unknown"
    )
      throw new BridgeError("unavailable", "self_test_report_unavailable");
  }
  return {
    bridge: new SelfTestBridge(client, snapshot, prior, store),
    history,
  };
}
