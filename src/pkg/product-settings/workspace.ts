import { z } from "zod";
import { workspaceContinuitySchema } from "./workspace-continuity.ts";
import {
  CanonicalAbsolutePathSchema,
  CanonicalTimestampSchema,
  IdentifierSchema,
  ProductRelativePathSchema,
  Sha256Schema,
  WorkspaceAccessCheckIdSchema,
} from "./scalar.ts";

// The device and inode the approved folder had when the owner approved it. A
// workspace approved before identities were recorded has none until its next
// owner verification binds one.
export const WorkspaceRootIdentitySchema = z.strictObject({
  device: z.string().regex(/^[0-9]{1,20}$/u),
  inode: z.string().regex(/^[0-9]{1,20}$/u),
});

export type WorkspaceRootIdentity = z.infer<typeof WorkspaceRootIdentitySchema>;

// Reader-only continuity evidence. Persisted values do not grant access or
// bypass the existing live device/inode and descriptor checks.
export const WorkspaceContinuitySchema = workspaceContinuitySchema(
  IdentifierSchema,
  CanonicalAbsolutePathSchema,
  CanonicalTimestampSchema,
  Sha256Schema,
);
export type WorkspaceContinuity = z.infer<typeof WorkspaceContinuitySchema>;

// Exact metadata measured during owner workspace verification. Linked
// worktrees require this external grant; a primary checkout records its internal
// .git only with full-Git approval so persistent tasks can bind the same layout.
export const WorkspaceGitMetadataSchema = z.strictObject({
  gitDirectory: CanonicalAbsolutePathSchema,
  commonDirectory: CanonicalAbsolutePathSchema,
});

export type WorkspaceGitMetadata = z.infer<typeof WorkspaceGitMetadataSchema>;

export const ApprovedProductWorkspaceSchema = z
  .strictObject({
    workspaceId: IdentifierSchema,
    root: CanonicalAbsolutePathSchema,
    label: z.string().trim().min(1).max(120),
    access: z.enum(["read", "write"]),
    excludedPaths: z.array(CanonicalAbsolutePathSchema).max(32),
    rootIdentity: WorkspaceRootIdentitySchema.optional(),
    continuity: WorkspaceContinuitySchema.optional(),
    gitMetadata: WorkspaceGitMetadataSchema.optional(),
    gitHistoryApproved: z.boolean().optional(),
    // Content-free evidence for the setup folder list, not another grant.
    // The descriptor and existing authority checks still admit every read.
    accessCheck: z
      .strictObject({
        checkId: WorkspaceAccessCheckIdSchema.optional(),
        buildId: z.string().regex(/^[a-f0-9]{64}$/u),
        computerGeneration: z.number().int().positive(),
        verifiedAt: CanonicalTimestampSchema,
        rootIdentity: WorkspaceRootIdentitySchema,
        // Written only by a successful check that saw the folder writable by
        // other users of this Mac; absent otherwise. Display evidence only: it
        // never widens or narrows access, and the next check replaces it.
        writableByOthers: z.literal(true).optional(),
      })
      .nullable()
      .optional(),
  })
  .superRefine((workspace, context) => {
    const continuity = workspace.continuity;
    if (continuity !== undefined) {
      if (continuity.workspaceId !== workspace.workspaceId)
        context.addIssue({
          code: "custom",
          path: ["continuity", "workspaceId"],
          message: "continuity workspace does not match approval",
        });
      if (continuity.root !== workspace.root)
        context.addIssue({
          code: "custom",
          path: ["continuity", "root"],
          message: "continuity root does not match approval",
        });
      if (
        workspace.rootIdentity === undefined ||
        continuity.fileId !== workspace.rootIdentity.inode
      )
        context.addIssue({
          code: "custom",
          path: ["continuity", "fileId"],
          message: "continuity requires the exact bound root inode",
        });
    }
    const prefix = workspace.root === "/" ? "/" : `${workspace.root}/`;
    const unique = new Set(workspace.excludedPaths);
    if (unique.size !== workspace.excludedPaths.length) {
      context.addIssue({ code: "custom", message: "duplicate exclusions" });
    }
    for (const excluded of workspace.excludedPaths) {
      // S35-TA-4/TA-10: strictly BELOW the root, and the root itself is not
      // below itself. An exclusion equal to the root used to be exempt here,
      // but it matches no `<root>/` prefix, so the descriptor built from it
      // denied nothing: a workspace saying "exclude everything" would have
      // read as "exclude nothing". The state is refused at the source rather
      // than carried into a consumer that cannot express it.
      //
      // The equality is tested SEPARATELY, before the prefix, because the
      // prefix alone does not catch it at the filesystem root: there the
      // prefix is "/" and `"/".startsWith("/")` is true, so `root: "/"` with
      // an exclusion of "/" validated and reached `workspaceDeniedPaths` as
      // the empty relative path. Every other root carries a trailing slash in
      // its prefix and is caught by the prefix test alone.
      if (excluded === workspace.root || !excluded.startsWith(prefix)) {
        context.addIssue({ code: "custom", message: "exclusion escapes root" });
      }
    }
  });

// One guarded edit whose result has not yet been delivered to the owner.  It
// is recorded before the edit executes and cleared only after the renderer
// acknowledges the delivered outcome, so a lost response or a restart leaves
// the exact operation ID to observe instead of a reason to edit again.
const PendingWorkspaceEditIdentity = {
  operationId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  relativePath: ProductRelativePathSchema,
  computerGeneration: z.number().int().positive(),
  submittedAt: z.string().datetime(),
};
export const PendingWorkspaceEditDeliverySchema = z.union([
  // Absence is the exact historical TS journal format, never a Go fallback.
  z.strictObject(PendingWorkspaceEditIdentity),
  z.strictObject({
    ...PendingWorkspaceEditIdentity,
    backend: z.literal("go-owner-v2"),
    profileId: IdentifierSchema,
    beforeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
]);
