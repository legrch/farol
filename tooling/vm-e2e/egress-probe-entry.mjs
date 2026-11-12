// Closed-contour egress probe for the VM executor: the bundled driver runs
// INSIDE the guest and reports, per synthetic endpoint, whether an outbound
// connection was observed. These reserved-address probes are DIAGNOSTIC ONLY:
// failure also occurs on online machines and does not establish default-deny.
// They must never be used as a product E2E or containment PASS.
//
// The report is the receipt; interpretation is the runner's job. In the
// offline guest every endpoint must be non-connectable; the same bundle run
// on a networked host legitimately reports connectable endpoints, which is
// why the result records the environment instead of asserting closure.
// NOT guest evidence by itself: it becomes evidence only when the staged
// bundle's manifest digests are recorded by an offline-machine run.
import { writeResult } from "./driver-runtime.mjs";
import net from "node:net";
import dns from "node:dns";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONNECT_TIMEOUT_MS = 3000;
const PROBE_CASES = [
  "tcp-test-net-1",
  "tcp-test-net-2",
  "tcp-test-net-3",
  "tcp-documentation-v6",
  "dns-invalid",
];

function probeTcp(host, port) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    const finish = (connectable, detail) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({
        endpoint: `${host}:${port}`,
        transport: "tcp",
        connectable,
        detail,
        milliseconds: Date.now() - started,
      });
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once("connect", () => finish(true, "connected"));
    socket.once("timeout", () => finish(false, "timeout"));
    socket.once("error", (error) => finish(false, error.code ?? "error"));
  });
}

function probeDns(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    dns.resolve4(name, (error, addresses) => {
      resolve({
        endpoint: name,
        transport: "dns",
        connectable: !error,
        detail: error ? (error.code ?? "error") : "resolved",
        addresses: error ? [] : addresses,
        milliseconds: Date.now() - started,
      });
    });
  });
}

export async function runProbe() {
  // RFC 5737 TEST-NET-1/-2/-3 and RFC 3849 documentation prefix must never be
  // routed; port 443 keeps the attempt TLS-shaped without touching any host.
  const endpoints = [
    probeTcp("192.0.2.1", 443),
    probeTcp("198.51.100.1", 443),
    probeTcp("203.0.113.1", 443),
    probeTcp("2001:db8::1", 443),
    probeDns("invalid.test.invalid"),
  ];
  const probes = await Promise.all(endpoints);
  return {
    scenario: "vm-e2e-egress-probe",
    probedAt: new Date().toISOString(),
    probes,
    cases: PROBE_CASES.map((id) => ({ id, status: "REPORTED" })),
    externalConnectable: probes.some((probe) => probe.connectable),
  };
}

// Execute only when this file IS the entry the runtime was given, comparing
// real paths: node resolves the entry through realpath, and on macOS the temp
// directories sit behind /var/folders → /private/var/folders symlinks. Host
// tests import runProbe without triggering a probe.
const entryArgument = process.argv[1] ? fs.realpathSync(process.argv[1]) : null;
const modulePath = fileURLToPath(import.meta.url);
if (entryArgument !== null && entryArgument === modulePath) {
  runProbe().then(
    async (result) => {
      await writeResult({ ...result, status: "REPORTED" });
      process.exit(0);
    },
    async (error) => {
      await writeResult({
        scenario: "vm-e2e-egress-probe",
        status: "FAIL",
        reason: String(error).slice(0, 2048),
        cases: PROBE_CASES.map((id) => ({ id, status: "NOT_RUN" })),
      });
      process.exit(1);
    },
  );
}
