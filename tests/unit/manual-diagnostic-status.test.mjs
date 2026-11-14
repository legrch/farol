import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { parse } from "@babel/parser";
import { expect, it } from "vitest";
import { ConnectionStatusTracker } from "../../apps/desktop/connection-status.ts";
import { connectorStatus } from "../../apps/desktop/connector/supervisor.ts";
import { connectorHost } from "../support/connector-host.ts";

// Exercise the actual supervisor capture/current functions against a
// controlled Go observation. This does not claim native tray or provider acceptance.
function functions(path, names) {
  const source = fs.readFileSync(path, "utf8");
  const tree = parse(source, { sourceType: "module", plugins: ["typescript"] });
  return names
    .map((name) => {
      const node = tree.program.body.find(
        (entry) =>
          (entry.type === "FunctionDeclaration" && entry.id?.name === name) ||
          (entry.type === "ExportNamedDeclaration" &&
            entry.declaration?.id?.name === name),
      );
      if (!node) throw Error(`Missing ${name}`);
      return source.slice(node.start, node.end).replace(/^export /u, "");
    })
    .join("\n");
}

it("keeps a healthy observation through manual admission but invalidates real loss", async () => {
  const context = {
    connectorTaskAdmission: false,
    connectorTaskAdmissionPurpose: null,
    running: true,
    generation: 1,
    completedOwnerStop: { current: null },
    captureConnectorHealth: () =>
      context.running ? { generation: context.generation } : null,
    connectorHealthCurrent: (original) =>
      context.running && original.generation === context.generation,
    ownerStoppedCurrent: () => false,
  };
  const host = connectorStatus(connectorHost(context), context);
  const icon = vm.runInNewContext(
    stripTypeScriptTypes(
      `${functions("src/apps/desktop/menu-bar.ts", ["menuBarIconState"])}; menuBarIconState`,
    ),
  );
  let now = 200000;
  const tracker = new ConnectionStatusTracker({
    capture: host.captureConnectionStatus,
    current: host.connectionStatusCurrent,
    observe: async () => ({
      binding: {
        profileId: "p",
        backendGeneration: "b",
        buildId: "b",
        runtimeId: "r",
        connectorGeneration: "1",
      },
      expectedInstanceId: "i",
      sampleAtMillis: "200000",
      state: "recent_transport",
      reason: "recent_poll_success",
      observedAtMillis: "200000",
      validUntilMillis: "245000",
      lastPollSuccessMillis: "199000",
      localReady: true,
    }),
    now: () => now,
    monotonic: () => now - 200000,
  });
  await tracker.sample();
  context.connectorTaskAdmission = true;
  context.connectorTaskAdmissionPurpose = "manual-diagnostic";
  expect(host.connectionAdmissionInProgress()).toBe(false);
  expect(tracker.view().state).toBe("recent_transport");
  expect(icon(tracker.view().state, true)).toBe("filled");
  context.generation++;
  expect(tracker.view().state).toBe("unobserved");
  expect(icon(tracker.view().state, true)).toBe("attention");
  context.connectorTaskAdmissionPurpose = null;
  expect(host.captureConnectionStatus()).toBeNull();
  context.connectorTaskAdmission = false;
  context.running = false;
  expect(host.captureConnectionStatus()).toBeNull();
  now = 245000;
  expect(tracker.view().state).toBe("unobserved");
});
