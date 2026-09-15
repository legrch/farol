import type { ParentPort } from "electron";
import { z } from "zod";
import { startPreviewRuntime } from "../../boot/runtime-server";

const runtimeParentPort = (
  process as typeof process & { parentPort?: ParentPort }
).parentPort;
if (!runtimeParentPort) throw new Error("RUNTIME_PARENT_PORT_MISSING");

async function main(): Promise<void> {
  const scenarioSchema = z.enum(["normal", "failure", "stream-failure"]);
  const parsedScenario = scenarioSchema.safeParse(
    process.env.FAROL_NEXT_PREVIEW_SCENARIO,
  );
  const runtime = await startPreviewRuntime(
    parsedScenario.success ? parsedScenario.data : "normal",
  );

  runtimeParentPort.postMessage({
    kind: "runtime.ready",
    identity: runtime.identity,
    port: runtime.port,
    token: runtime.token,
    tasks: runtime.tasks,
    embeddedNode: process.versions.node,
    embeddedElectron: process.versions.electron,
  });

  let closing = false;
  runtimeParentPort.on("message", (event) => {
    if (event.data !== "shutdown" || closing) return;
    closing = true;
    void runtime.close().finally(() => {
      runtimeParentPort.postMessage({ kind: "runtime.closed" });
      process.exit(0);
    });
  });

  process.on("SIGTERM", () => {
    if (closing) return;
    closing = true;
    void runtime.close().finally(() => process.exit(0));
  });
}

void main().catch(() => {
  process.stderr.write("Farol Next runtime failed to start.\n");
  process.exit(1);
});
