import { BridgeError, type Client } from "./client.ts";
import { CoreSelfTestMarker, readSelfTestMarkers } from "./self-test-marker.ts";
import { readSelfTestHistory } from "./self-test-history.ts";
import { openSelfTestOwner } from "./self-test-owner.ts";
import type { SelfTestSelection } from "./self-test.ts";
import type { ComputerAuthorityPublication, Context } from "./wire.ts";

// One owner per workspace and backend lifetime. Only read-only failed opens
// may be selected again; a started owner's unknown state remains in memory.
export class SelfTestManager {
  private readonly owners = new Map<
    string,
    ReturnType<typeof openSelfTestOwner>
  >();
  private readonly context: Readonly<Context>;
  constructor(
    private readonly client: Pick<Client, "request">,
    context: Context,
    private readonly checkLive: () => void,
    private readonly publication: () => ComputerAuthorityPublication,
  ) {
    this.context = Object.freeze({ ...context });
  }

  private async owner(workspaceId: string) {
    this.checkLive();
    let pending = this.owners.get(workspaceId);
    if (!pending) {
      pending = openSelfTestOwner(
        this.client,
        this.context,
        workspaceId,
        new CoreSelfTestMarker(this.client, this.context, workspaceId),
        this.checkLive,
      );
      this.owners.set(workspaceId, pending);
      // Only opening reads. Never discard an owner after a start has begun.
      pending.catch(() => {
        if (this.owners.get(workspaceId) === pending)
          this.owners.delete(workspaceId);
      });
    }
    const result = await pending;
    this.checkLive();
    return result;
  }

  async history(workspaceId: string) {
    await this.owner(workspaceId);
    const markers = await readSelfTestMarkers(
      this.client,
      this.context,
      workspaceId,
    );
    const records = await readSelfTestHistory(
      this.client,
      this.context,
      workspaceId,
    );
    this.checkLive();
    return Object.freeze({ markers, records });
  }

  async start(workspaceId: string) {
    const owner = await this.owner(workspaceId);
    this.checkLive();
    return owner.bridge.start(this.publication(), workspaceId);
  }

  async observe(workspaceId: string, selection: SelfTestSelection) {
    if (selection.workspaceId !== workspaceId)
      throw new BridgeError("refused", "invalid_self_test_observation");
    const owner = await this.owner(workspaceId);
    this.checkLive();
    return owner.bridge.observe(selection);
  }
}
