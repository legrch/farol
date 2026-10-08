import {
  ProductConfigurationResultSchema,
  type ProductConfigurationResult,
  type ProductConfigurationSnapshot,
} from "../../src/pkg/product-settings/contract";
import {
  connectorSetupStepResult,
  type ConnectorSetupIdentity,
} from "../../src/pkg/product-settings/connector-setup-receipt";
import { createConnectorSaveAndConnect } from "./connector-save-and-connect";

type Ports = Readonly<{
  // The composition root owns the reservation throughout this entire call.
  admission(): ProductConfigurationResult;
  current(): ProductConfigurationSnapshot;
  save(): Promise<ProductConfigurationResult>;
  start(): Promise<ProductConfigurationResult>;
}>;

// IPC reply retention, not a credential/result journal or authority owner.
// Only a content digest and the original promise survive; unknowns never evict.
export class ConnectorSetupReplies {
  private readonly replies = new Map<
    string,
    {
      fingerprint: string;
      promise: Promise<ProductConfigurationResult>;
    }
  >();

  run(
    operationId: string,
    fingerprint: string,
    dispatch: () => Promise<ProductConfigurationResult>,
    refuse: (
      code: "CONNECTOR_SETUP_BINDING_CHANGED" | "CONNECTOR_START_FAILED",
    ) => Promise<ProductConfigurationResult>,
  ): Promise<ProductConfigurationResult> {
    const retained = this.replies.get(operationId);
    if (retained)
      return retained.fingerprint === fingerprint
        ? retained.promise.then((result) => structuredClone(result))
        : refuse("CONNECTOR_SETUP_BINDING_CHANGED");
    if (this.replies.size >= 1024) return refuse("CONNECTOR_START_FAILED");
    const promise = Promise.resolve()
      .then(dispatch)
      .then((result) => structuredClone(result));
    this.replies.set(operationId, { fingerprint, promise });
    return promise.then((result) => structuredClone(result));
  }
}

/** Maps original owner results, never infers save success from a later snapshot. */
export async function runAdmittedConnectorSetup(
  identity: ConnectorSetupIdentity,
  tunnelId: string,
  ports: Ports,
): Promise<ProductConfigurationResult> {
  let original: ProductConfigurationResult = {
    ok: false,
    error: "SETTINGS_UNAVAILABLE",
    snapshot: { status: "error", error: "SETTINGS_READ_FAILED" },
  };
  let saved: ProductConfigurationSnapshot | null = null;
  const step = (result: ProductConfigurationResult) =>
    result.ok
      ? { state: "completed", code: null }
      : connectorSetupStepResult({
          state: "refused",
          code: result.error,
          ...(result.connectorAttempt
            ? { connectorAttempt: result.connectorAttempt }
            : {}),
        });
  const operation = createConnectorSaveAndConnect(identity, {
    async admit(stage) {
      original = ports.admission();
      if (!original.ok) return step(original);
      if (stage === "connection") {
        const current = ports.current();
        if (
          saved?.status !== "ready" ||
          current.status !== "ready" ||
          saved.settings.computer.computerId !==
            current.settings.computer.computerId ||
          saved.settings.computer.generation !==
            current.settings.computer.generation ||
          saved.settings.connectors.secureMcp.generation !==
            current.settings.connectors.secureMcp.generation ||
          current.settings.connectors.secureMcp.tunnelId !== tunnelId ||
          current.settings.connectors.secureMcp.credential !== "stored"
        )
          return { state: "refused", code: "CONNECTOR_SETUP_BINDING_CHANGED" };
      }
      return step(original);
    },
    async saveCredentials() {
      original = ProductConfigurationResultSchema.parse(await ports.save());
      if (original.ok) {
        saved = original.snapshot;
        if (
          saved.status !== "ready" ||
          saved.settings.connectors.secureMcp.tunnelId !== tunnelId ||
          saved.settings.connectors.secureMcp.credential !== "stored"
        )
          return { state: "unknown", code: "CONNECTOR_SETUP_STEP_UNCONFIRMED" };
      }
      return step(original);
    },
    async connect() {
      original = ProductConfigurationResultSchema.parse(await ports.start());
      if (original.ok) {
        const evidence = original.evidence;
        const current = ports.current();
        if (
          saved?.status !== "ready" ||
          current.status !== "ready" ||
          evidence?.kind !== "connector.runtime" ||
          evidence.state !== "ready" ||
          evidence.buildId !== identity.buildId ||
          evidence.computerGeneration !== saved.settings.computer.generation ||
          current.settings.connectors.secureMcp.generation !==
            saved.settings.connectors.secureMcp.generation ||
          current.settings.computer.generation !==
            saved.settings.computer.generation ||
          current.settings.connectors.secureMcp.runtime?.runtimeGeneration !==
            evidence.runtimeGeneration ||
          current.settings.connectors.secureMcp.runtime.state !== "ready" ||
          current.settings.connectors.secureMcp.runtime.buildId !==
            identity.buildId ||
          current.settings.connectors.secureMcp.runtime.connectorGeneration !==
            saved.settings.connectors.secureMcp.generation ||
          current.settings.connectors.secureMcp.runtime.computerGeneration !==
            saved.settings.computer.generation
        )
          return { state: "unknown", code: "CONNECTOR_SETUP_STEP_UNCONFIRMED" };
      }
      return step(original);
    },
  });
  const receipt = await operation.run();
  return ProductConfigurationResultSchema.parse({
    ...(receipt.state === "completed" && original.ok
      ? original
      : {
          ok: false,
          error: receipt.code,
          snapshot: original.snapshot,
          ...(receipt.connectorAttempt
            ? { connectorAttempt: receipt.connectorAttempt }
            : {}),
        }),
    connectorSetup: receipt,
  });
}
