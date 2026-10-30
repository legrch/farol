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

  // A real /bin/ls -lde result is a long-format mode header followed by
  // numbered ACL rows. Incomplete or unfamiliar evidence must never grant a
  // new account permission to replace a trusted executable.
  const header = "drwx------  3 me  staff  96 Oct 21 23:02 /fixture";

  it("refuses malformed or missing long-format headers, not just malformed ACL rows", () => {
    for (const listing of [
      "ls: cannot access fixture\n",
      "total 0\n",
      "untrusted single-line response\n",
      "drwx------\n",
      "\n 0: group:everyone allow read\n",
    ]) {
      expect(aclVerdict(listing)).toBe("unsafe");
    }
  });

  it("refuses an ACL marker whose numbered entries were truncated", () => {
    expect(aclVerdict(header.replace("drwx------", "drwx------+") + "\n")).toBe(
      "unsafe",
    );
    expect(aclVerdict(header + "\n")).toBe("safe");
    // xattrs alone do not grant a different account mutation authority.
    expect(aclVerdict(header.replace("drwx------", "drwx------@") + "\n")).toBe(
      "safe",
    );
  });

  it("rejects unknown ACL rights regardless of allow or deny", () => {
    for (const verb of ["allow", "deny"]) {
      expect(
        aclVerdict(
          header + "\n 0: group:everyone " + verb + " future_mutation_right\n",
        ),
      ).toBe("unsafe");
    }
  });

  it("rejects missing, duplicated, or reordered ACL row numbers", () => {
    const row = (index: number) =>
      " " + index + ": group:everyone deny delete\n";
    for (const suffix of [
      row(1),
      row(0) + row(0),
      row(0) + row(2),
      row(1) + row(0),
    ]) {
      expect(aclVerdict(header + "\n" + suffix)).toBe("unsafe");
    }
  });

  it("accepts a bounded read-only or deny-only ACL, including inherited read", () => {
    expect(
      aclVerdict(
        header +
          "\n 0: group:everyone deny delete\n" +
          " 1: user:me inherited allow read,search,readattr,readextattr,readsecurity\n",
      ),
    ).toBe("safe");
  });

  it("refuses every known ACL mutation right even when POSIX mode is private", () => {
    for (const right of [
      "write",
      "append",
      "add_file",
      "add_subdirectory",
      "delete_child",
      "delete",
      "writeattr",
      "writeextattr",
      "writesecurity",
      "chown",
    ]) {
      expect(
        aclVerdict(
          header + "\n 0: group:everyone inherited allow " + right + "\n",
        ),
      ).toBe("unsafe");
    }
  });
});
