import type {
  ApprovedProductWorkspace,
  ProductSettings,
} from "../../pkg/product-settings/contract";
import type {
  PrivateProductAgentStore,
  ProductAgentInput,
} from "./product-agent-store";
import { productAgentScopeMatchesWorkspace } from "./product-agent-scope";

// S35-TA-6: this used to sit inline in `main.ts`, which exports nothing and
// which no test loads, so every call site building this security-relevant
// context was unpinnable by construction. A test could only replicate the
// checks and assert on the copy — an independent review already rejected
// exactly that kind of test. Same reason `journalUnderPromotionLease`, the
// registry's two durable writes, and the Computer workspace composition were
// moved out: a replica in a test proves only that the replica is right.
//
// This is the native Product Agent's freshness gate. It sits on the local
// trust boundary: a silent wrong answer here means a native Agent runs
// against a host binary or a workspace the owner's verification no longer
// covers — the binary could have been swapped after it was verified, or the
// owner could have changed the Computer configuration since the workspace
// was last approved. Every branch below is a closed refusal (`null`), never
// a best guess.

export type ProductAgentContext = Readonly<{
  settings: ProductSettings;
  host: NonNullable<ProductSettings["nativeHosts"]["codex"]>;
  workspace: ApprovedProductWorkspace;
}>;

export type ProductAgentHostContext = Readonly<
  Pick<ProductAgentContext, "settings" | "host">
>;

/**
 * Whether a native Product Agent may be started or rejoined for
 * `workspaceId` right now, and if so, the exact settings/host/workspace it
 * must run against.
 *
 * `settings` is the caller's already-validated snapshot (`null` when the
 * configuration service is not `"ready"`); `productAgentStore` is the
 * durable store for in-flight Agent inputs (`null` before it has been set up);
 * `buildId` is this running build's identity. None of these are read from a
 * module-level global here — the caller owns the snapshot read and the store
 * reference, and passes the result in.
 *
 * Three verifications are checked together and all of them are load-bearing:
 * the live host check (the exact selected Codex binary and schema, on this
 * build), the agent check (the same binary/schema/build, bound to this exact
 * workspace and Computer generation, with the workspace enforcement the
 * native side actually applied), and the Computer verification (the owner's
 * last approval of this workspace, at the current Computer generation,
 * reachable and with a known outcome). Any one going stale — the verified
 * binary's sha256 swapped underneath it, the Computer generation advancing
 * because the owner changed its configuration, the workspace's own
 * verification lapsing — produces the same closed answer: `null`.
 */
export function productAgentContext(
  workspaceId: string,
  settings: ProductSettings | null,
  productAgentStore: PrivateProductAgentStore | null,
  buildId: string,
): ProductAgentContext | null {
  if (!settings || !productAgentStore) return null;
  const selected = settings.nativeHosts.codex;
  const live = selected?.liveVerification;
  const agent = selected?.agentVerification;
  const workspace = settings.computer.workspaces.find(
    (candidate) => candidate.workspaceId === workspaceId,
  );
  const verified = settings.setup.computer.verified;
  if (
    !selected ||
    !live ||
    live.executableSha256 !== selected.executableSha256 ||
    live.schemaSha256 !== selected.schemaSha256 ||
    live.buildId !== buildId ||
    !agent ||
    agent.executableSha256 !== selected.executableSha256 ||
    agent.schemaSha256 !== selected.schemaSha256 ||
    agent.buildId !== buildId ||
    agent.workspaceId !== workspaceId ||
    agent.computerGeneration !== settings.computer.generation ||
    agent.workspaceEnforcement !== "verified" ||
    !workspace ||
    !verified ||
    verified.workspaceId !== workspace.workspaceId ||
    verified.configRevision !== settings.computer.generation ||
    verified.buildId !== buildId ||
    settings.setup.computer.reachable !== "reachable" ||
    settings.setup.computer.outcomeUnknown
  ) {
    return null;
  }
  return { settings, host: selected, workspace };
}

/**
 * The lighter freshness gate a task that already carries a saved
 * `ProductAgentInput` needs: only the exact host (binary, schema, build) the
 * input was created against is re-checked here, not the workspace or
 * Computer generation — those are `productAgentInputMatchesContext`'s job
 * once a full `ProductAgentContext` is available. Used to cancel or
 * tombstone a task whose selected host has since changed, without requiring
 * the heavier context a fresh start needs.
 */
export function productAgentHostContext(
  input: ProductAgentInput,
  settings: ProductSettings | null,
  buildId: string,
): ProductAgentHostContext | null {
  if (!settings) return null;
  const selected = settings.nativeHosts.codex;
  if (
    !selected ||
    selected.executableSha256 !== input.executableSha256 ||
    selected.schemaSha256 !== input.schemaSha256 ||
    input.buildId !== buildId
  ) {
    return null;
  }
  return { settings, host: selected };
}

/**
 * Whether a previously created `ProductAgentInput` still matches a freshly
 * computed `ProductAgentContext`: the same Computer generation, the same
 * workspace, a scope still valid against that workspace's current root and
 * exclusions, and the same host binary/schema/build. Called immediately
 * before resuming or executing a Product Agent turn, so a context that went
 * stale between "start" and "run" is refused rather than honored.
 */
export function productAgentInputMatchesContext(
  input: ProductAgentInput,
  context: ProductAgentContext,
  buildId: string,
): boolean {
  return (
    input.computerGeneration === context.settings.computer.generation &&
    input.workspaceId === context.workspace.workspaceId &&
    productAgentScopeMatchesWorkspace(
      context.workspace.root,
      context.workspace.excludedPaths,
      input,
    ) &&
    input.executableSha256 === context.host.executableSha256 &&
    input.schemaSha256 === context.host.schemaSha256 &&
    input.buildId === buildId
  );
}
