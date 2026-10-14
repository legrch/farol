import type { ParentPort } from "electron";
import { z } from "zod";
import { startPreviewRuntime } from "../../boot/runtime-server";
import { runParentOwnedRuntime } from "./parent-owned-runtime";

const utilityParentPort = (
  process as typeof process & { parentPort?: ParentPort }
).parentPort;
const runtimeParentPort =
  utilityParentPort ??
  (process.send
    ? {
        postMessage: (message: unknown) =>
          process.send!(
            message as Parameters<NonNullable<typeof process.send>>[0],
            () => {},
          ),
        on: (_event: "message", handler: (event: { data: unknown }) => void) =>
          process.on("message", (message) => handler({ data: message })),
      }
    : undefined);
if (!runtimeParentPort) throw new Error("RUNTIME_PARENT_PORT_MISSING");

async function main(): Promise<void> {
  const scenarioSchema = z.enum([
    "normal",
    "failure",
    "stream-failure",
    "startup-failure",
  ]);
  const parsedScenario = scenarioSchema.safeParse(
    process.env.FAROL_NEXT_PREVIEW_SCENARIO,
  );
  const parsedMode = z
    .enum(["empty", "demo"])
    .safeParse(process.env.FAROL_NEXT_PREVIEW_MODE);
  const parsedIdentity = z
    .enum(["farol-next-preview-runtime", "farol-dev-runtime"])
    .safeParse(process.env.FAROL_NEXT_RUNTIME_IDENTITY);
  const scenario = parsedScenario.success ? parsedScenario.data : "normal";
  if (scenario === "startup-failure") {
    throw new Error("RUNTIME_START_FAILURE_FIXTURE");
  }
  await runParentOwnedRuntime(
    () =>
      startPreviewRuntime(
        scenario,
        parsedMode.success ? parsedMode.data : "empty",
        parsedIdentity.success
          ? parsedIdentity.data
          : "farol-next-preview-runtime",
      ),
    {
      onStop: (stop) => {
        runtimeParentPort.on("message", (event) => {
          if (event.data === "shutdown") stop();
        });
        process.once("disconnect", stop);
        process.once("SIGTERM", stop);
      },
      connected: () => utilityParentPort != null || process.connected === true,
      ready: (runtime) =>
        runtimeParentPort.postMessage({
          kind: "runtime.ready",
          identity: runtime.identity,
          port: runtime.port,
          token: runtime.token,
          tasks: runtime.tasks,
          embeddedNode: process.versions.node,
          embeddedElectron: process.versions.electron,
        }),
      closed: () => runtimeParentPort.postMessage({ kind: "runtime.closed" }),
      exit: (code) => process.exit(code),
    },
  );
}

void main().catch(() => {
  process.stderr.write("Farol Next runtime failed to start.\n");
  process.exit(1);
});
