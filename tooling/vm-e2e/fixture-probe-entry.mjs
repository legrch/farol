// Closed-contour fixture-server probe: the bundled driver runs INSIDE the
// guest, starts a loopback-only HTTP fixture that emulates the shape the
// ordinary suites bind through FAROL_E2E_CHATGPT_URL (setup page, chat page,
// JSON endpoints), exercises it over fetch, and records per-check results.
// This proves the guest-local fixture topology the closed executor depends
// on: guest loopback serves guest requests, nothing binds a host-reachable
// address, and a missing route fails the check instead of falling anywhere.
//
// The fixture is SYNTHETIC: it proves the transport and the driver contract,
// not compatibility with the live provider — that stays explicit QA. It never
// contacts anything but its own 127.0.0.1 listener.
import { writeResult } from "./driver-runtime.mjs";
import http from "node:http";

const FIXTURE_HTML = `<!doctype html><html><body>
<button aria-label="Set up">Set up</button>
<textarea aria-label="Prompt"></textarea>
</body></html>
`;

function startFixture() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/") {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          connection: "close",
        });
        response.end(FIXTURE_HTML);
        return;
      }
      if (url.pathname === "/backend-api/models") {
        response.writeHead(200, {
          "content-type": "application/json",
          connection: "close",
        });
        response.end(
          JSON.stringify({ synthetic: true, models: ["fixture-model"] }),
        );
        return;
      }
      // A missing route must fail the caller: no fallback, no silent 200.
      response.writeHead(404, { connection: "close" });
      response.end("not found");
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function check(name, run) {
  try {
    const detail = await run();
    return { name, ok: true, detail };
  } catch (error) {
    return {
      name,
      ok: false,
      detail: String(error && error.message ? error.message : error),
    };
  }
}

export async function runFixtureProbe() {
  const server = await startFixture();
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const checks = [];
  try {
    checks.push(
      await check("setup-page-status", async () => {
        const response = await fetch(`${base}/`);
        if (response.status !== 200)
          throw new Error(`status ${response.status}`);
        const body = await response.text();
        if (!body.includes('aria-label="Set up"'))
          throw new Error("fixture page shape mismatch");
        return { bytes: body.length };
      }),
    );
    checks.push(
      await check("json-endpoint", async () => {
        const response = await fetch(`${base}/backend-api/models`);
        if (response.status !== 200)
          throw new Error(`status ${response.status}`);
        const payload = await response.json();
        if (payload.synthetic !== true) throw new Error("unexpected payload");
        return { models: payload.models.length };
      }),
    );
    checks.push(
      await check("missing-route-fails-closed", async () => {
        const response = await fetch(`${base}/definitely-missing`);
        if (response.status !== 404)
          throw new Error(`expected 404, got ${response.status}`);
        return { status: response.status };
      }),
    );
    checks.push(
      await check("loopback-only-binding", async () => {
        // The listener must be bound to 127.0.0.1, never a wildcard address.
        if (address.address !== "127.0.0.1")
          throw new Error(`bound to ${address.address}`);
        return { address: address.address, port: address.port };
      }),
    );
    const failed = checks.filter((check) => !check.ok);
    return {
      scenario: "vm-e2e-fixture-probe",
      fixtureUrl: base,
      checks,
      cases: checks.map((check) => ({
        id: check.name,
        status: check.ok ? "PASS" : "FAIL",
      })),
      ok: failed.length === 0,
      failed: failed.map((check) => check.name),
    };
  } finally {
    server.closeIdleConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

// Execute only when this file IS the runtime entry (real-path comparison; on
// macOS the temp directories sit behind /var/folders symlinks). Host tests
// import runFixtureProbe directly.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const entryArgument = process.argv[1] ? fs.realpathSync(process.argv[1]) : null;
const modulePath = fileURLToPath(import.meta.url);
if (entryArgument !== null && entryArgument === modulePath) {
  runFixtureProbe().then(
    async (result) => {
      await writeResult({ ...result, status: result.ok ? "PASS" : "FAIL" });
      process.exit(result.ok ? 0 : 1);
    },
    async (error) => {
      await writeResult({
        scenario: "vm-e2e-fixture-probe",
        status: "FAIL",
        reason: String(error).slice(0, 2048),
        cases: [
          "setup-page-status",
          "json-endpoint",
          "missing-route-fails-closed",
          "loopback-only-binding",
        ].map((id) => ({ id, status: "NOT_RUN" })),
      });
      process.exit(1);
    },
  );
}
