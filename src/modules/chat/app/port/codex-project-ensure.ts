import type {
  CodexProjectCatalogueHost,
  ProjectMatch,
} from "./codex-project-catalogue";
import type {
  HandoffAuthority,
  HandoffMutationGate,
  HandoffWorkspace,
} from "../service/persistent-codex-handoff";

export type ProjectEnsureRequest = Readonly<{
  key: string;
  workspaceId: string;
  name: string;
  mode: "ensure" | "inspect";
  preferredProjectId?: string;
}>;
export type ProjectEnsureIntent = Readonly<{
  key: string;
  name: string;
  project: HandoffWorkspace["project"];
  acknowledgedProjectId: string | null;
}>;
/** Adapters must parse untrusted records and scope one durable no-replace claim
 * to the canonical physical project, including concurrent different keys.
 * A claim succeeds only after durable publication. Never prune an unknown intent.
 * No filesystem/production adapter is admitted by this pure contract. */
export interface ProjectEnsureJournal {
  read(project: HandoffWorkspace["project"]): Promise<unknown>;
  claim(intent: ProjectEnsureIntent): Promise<boolean>;
  confirm(
    project: HandoffWorkspace["project"],
    key: string,
    projectId: string,
  ): Promise<void>;
}
export interface ProjectEnsureHost {
  catalogue: CodexProjectCatalogueHost;
  create(
    input: Readonly<{
      idempotencyKey: string;
      name: string;
      roots: readonly Readonly<{ path: string }>[];
    }>,
    deadlineAt: number,
  ): Promise<unknown>;
}
export type ProjectEnsureContext = Readonly<{
  authority: HandoffAuthority;
  journal: ProjectEnsureJournal;
  host: ProjectEnsureHost;
  gate: HandoffMutationGate;
  expiresAt: number;
  now: () => number;
  admitted: () => boolean;
  projectCreateAdmitted: boolean;
}>;
export type ProjectEnsureResult =
  | Readonly<{
      status: "resolved";
      projectId: string;
      proof: "current-catalogue";
      controlGranted: false;
    }>
  | Readonly<{
      status: "created";
      projectId: string;
      proof: "create-ack-and-current-catalogue";
      controlGranted: false;
    }>
  | Readonly<{
      status: "outcome_unknown";
      key: string;
      code: string;
      observedProjectId?: string;
      controlGranted: false;
    }>
  | Readonly<{
      status: "ambiguous";
      matches: readonly ProjectMatch[];
      controlGranted: false;
    }>
  | Readonly<{ status: "missing" | "stale_preference"; controlGranted: false }>
  | Readonly<{
      status: "refused" | "unavailable";
      code: string;
      controlGranted: false;
    }>;
