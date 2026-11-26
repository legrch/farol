import { z } from "zod";
import { defaultNavigationShortcuts } from "../../../src/pkg/ipc/navigation-shortcuts";
import { BuildIdentitySchema } from "../../../src/pkg/build-info/identity";
import {
  BrowserHistoryStateSchema,
  BrowserRouteStatusSchema,
} from "../../../src/pkg/ipc/runtime-status";
import { ChatHistoryContextSchema } from "../../../src/pkg/ipc/chat-history";
import { WindowStateSchema } from "../../../src/pkg/ipc/shell-state";
import { ProductConfigurationSnapshotSchema } from "../../../src/pkg/product-settings/contract";
import type { ProductConfigurationEvidence } from "../../../src/pkg/product-settings/contract";
import { ProductTasksStateSchema } from "../../../src/modules/chat/contract/product-task";
import type {
  Destination,
  Intent,
  RendererFacade,
  WindowSnapshot,
} from "../../../src/ui/renderer/contract";
import { ConnectionStatusViewSchema } from "./connection-status";
import { defaultSidebarPreference } from "./sidebar-presentation";

type EditPreview = Extract<
  ProductConfigurationEvidence,
  { kind: "computer.workspace-edit-preview" }
>;
export type EditReceipt = Readonly<{
  preview: EditPreview;
  configuration: WindowSnapshot["configuration"];
  buildId: string;
  computerId: string;
  generation: number;
}>;
export type SubmittedEdit = Readonly<{
  intention: string;
  receipt: EditReceipt | null;
}>;
export type ObservedEdit = Readonly<{
  submitted: SubmittedEdit;
  configuration: WindowSnapshot["configuration"];
  evidence: WindowSnapshot["evidence"];
  state: "applied" | "refused";
  code: string | null;
}>;

// Parse only the renderer-safe projection; never retain the raw bootstrap object.
export const BootstrapProjectionSchema = z.object({
  schema: z.literal(3),
  environment: z.enum(["preview", "dev", "owner-preview"]),
  build: BuildIdentitySchema,
  configuration: ProductConfigurationSnapshotSchema,
  runtimeState: z.enum(["starting", "ready", "offline", "failed"]),
  independentSession: z.boolean().optional(),
  connectionStatus: ConnectionStatusViewSchema.optional(),
  browserRouteState: BrowserRouteStatusSchema.optional(),
  browserHistoryState: BrowserHistoryStateSchema.optional(),
  selectedTaskId: z.string().default(""),
  taskRevision: z.number().int().nonnegative(),
  tasks: ProductTasksStateSchema.shape.tasks,
  windowState: WindowStateSchema,
  chatHistoryContext: ChatHistoryContextSchema.nullable().optional(),
});
export const home: Destination = { area: "home", page: "general", taskId: "" };
export const initial: WindowSnapshot = {
  status: "starting",
  environment: "preview",
  buildId: null,
  installedVersion: null,
  configuration: null,
  tasks: { revision: 0, tasks: [] },
  activity: [],
  runtime: "starting",
  route: "loading",
  signInObservation: null,
  setupSignInReturn: null,
  update: { phase: "unavailable", code: "UPDATE_STATUS_PENDING" },
  intents: {},
  evidence: null,
  readPreview: null,
  readConversation: null,
  directChatPreview: null,
  chatHistoryContext: null,
  chatHistoryEpoch: 0,
  shortcuts: { ...defaultNavigationShortcuts },
  workspaceEditDelivery: null,
  destination: home,
  back: false,
  forward: false,
  sidebar: defaultSidebarPreference,
  overlay: "none",
  window: { focused: false, fullScreen: false, trafficLightPosition: null },
  appearance: { theme: "system", accent: "iris", font: "geist" },
  capabilities: {
    incarnation: false,
    sequence: false,
    operationQuery: "workspace-edit-only",
    overlayAcknowledgement: false,
  },
};
// This additive renderer capability stays within the controller slice while
// transitional facades without it remain observation-only.
export type InstallOnQuitFacade = RendererFacade & {
  setInstallOnQuitPreference(enabled: boolean): Promise<Intent>;
};
export function installOnQuitPreferenceEligible(
  snapshot: WindowSnapshot,
): boolean {
  const update = snapshot.update;
  const unsettled = (key: string) =>
    snapshot.intents[key]?.state === "pending" ||
    snapshot.intents[key]?.state === "unknown";
  return (
    snapshot.environment === "preview" &&
    snapshot.status === "current" &&
    snapshot.runtime === "ready" &&
    Boolean(snapshot.buildId) &&
    update.installOnQuitPreference?.status === "confirmed" &&
    update.installOnQuitPreference.scope === "install-on-normal-quit" &&
    snapshot.intents["update-install-on-quit"]?.state !== "unknown" &&
    snapshot.intents["update-automatic-downloads"]?.state !== "pending" &&
    !unsettled("update") &&
    !("blockedBy" in update && update.blockedBy?.includes("UNKNOWN")) &&
    (update.phase === "idle" ||
      update.phase === "available" ||
      update.phase === "ready" ||
      (update.phase === "failed" &&
        !update.recoveryRequired &&
        !update.code.includes("UNKNOWN")))
  );
}
export function canSetInstallOnQuitPreference(
  snapshot: WindowSnapshot,
  facade: RendererFacade,
): facade is InstallOnQuitFacade {
  return (
    "setInstallOnQuitPreference" in facade &&
    typeof facade.setInstallOnQuitPreference === "function" &&
    snapshot.intents["update-install-on-quit"]?.state !== "pending" &&
    installOnQuitPreferenceEligible(snapshot)
  );
}
