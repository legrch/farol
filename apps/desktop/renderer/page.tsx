import type { ReactNode } from "react";
import type {
  ProductConfigurationCommand,
  ProductSettings,
} from "../../../src/pkg/product-settings/contract";
import type {
  Intent,
  RendererFacade,
  WindowSnapshot,
} from "../../../src/ui/renderer/contract";

export type SettingsProps = Readonly<{
  snapshot: WindowSnapshot;
  facade: RendererFacade;
  setupStep?: "signin" | "connection" | "folders" | "attachment" | undefined;
  unresolvedSheet?: boolean;
  setupTestActionHost?: HTMLElement | null | undefined;
  setupInputsChanged?: boolean | undefined;
  onSetupInputsChange?: ((changed: boolean) => void) | undefined;
}>;
export type ActionDispatch =
  | Readonly<{ state: "not-sent" }>
  | Readonly<{ state: "attempted"; result: Intent | null }>;
export type Actions = {
  refresh(): Promise<Intent | null>;
  disabled: boolean;
  computerPauseReason: string | null;
  allowed(
    kind: ProductConfigurationCommand["kind"],
    workspaceId?: string,
  ): boolean;
  run(
    command: ProductConfigurationCommand,
    admit?: (current: WindowSnapshot) => boolean,
  ): Promise<Intent | null>;
  runClassified(
    command: ProductConfigurationCommand,
    admit?: (current: WindowSnapshot) => boolean,
  ): Promise<ActionDispatch>;
};
export type PageProps = SettingsProps & {
  settings: ProductSettings;
  actions: Actions;
};
export function Group({
  title,
  children,
  showTitle = true,
}: {
  title: string;
  children: ReactNode;
  showTitle?: boolean;
}) {
  return (
    <section className="settings-group" aria-label={title}>
      {showTitle && <h3>{title}</h3>}
      {children}
    </section>
  );
}
export function Command({
  command,
  actions,
  children,
  className = "subtle",
  disabled = false,
  admit,
}: {
  command: ProductConfigurationCommand;
  actions: Actions;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  admit?: (current: WindowSnapshot) => boolean;
}) {
  const workspaceId =
    "workspaceId" in command ? command.workspaceId : undefined;
  return (
    <button
      type="button"
      className={className}
      disabled={disabled || !actions.allowed(command.kind, workspaceId)}
      onClick={() => void actions.run(command, admit)}
    >
      {children}
    </button>
  );
}
