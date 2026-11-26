import type { ProductConfigurationService } from "../../../src/apps/desktop/product-configuration";
import type { SecureMcpConnectorRuntime } from "../../../src/apps/desktop/secure-mcp-connector-runtime";
import type { ComputerConnectorBinding } from "../bridge/wire";
import type { DesktopGoCore } from "../go-core-host";
import type { OwnerStopPresentation } from "../owner-stop-presentation";

export type ConnectorTransportCapture = Readonly<{
  key: string;
  owner: ProductConfigurationService;
  connector: SecureMcpConnectorRuntime;
  core: DesktopGoCore;
  binding: Readonly<ComputerConnectorBinding>;
  revision: number;
  computerGeneration: number;
  connectorGeneration: number;
  runtimeGeneration: string;
}>;

export type ConnectorHealthCapture = Readonly<{
  owner: ProductConfigurationService;
  connector: SecureMcpConnectorRuntime;
  core: DesktopGoCore;
  binding: Readonly<ComputerConnectorBinding>;
  runtimeGeneration: string;
  computerGeneration: number;
  connectorGeneration: number;
}>;

export type OwnerStoppedCapture = OwnerStopPresentation &
  Readonly<{
    owner: ProductConfigurationService;
    connector: SecureMcpConnectorRuntime;
    core: DesktopGoCore;
  }>;
export type ConnectionStatusCapture =
  | Readonly<{ kind: "running"; original: ConnectorHealthCapture }>
  | Readonly<{ kind: "owner-stopped"; original: OwnerStoppedCapture }>;

/** The correlation key of one admitted tunnel runtime. */
export function transportKey(
  binding: Readonly<ComputerConnectorBinding>,
  runtimeGeneration: string,
): string {
  return [
    binding.profileId,
    binding.backendGeneration,
    binding.runtimeId,
    runtimeGeneration,
  ].join("/");
}

/** Whether every field of the original binding still holds in the current one. */
export function bindingMatches(
  original: Readonly<ComputerConnectorBinding>,
  current: Readonly<ComputerConnectorBinding>,
): boolean {
  return Object.entries(original).every(
    ([key, value]) => current[key as keyof ComputerConnectorBinding] === value,
  );
}
