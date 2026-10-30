import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateTunnelNotice } from "../../tooling/tunnel-notice.mjs";

const root = new URL("../../resources/native/go/", import.meta.url);
const bytes = await fs.readFile(new URL("TUNNEL_CLIENT_NOTICES.txt", root));
const evidence = JSON.parse(
  await fs.readFile(new URL("TUNNEL_CLIENT_ATTRIBUTION.json", root), "utf8"),
);

describe("version-bound tunnel notices", () => {
  it("accepts the exact reviewed notice and includes upstream license text", () => {
    expect(validateTunnelNotice(bytes, evidence)).toContain(
      "Go 1.27.0 runtime / LICENSE",
    );
  });
  it("retains each recorded module license and notice byte-for-byte", () => {
    const seen = new Set();
    for (const module of evidence.modules) {
      for (const license of module.licenses) {
        const header = Buffer.from(
          `\n${"=".repeat(72)}\n${module.module} ${module.version} / ${license.path}\n${"=".repeat(72)}\n`,
        );
        const index = bytes.indexOf(header);
        expect(
          index,
          `${module.module}/${license.path}`,
        ).toBeGreaterThanOrEqual(0);
        expect(bytes.indexOf(header, index + 1)).toBe(-1);
        const content = bytes.subarray(
          index + header.length,
          index + header.length + license.bytes,
        );
        expect(content.length).toBe(license.bytes);
        expect(createHash("sha256").update(content).digest("hex")).toBe(
          license.sha256,
        );
        seen.add(`${module.module}@${module.version}/${license.path}`);
      }
    }
    expect(evidence.modules).toHaveLength(46);
    expect(seen.size).toBe(58);
  });
  it("retains the pinned embedded Svelte license byte-for-byte", () => {
    const embedded = evidence.embeddedAdminUI;
    expect(embedded.package).toBe("svelte");
    expect(embedded.version).toBe("4.2.20");
    const header = Buffer.from(
      `\n${"=".repeat(72)}\nSvelte 4.2.20 / LICENSE.md\n${"=".repeat(72)}\n`,
    );
    const index = bytes.indexOf(header);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(bytes.indexOf(header, index + 1)).toBe(-1);
    const content = bytes.subarray(
      index + header.length,
      index + header.length + embedded.licenseBytes,
    );
    expect(content.length).toBe(1117);
    expect(createHash("sha256").update(content).digest("hex")).toBe(
      "97a941bae1c510c556c5daf017180e4939ea392357d9a7bae2657e3e20c69c42",
    );
    expect(embedded.licenseSha256).toBe(
      createHash("sha256").update(content).digest("hex"),
    );
  });
  it.each([
    "schema",
    "tunnelVersion",
    "binarySha256",
    "archiveSha256",
    "noticeSha256",
  ])("refuses altered %s evidence", (key) => {
    expect(() =>
      validateTunnelNotice(bytes, { ...evidence, [key]: "changed" }),
    ).toThrow("PACKAGE_TUNNEL_NOTICE_MISMATCH");
  });
  it("refuses modified notice bytes", () => {
    expect(() =>
      validateTunnelNotice(Buffer.concat([bytes, Buffer.from("x")]), evidence),
    ).toThrow("PACKAGE_TUNNEL_NOTICE_MISMATCH");
  });
});
