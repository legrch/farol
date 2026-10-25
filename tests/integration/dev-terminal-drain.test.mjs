import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Real POSIX process-group signal, synthetic app/Go children. This does not
// prove an Electron Quit or clean receipt for an owner profile.
it.skipIf(process.platform === "win32")(
  "terminal Ctrl+C reaches the Dev owner without terminating its undrained descendant",
  async () => {
    const wrapper = spawn(
      process.execPath,
      [
        fileURLToPath(
          new URL(
            "../fixtures/dev-tooling/terminal-owner.mjs",
            import.meta.url,
          ),
        ),
      ],
      {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "",
      error = "",
      closed = false;
    const terminal = new Promise((resolve, reject) => {
      wrapper.once("error", reject);
      wrapper.once("close", (code, signal) => {
        closed = true;
        resolve({ code, signal });
      });
    });
    const ready = new Promise((resolve) => {
      wrapper.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (output.includes("TERMINAL_FIXTURE_READY")) resolve();
      });
    });
    wrapper.stderr.on("data", (chunk) => {
      error += chunk.toString();
    });
    let watchdog;
    const deadline = new Promise((_, reject) => {
      watchdog = setTimeout(
        () => reject(Error("TERMINAL_FIXTURE_DEADLINE")),
        12000,
      );
    });
    try {
      await Promise.race([
        ready,
        terminal.then(() => {
          throw Error("TERMINAL_FIXTURE_EARLY_EXIT:" + error);
        }),
        deadline,
      ]);
      // This is exactly one freshly spawned fixture's group, never inventory.
      process.kill(-wrapper.pid, "SIGINT");
      const outcome = await Promise.race([terminal, deadline]);
      expect(outcome).toEqual({ code: 130, signal: null });
      expect(output).toContain("DESCENDANT_DRAIN_CONFIRMED");
      expect(output).not.toContain("DESCENDANT_DRAIN_UNCONFIRMED");
    } finally {
      clearTimeout(watchdog);
      if (!closed) {
        process.kill(-wrapper.pid, "SIGKILL");
        await terminal;
      }
    }
  },
  15000,
);
