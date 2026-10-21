import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

// Match commandBase's TUNNEL_CLIENT_STATE_DIR; runtime/ and profiles/ are
// separate stores. This adapter belongs only to disposable fixture evidence.
export function pollingTunnelStore(connectorRoot) {
  const root = path.join(connectorRoot, "state");
  return {
    root,
    async receipts() {
      return Promise.all(
        (await fs.readdir(root))
          .filter((name) => /^polling-tunnel-[a-f0-9-]+\.json$/u.test(name))
          .sort()
          .map(async (name) => {
            const value = JSON.parse(
              await fs.readFile(path.join(root, name), "utf8"),
            );
            assert.equal(name, `polling-tunnel-${value.id}.json`);
            return value;
          }),
      );
    },
    async controlHealth(mode) {
      const file = path.join(root, "health-control.json");
      await fs.writeFile(file + ".tmp", JSON.stringify({ mode }) + "\n", {
        mode: 0o600,
      });
      await fs.rename(file + ".tmp", file);
    },
    // "lost" closes every connection to the helper's loopback transport before
    // any HTTP status; "reachable" restores it. Disposable fixture only.
    async controlNetwork(mode) {
      assert.ok(["lost", "reachable"].includes(mode));
      const file = path.join(root, "network-control.json");
      await fs.writeFile(file + ".tmp", JSON.stringify({ mode }) + "\n", {
        mode: 0o600,
      });
      await fs.rename(file + ".tmp", file);
    },
    async control(mode) {
      const file = path.join(root, "polling-control.json");
      await fs.writeFile(file + ".tmp", JSON.stringify({ mode }) + "\n", {
        mode: 0o600,
      });
      await fs.rename(file + ".tmp", file);
    },
  };
}
