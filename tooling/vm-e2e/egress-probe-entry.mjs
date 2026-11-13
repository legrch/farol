// Closed-contour egress probe for the VM executor: the bundled driver runs
// INSIDE the guest and reports, per synthetic endpoint, whether an outbound
// connection was observed. These reserved-address probes are DIAGNOSTIC ONLY:
// every target (RFC 5737/3849 addresses, an .invalid name) is unreachable or
// unresolvable from a fully networked machine as well, so a non-connectable
// report proves nothing about isolation and never establishes default-deny.
// It must never be used as a product E2E or containment PASS.
//
// The probe can only CONTRADICT the offline configuration: the runner
// (tooling/vm-smoke.py) fails the run with CLOSED_CONTOUR_EGRESS_OBSERVED and
// records networkPolicy.runtimeEgress = "observed" when any endpoint is
// connectable. Otherwise the policy stays "machine.json-offline-configured"
// with runtimeEgress "not-verified". The host tests never run this probe
// against the real network; tooling/vm-e2e/driver-entries.synthetic.test.mjs
// exercises it with in-memory DNS/TCP doubles.
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
