import type {
  ApprovedProductWorkspace,
  ProductSettings,
  WorkspaceRootIdentity,
} from "../../pkg/product-settings/contract";

// The composition every desktop Computer call goes through: which workspace
// is usable right now, which of its paths are denied, and which folder
// identity the helper must still find at the approved path.
//
// S35-TA-4: this used to sit inline in `main.ts`, which exports nothing and
// which no test loads, so the six call sites that build a descriptor and the
// four that decide a workspace is verified were unpinnable by construction.
// The adapters underneath are thoroughly tested — but they are tested against
// descriptors the tests build themselves, so a composition that handed them
// the wrong denied list or a stale identity would not have failed anything.
// Same reason `journalUnderPromotionLease` and the registry's durable writes
// were moved out: a replica in a test proves only that the replica is right.

/**
 * The workspace's exclusions as the root-relative prefixes the descriptor
 * carries.
 *
 * An exclusion that is not below `<root>/` is carried by nothing, which is
 * correct for a path outside the workspace and would have been fail-OPEN for
 * one naming the root itself: settings saying "exclude everything" reading as
 * "exclude nothing". `ApprovedProductWorkspaceSchema` used to exempt
 * `excluded === workspace.root` from "exclusion escapes root"; S35-TA-4
 * removed that exemption, so the one shape this function cannot express is
 * now invalid settings and never reaches it. `workspaceRootIsExcluded` below
 * remains as the detector for that shape.
 */
export function workspaceDeniedPaths(
  workspace: ApprovedProductWorkspace,
): readonly string[] {
  const prefix = workspace.root === "/" ? "/" : `${workspace.root}/`;
  return workspace.excludedPaths.flatMap((excluded) =>
    excluded.startsWith(prefix) ? [excluded.slice(prefix.length)] : [],
  );
}

/**
 * Whether this workspace's exclusions name the approved root itself — the
 * one exclusion `workspaceDeniedPaths` cannot express as a relative prefix.
 * See the gap described above.
 */
export function workspaceRootIsExcluded(
  workspace: ApprovedProductWorkspace,
): boolean {
  return workspace.excludedPaths.includes(workspace.root);
}

/**
 * Every desktop helper call names the workspace's own exclusions and the
 * folder identity the owner verified, so a folder that has since replaced it
 * at the same path is refused instead of trusted. There is no call without
 * one: the identity is a required argument, not an optional field a caller
 * can forget.
 */
// The return type is inferred on purpose: `exactOptionalPropertyTypes` makes
// the conditional `gitMetadata` spread below mean "absent", and writing the
// shape out by hand would widen it to "present or undefined", which the
// readonly-workspace port refuses.
export function workspaceDescriptor(
  workspace: ApprovedProductWorkspace,
  rootIdentity: WorkspaceRootIdentity,
) {
  return {
    workspaceId: workspace.workspaceId,
    root: workspace.root,
    deniedPaths: workspaceDeniedPaths(workspace),
    approvedRoot: { path: workspace.root, ...rootIdentity },
    ...(workspace.gitMetadata ? { gitMetadata: workspace.gitMetadata } : {}),
  };
}

export type VerifiedProductWorkspace = ApprovedProductWorkspace &
  Readonly<{ rootIdentity: WorkspaceRootIdentity }>;

export type VerifiedProductWorkspaceResult =
  | Readonly<{ status: "verified"; workspace: VerifiedProductWorkspace }>
  | Readonly<{ status: "not_found" }>
  | Readonly<{ status: "not_verified" }>;

/**
 * A workspace is verified only while the recorded verification names it at
 * the current Computer generation AND it carries the identity that
 * verification bound. A workspace saved before identities existed stays
 * unverified until the owner verifies it again; its pathname alone is never
 * trusted.
 *
 * All three conditions are load-bearing and none is redundant: a verification
 * naming another workspace, one recorded against an older generation (the
 * owner has changed the Computer configuration since), and a workspace whose
 * bound identity is missing are each refused with `not_verified` — the same
 * closed answer, because telling them apart would tell a caller which of the
 * owner's workspaces exist.
 */
export function verifiedProductWorkspace(
  settings: ProductSettings,
  workspaceId: string,
): VerifiedProductWorkspaceResult {
  const workspace = settings.computer.workspaces.find(
    (candidate) => candidate.workspaceId === workspaceId,
  );
  if (!workspace) return { status: "not_found" };
  const verification = settings.setup.computer.verified;
  const rootIdentity = workspace.rootIdentity;
  if (
    verification?.workspaceId !== workspace.workspaceId ||
    verification.configRevision !== settings.computer.generation ||
    !rootIdentity
  ) {
    return { status: "not_verified" };
  }
  return { status: "verified", workspace: { ...workspace, rootIdentity } };
}
