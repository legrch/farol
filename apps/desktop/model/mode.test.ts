import { describe, expect, it } from "vitest";

import { defaultModeFor, insecurePermissionsRefusal } from "./mode";

const token = { mode: "bearer-token", token: "t" } as const;
const env = { mode: "env-key", envKeyName: "K" } as const;

describe("file mode policy", () => {
  it("refuses a group- or other-accessible file only for a literal token", () => {
    expect(insecurePermissionsRefusal(token, 0o644)).toEqual({
      status: "insecure_permissions",
      mode: 0o644,
    });
    expect(insecurePermissionsRefusal(token, 0o640)?.mode).toBe(0o640);
    expect(insecurePermissionsRefusal(token, 0o604)?.mode).toBe(0o604);
    expect(insecurePermissionsRefusal(token, 0o600)).toBeUndefined();
    expect(insecurePermissionsRefusal(token, undefined)).toBeUndefined();
    expect(insecurePermissionsRefusal(env, 0o666)).toBeUndefined();
  });

  it("creates literal-token files 0600 and others 0644", () => {
    expect(defaultModeFor(token)).toBe(0o600);
    expect(defaultModeFor(env)).toBe(0o644);
  });
});
