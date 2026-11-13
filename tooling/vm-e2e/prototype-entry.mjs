// Synthetic in-guest e2e entry for the vm-e2e driver bundle prototype
// (farol.vm-e2e/1). It starts a loopback-only HTTP server on 127.0.0.1:0,
// asserts the served page over fetch, publishes the outcome through
// driver-runtime's writeResult, and exits 0 on pass or 1 on failure.
//
// Scope: this proves the bundling and staging SHAPE only. It is a synthetic
// scenario, not a real product journey; it is NOT guest evidence, NOT network
// containment evidence, and claims no VM qualification. It must keep importing
// only node: builtins plus ./driver-runtime.mjs so both bundler paths stay
// valid, and it must never import from tests/ or vm-smoke/.
import http from "node:http";
import { writeResult } from "./driver-runtime.mjs";

const PAGE = "<html><body>farol vm-e2e prototype</body></html>\n";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

async function run() {
  const server = http.createServer((request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      connection: "close",
    });
    response.end(PAGE);
  });
  try {
    const address = await listen(server);
    const url = "http://127.0.0.1:" + address.port + "/";
    const response = await fetch(url);
    const body = await response.text();
    if (response.status !== 200) {
      throw new Error("UNEXPECTED_HTTP_STATUS: " + response.status);
    }
    if (body !== PAGE) throw new Error("UNEXPECTED_PAGE_BODY");
    await writeResult({
      status: "PASS",
      scenario: "vm-e2e-prototype",
      cases: [
        { id: "http-status", status: "PASS" },
        { id: "response-body", status: "PASS" },
      ],
      url,
      checks: {
        httpStatus: response.status,
        bodyBytes: Buffer.byteLength(body),
      },
    });
    return 0;
  } catch (error) {
    await writeResult({
      status: "FAIL",
      scenario: "vm-e2e-prototype",
      cases: [
        { id: "http-status", status: "NOT_RUN" },
        { id: "response-body", status: "NOT_RUN" },
      ],
      reason: String(error && error.message ? error.message : error),
    });
    return 1;
  } finally {
    server.closeIdleConnections();
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

run().then(
  (code) => process.exit(code),
  (error) => {
    console.error("PROTOTYPE_ENTRY_CRASH: " + String(error));
    process.exit(1);
  },
);
