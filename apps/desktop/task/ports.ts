import type { AuthorityTransitionReservation } from "../../../src/apps/desktop/authority-transition";
import type { CodexAgentWorkspaceProbe } from "../../../src/apps/desktop/codex-agent-workspace-probe";
import type { launchCodexAppServer } from "../../../src/apps/desktop/codex-app-server-process";
import type { probeCodexHost } from "../../../src/apps/desktop/codex-host-probe";
import type { FarolBackedProductAgentRoute } from "../../../src/apps/desktop/foundation-feature-gates";
import type { LiveTaskRegistry } from "../../../src/apps/desktop/live-task-registry";
import type { runProductAgentAssignment } from "../../../src/apps/desktop/product-agent-assignment";
import type { ProductConfigurationService } from "../../../src/apps/desktop/product-configuration";
import type {
  PrivateProductAgentStore,
  ProductAgentInput,
} from "../../../src/apps/desktop/product-agent-store";
import type { ProductAgentError } from "./outcome";
import type {
  AgentHostPort,
  Assignment,
  Assignments,
  CancelReceipt,
  RunReceipt,
} from "./summary";

// The shapes the native Product Agent host is built from: its session, its
// route and every port main injects. Types only; nothing here runs.

type Acknowledgement = Readonly<{
  correlation: Assignment["identity"] &
    Readonly<{
      authorityId: string;
      participantId: string;
      role: Assignment["authority"]["role"];
      parentThreadId: string;
      childId: string;
      parentTurnId: string;
      childTurnId: string;
      hostRole: Assignment["hostRole"];
      delegationDigest: string;
    }>;
  parentParticipantId: string;
  resultRef: string;
}>;

export type CodexAppServerClient = Awaited<
  ReturnType<typeof launchCodexAppServer>
>;
export type WorkspaceProbe = InstanceType<typeof CodexAgentWorkspaceProbe>;
export type ExpiryTimer = NodeJS.Timeout;

export type ProductAgentRoute =
  | Readonly<{ model: "gpt-6-astra"; effort?: "low" }>
  | FarolBackedProductAgentRoute;
export type ProductAgentHost = AgentHostPort & Readonly<{ dispose(): void }>;
export type ProductAgentHostOptions = Readonly<
  ProductAgentRoute & {
    runtimeRoot: string;
    spawnTimeoutMs: number;
    waitTimeoutMs: number;
    pollIntervalMs: number;
    nonce(): string;
    now(): number;
  }
>;

export type ProductAgentSession<Result> = {
  taskId: string;
  key: string;
  input: ProductAgentInput;
  assignments: Assignments;
  client: CodexAppServerClient;
  host: ProductAgentHost;
  expiryTimer: ExpiryTimer | null;
  cancellation: Promise<Result> | null;
};

export type ProductAgentHostPorts<Result> = Readonly<{
  taskFailure: (error: ProductAgentError) => Result;
  taskSuccess: (taskId: string | null) => Result;
  productAgentEnabled: boolean;
  farolBackedProductAgentRoute: () => FarolBackedProductAgentRoute | null;
  buildIdentity: Readonly<{ buildId: string; version: string }>;
  configuration: () => Pick<ProductConfigurationService, "snapshot"> | null;
  productAgentStore: () => PrivateProductAgentStore | null;
  liveTaskRegistry: Pick<LiveTaskRegistry, "get" | "snapshot" | "setAgent">;
  taskMutations: Readonly<{
    inFlight: () => boolean;
    tryEnter: () => Readonly<{ release: () => void }> | null;
  }>;
  authorityTransitions: Pick<AuthorityTransitionReservation, "tryReserve">;
  activeProductAgentSession: () => ProductAgentSession<Result> | null;
  setActiveProductAgentSession: (
    value: ProductAgentSession<Result> | null,
  ) => void;
  persistedProductAgentExpiry: () => Readonly<{
    taskId: string;
    timer: ExpiryTimer;
  }> | null;
  setPersistedProductAgentExpiry: (
    value: Readonly<{ taskId: string; timer: ExpiryTimer }> | null,
  ) => void;
  persistLiveTaskState: () => Promise<void>;
  publishTasksState: () => void;
  statePaths: () => Readonly<{
    codexHostProbe: string;
    codexAgentAssignments: string;
  }>;
  nativeWorkspace: ConstructorParameters<typeof CodexAgentWorkspaceProbe>[1];
  tempPath: () => string;
  codexHostRuntimeRoot: () => Promise<string>;
  codexHostProcessHomePath: () => Promise<string>;
  codexHostHomeOption: () => Promise<Readonly<{ codexHomePath?: string }>>;
  probeCodexHost: typeof probeCodexHost;
  launchCodexAppServer: typeof launchCodexAppServer;
  runProductAgentAssignment: typeof runProductAgentAssignment;
  CodexNativeAgentHost: new (
    client: CodexAppServerClient,
    options: ProductAgentHostOptions,
    workspaceProbe: WorkspaceProbe,
    computer: WorkspaceProbe,
  ) => ProductAgentHost;
  CodexAgentWorkspaceProbe: typeof CodexAgentWorkspaceProbe;
  PrivateAssignmentStore: new (
    input: Readonly<{ root: string }>,
  ) => Assignments;
  CancelAgentAssignment: new (
    host: AgentHostPort,
    assignments: Assignments,
  ) => Readonly<{
    execute(
      identity: Assignment["identity"],
    ): Promise<
      Readonly<{ ok: true; value: CancelReceipt }> | Readonly<{ ok: false }>
    >;
  }>;
  AcknowledgeAgentResult: new (assignments: Assignments) => Readonly<{
    execute(command: Acknowledgement): Promise<
      | Readonly<{
          ok: true;
          value: Readonly<{ parentDelivery: RunReceipt["parentDelivery"] }>;
        }>
      | Readonly<{ ok: false }>
    >;
  }>;
  randomUUID: () => string;
  clock: () => number;
  setTimer: (callback: () => void, delayMs: number) => ExpiryTimer;
  clearTimer: (timer: ExpiryTimer) => void;
}>;
