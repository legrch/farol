import { BridgeError, type Client } from "./client.ts";
import { readSelfTestHistory } from "./self-test-history.ts";
import { readSelfTestMarkers } from "./self-test-marker.ts";
import {
  SelfTestBridge,
  type SelfTestObservation,
  type SelfTestSelection,
} from "./self-test.ts";
import type { Context } from "./wire.ts";

// Reconnection grants only fresh observation under the new connector. It
// cannot mint a permit, settle an old effect, or replace the original owner.
export class SelfTestObserver {
  private readonly context: Readonly<Context>;
  constructor(
    private readonly client: Pick<Client, "request">,
    context: Context,
    private readonly checkLive: () => void,
  ) {
    this.context = Object.freeze({ ...context });
  }

  async history(workspaceId: string) {
    this.checkLive();
    const markers = await readSelfTestMarkers(
      this.client,
      this.context,
      workspaceId,
    );
    this.checkLive();
    const records = await readSelfTestHistory(
      this.client,
      this.context,
      workspaceId,
    );
    this.checkLive();
    const unresolved: SelfTestSelection[] = [];
    const add = (selection: SelfTestSelection) => {
      if (
        !unresolved.some((entry) => entry.operationId === selection.operationId)
      )
        unresolved.push(selection);
    };
    for (const marker of markers) {
      const parent = records.find(
        (record) =>
          record.selection.operationId === marker.selection.operationId &&
          record.selection.workspaceId === marker.selection.workspaceId &&
          record.selection.computerGeneration ===
            marker.selection.computerGeneration &&
          record.selection.planVersion === marker.selection.planVersion,
      );
      if (
        marker.phase === "settling" ||
        !parent ||
        (parent.phase !== "completed" && parent.phase !== "failed")
      ) {
        add(marker.selection);
        continue;
      }
      const report = await this.observe(workspaceId, marker.selection);
      if (
        report.report?.status !==
        (parent.phase === "completed" ? "partial" : "fail")
      )
        add(marker.selection);
    }
    for (const record of records)
      if (record.phase === "prepared" || record.phase === "outcome_unknown")
        add(record.selection);
    this.checkLive();
    return Object.freeze({
      markers,
      records,
      unresolved: Object.freeze(unresolved),
    });
  }

  async observe(
    workspaceId: string,
    selection: SelfTestSelection,
  ): Promise<SelfTestObservation> {
    if (selection.workspaceId !== workspaceId)
      throw new BridgeError("refused", "invalid_self_test_observation");
    this.checkLive();
    const bridge = new SelfTestBridge(this.client, this.context, "none", {
      reserve: async () => "unknown",
      settle: async () => "unknown",
    });
    const original = await bridge.observe(selection);
    try {
      this.checkLive();
    } catch {
      return Object.freeze({
        selection: Object.freeze({ ...selection }),
        state: "unknown" as const,
      });
    }
    // An observer on a replacement connector cannot settle the original
    // owner's in-memory fence. The report is evidence, not a settlement ACK.
    return Object.freeze({ ...original, state: "unknown" as const });
  }
}
