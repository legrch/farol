import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { readInstalledProcess } from "../../src/apps/desktop/installed-update-runtime";

it.skipIf(process.platform !== "darwin")(
  "observes a live update helper using the same locale as its captured identity",
  async () => {
    const args = ["-p", String(process.pid), "-o", "lstart="];
    const canonical = execFileSync("/bin/ps", args, {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    }).trim();
    const previous = process.env.LC_ALL;
    try {
      process.env.LC_ALL = "en_GB.UTF-8";
      const observation = await readInstalledProcess(process.pid);
      expect(observation.stderr).toBe("");
      expect(observation.stdout.trim()).toBe(canonical);
    } finally {
      if (previous === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = previous;
    }
  },
);

it.skipIf(process.platform !== "darwin")(
  "retains timezone parity with the installed helper",
  async () => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Honolulu";
      const canonical = execFileSync(
        "/bin/ps",
        ["-p", String(process.pid), "-o", "lstart="],
        {
          encoding: "utf8",
          env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: process.env.TZ },
        },
      ).trim();
      const observation = await readInstalledProcess(process.pid);
      expect(observation.stdout.trim()).toBe(canonical);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  },
);
