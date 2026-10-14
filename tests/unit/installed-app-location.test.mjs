import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Pure/disposable native boundaries; no installed app/profile/process observation.
it("checks native shared-parent, selection, relaunch and legacy-request boundaries", () => {
  const result = execFileSync(
    "/usr/bin/python3",
    [
      "-I",
      "-S",
      "-B",
      fileURLToPath(
        new URL("./installed-app-location.test.py", import.meta.url),
      ),
      "-v",
    ],
    {
      encoding: "utf8",
      timeout: 5000,
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    },
  );
  expect(result).toBe("");
});
