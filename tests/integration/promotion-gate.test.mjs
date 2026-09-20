import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertNoOpenFindings,
  OPEN_PROMOTION_FINDINGS,
  readArtifactManifest,
  resolvePromotionUserData,
} from "../../tooling/promote-preview.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("promotion while review findings are open", () => {
  it("the barrier mechanism still refuses --apply for any open finding, whatever the current list names", () => {
    expect(() => assertNoOpenFindings(true, ["F9-9"])).toThrow(
      "PROMOTION_APPLY_BLOCKED_BY_OPEN_FINDINGS:F9-9",
    );
    expect(() => assertNoOpenFindings(true, ["F9-9", "F9-10"])).toThrow(
      "PROMOTION_APPLY_BLOCKED_BY_OPEN_FINDINGS:F9-9,F9-10",
    );
  });

  it("an empty finding list never blocks --apply", () => {
    expect(() => assertNoOpenFindings(true, [])).not.toThrow();
  });

  it("a plan-only run is never blocked, even while findings are open", () => {
    expect(() => assertNoOpenFindings(false, ["F9-9"])).not.toThrow();
  });

  it("F3-3 and F3-4 are closed: neither still names promotion's own list of open findings", () => {
    expect(OPEN_PROMOTION_FINDINGS).not.toContain("F3-3");
    expect(OPEN_PROMOTION_FINDINGS).not.toContain("F3-4");
  });
});

describe("N03/D4 --user-data resolution", () => {
  const owner = "/Users/example/Library/Application Support/Farol Next Preview";

  it("defaults to the owner's profile when the option is absent", () => {
    expect(resolvePromotionUserData(null, owner, false)).toBe(owner);
    expect(resolvePromotionUserData(null, owner, true)).toBe(owner);
  });

  it("refuses a relative path", () => {
    expect(() => resolvePromotionUserData("relative", owner, false)).toThrow(
      "PROMOTION_USER_DATA_NOT_ABSOLUTE",
    );
    expect(() => resolvePromotionUserData("./here", owner, false)).toThrow(
      "PROMOTION_USER_DATA_NOT_ABSOLUTE",
    );
  });

  it("refuses the owner's profile and anything inside it, however it is spelled", () => {
    for (const spelled of [
      owner,
      `${owner}/`,
      `${owner}/farol-next-state`,
      `${owner}/farol-next-state/../farol-next-state`,
      `${owner}/..foo`,
      "/Users/example/Library/../Library/Application Support/Farol Next Preview",
    ]) {
      expect(
        () => resolvePromotionUserData(spelled, owner, false),
        spelled,
      ).toThrow("PROMOTION_USER_DATA_IS_OWNER_PROFILE");
    }
  });

  it("accepts another absolute profile for a plan, resolved, including a sibling whose name merely starts with the owner's", () => {
    expect(resolvePromotionUserData("/tmp/profile/./x/..", owner, false)).toBe(
      "/tmp/profile",
    );
    expect(resolvePromotionUserData(`${owner}-copy`, owner, false)).toBe(
      `${owner}-copy`,
    );
    expect(
      resolvePromotionUserData(
        "/Users/example/Library/Application Support",
        owner,
        false,
      ),
    ).toBe("/Users/example/Library/Application Support");
  });

  it("never combines another profile with --apply", () => {
    expect(() => resolvePromotionUserData("/tmp/profile", owner, true)).toThrow(
      "PROMOTION_USER_DATA_APPLY_REFUSED",
    );
  });
});

describe("N03/D5 artifact manifest read", () => {
  async function scratch() {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-artifact-read-"),
    );
    roots.push(root);
    return root;
  }

  it("reads a private regular manifest and refuses everything else with a closed code", async () => {
    const root = await scratch();
    const file = path.join(root, "artifact.json");
    const manifest = { schema: 5, product: "Farol Next Preview" };
    await fs.writeFile(file, JSON.stringify(manifest), { mode: 0o600 });
    await expect(readArtifactManifest(file)).resolves.toEqual(manifest);
    // The packager writes 0600; a manifest nobody else can write to is
    // what the read requires, not one nobody else can read.
    await fs.chmod(file, 0o644);
    await expect(readArtifactManifest(file)).resolves.toEqual(manifest);

    await fs.chmod(file, 0o666);
    await expect(readArtifactManifest(file)).rejects.toThrow(
      "PROMOTION_ARTIFACT_UNREADABLE:UNSAFE",
    );
    await fs.chmod(file, 0o600);
    await fs.link(file, path.join(root, "second-link.json"));
    await expect(readArtifactManifest(file)).rejects.toThrow(
      "PROMOTION_ARTIFACT_UNREADABLE:UNSAFE",
    );
    await fs.rm(path.join(root, "second-link.json"));

    await fs.writeFile(file, `${" ".repeat(64 * 1024)}{}`, { mode: 0o600 });
    await expect(readArtifactManifest(file)).rejects.toThrow(
      "PROMOTION_ARTIFACT_UNREADABLE:OVERSIZED",
    );
    await fs.writeFile(file, " ".repeat(64 * 1024 - 2) + "{}", { mode: 0o600 });
    await expect(readArtifactManifest(file)).resolves.toEqual({});

    for (const text of ["{not json", "[]", "null", "1"]) {
      await fs.writeFile(file, text, { mode: 0o600 });
      await expect(readArtifactManifest(file), text).rejects.toThrow(
        "PROMOTION_ARTIFACT_UNREADABLE:CORRUPT",
      );
    }

    await fs.rm(file);
    await expect(readArtifactManifest(file)).rejects.toThrow(
      "PROMOTION_ARTIFACT_UNREADABLE:ABSENT",
    );

    const decoy = path.join(root, "decoy.json");
    await fs.writeFile(decoy, JSON.stringify(manifest), { mode: 0o600 });
    await fs.symlink(decoy, file);
    await expect(readArtifactManifest(file)).rejects.toThrow(
      "PROMOTION_ARTIFACT_UNREADABLE:SYMLINK",
    );
    await fs.rm(file);

    await fs.mkdir(file);
    await expect(readArtifactManifest(file)).rejects.toThrow(
      "PROMOTION_ARTIFACT_UNREADABLE:UNSAFE",
    );
  });
});
