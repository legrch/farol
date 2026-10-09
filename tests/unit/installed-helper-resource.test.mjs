import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Offline resource binding only. No helper launch, process, profile or package.
describe("installed helper resource binding", () => {
  it("pins the current checked-in helper bytes before native launch", () => {
    const launcher = readFileSync(
      new URL(
        "../../src/modules/release/infra/native/installed-update-helper.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const pins = [
      ...launcher.matchAll(/const HELPER_SHA256\s*=\s*"([a-f0-9]{64})"/gu),
    ];
    expect(pins).toHaveLength(1);
    const helper = readFileSync(
      new URL("../../resources/native/update_helper.py", import.meta.url),
    );
    expect(helper.length).toBeLessThanOrEqual(64 * 1024);
    expect(createHash("sha256").update(helper).digest("hex")).toBe(pins[0][1]);
  });
});
