import { describe, expect, it } from "vitest";

import { aclVerdict } from "../../src/apps/desktop/tunnel-client-adoption";

// Portable: parses an `ls -lde` listing without touching the filesystem. The
// native adoption cases (ACLs, ownership chains) live in
// tunnel-client-adoption.test.ts, which needs macOS tools.
describe("aclVerdict", () => {
  it("reads ACL listings fail closed", () => {
    const mode = "drwx------  3 me  staff  96 Oct 21 23:02 /x";
    expect(aclVerdict(`${mode}\n`)).toBe("safe");
    expect(aclVerdict(`${mode}\n 0: group:everyone deny delete\n`)).toBe(
      "safe",
    );
    expect(
      aclVerdict(`${mode}\n 0: group:everyone allow add_file,delete_child\n`),
    ).toBe("unsafe");
    expect(
      aclVerdict(`${mode}\n 0: user:bob inherited allow write,append\n`),
    ).toBe("unsafe");
    expect(aclVerdict(`${mode}\n 0: user:me allow read,search\n`)).toBe("safe");
    expect(aclVerdict(`${mode}\n garbled entry\n`)).toBe("unsafe");
    expect(aclVerdict("")).toBe("unsafe");
  });
});
