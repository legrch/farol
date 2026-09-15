import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { treeDigest } from "../../tooling/artifact-digest.mjs";
import { runPromotionApply } from "../../tooling/promotion-apply.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const temporary = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporary, "farol-promotion-apply-"));
  roots.push(root);
  const source = path.join(root, "source", "Farol Next Preview.app");
  const home = path.join(root, "home");
  const applications = path.join(home, "Applications");
  await fs.mkdir(path.join(source, "Contents"), { recursive: true });
  await fs.writeFile(path.join(source, "Contents", "payload"), "exact\n", {
    mode: 0o600,
  });
  await fs.mkdir(applications, { recursive: true, mode: 0o755 });
  await fs.chmod(home, 0o700);
  return { root, source, home, applications };
}

describe("descriptor-bound promotion apply", () => {
  it("keeps all writes in the opened Applications directory after a path swap", async () => {
    const { root, source, home, applications } = await fixture();
    const pinned = path.join(home, "Applications.pinned");
    const legacy = path.join(root, "legacy");
    await fs.mkdir(legacy, { mode: 0o700 });

    await runPromotionApply({
      home,
      source,
      artifactSha256: await treeDigest(source),
      receiptText: '{"operation":"applied"}\n',
      afterParentOpened: async () => {
        await fs.rename(applications, pinned);
        await fs.symlink(legacy, applications);
      },
    });

    await expect(
      fs.readFile(
        path.join(pinned, "Farol Next Preview.app", "Contents", "payload"),
        "utf8",
      ),
    ).resolves.toBe("exact\n");
    await expect(
      fs.readFile(
        path.join(pinned, "Farol Next Preview.app.receipt.json"),
        "utf8",
      ),
    ).resolves.toBe('{"operation":"applied"}\n');
    await expect(
      fs.lstat(path.join(legacy, "Farol Next Preview.app")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses an existing destination without changing it", async () => {
    const { source, home, applications } = await fixture();
    const destination = path.join(applications, "Farol Next Preview.app");
    await fs.mkdir(destination);
    await fs.writeFile(path.join(destination, "sentinel"), "keep");
    await expect(
      runPromotionApply({
        home,
        source,
        artifactSha256: await treeDigest(source),
        receiptText: '{"operation":"applied"}\n',
      }),
    ).rejects.toThrow("PROMOTION_APPLY_REFUSED");
    await expect(
      fs.readFile(path.join(destination, "sentinel"), "utf8"),
    ).resolves.toBe("keep");
  });

  it("attests the helper before it can mutate Applications", async () => {
    const { root, source, home, applications } = await fixture();
    const helperPath = path.join(root, "promotion-apply.py");
    await fs.copyFile(
      path.join(process.cwd(), "tooling", "promotion-apply.py"),
      helperPath,
    );
    await fs.appendFile(helperPath, "\n# tampered\n");
    await expect(
      runPromotionApply({
        home,
        source,
        artifactSha256: await treeDigest(source),
        receiptText: '{"operation":"applied"}\n',
        helperPath,
      }),
    ).rejects.toThrow("PROMOTION_HELPER_INVALID");
    await expect(
      fs.lstat(path.join(applications, "Farol Next Preview.app")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlinked home before creating Applications", async () => {
    const { root, source } = await fixture();
    const actualHome = path.join(root, "actual-home-without-applications");
    const linkedHome = path.join(root, "linked-home");
    await fs.mkdir(actualHome, { mode: 0o700 });
    await fs.symlink(actualHome, linkedHome);
    await expect(
      runPromotionApply({
        home: linkedHome,
        source,
        artifactSha256: await treeDigest(source),
        receiptText: '{"operation":"applied"}\n',
      }),
    ).rejects.toThrow("PROMOTION_APPLY_REFUSED");
    await expect(
      fs.lstat(path.join(actualHome, "Applications")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
