import { spawn } from "node:child_process";
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

async function runWithReceiptFailure({ home, source, artifactSha256 }) {
  const helperPath = path.join(process.cwd(), "tooling", "promotion-apply.py");
  const program = `
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("farol_promotion_apply", sys.argv[1])
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

def fail_receipt(_parent_fd, _payload):
    helper.refuse(helper.EXIT_RECEIPT)

helper.write_receipt = fail_receipt
request = {
    "home": sys.argv[2],
    "source": sys.argv[3],
    "artifactSha256": sys.argv[4],
    "receiptBytes": b'{"operation":"applied"}\\n',
    "testHook": False,
}
try:
    helper.run(request)
except helper.Refusal as error:
    raise SystemExit(error.status)
raise SystemExit(0)
`;
  return new Promise((resolve, reject) => {
    const child = spawn(
      "/usr/bin/python3",
      [
        "-I",
        "-S",
        "-B",
        "-c",
        program,
        helperPath,
        home,
        source,
        artifactSha256,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
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

  // S35-H1R. Placement is one durable helper operation: the copy, the
  // digest and the receipt all happen inside `promotion-apply.py` before it
  // prints its success line, so `promote-preview.mjs` cannot fence between
  // them (see the note at its `verifyPromotionLease` call). What keeps a
  // second placement from landing on top of the first is the helper itself,
  // and that is what this proves against real bytes on disk.
  it("refuses a second placement into the destination a first placement made, leaving its bytes and receipt intact", async () => {
    const { root, source, home, applications } = await fixture();
    const destination = path.join(applications, "Farol Next Preview.app");
    const receipt = `${destination}.receipt.json`;
    const firstReceipt = '{"operation":"applied","generation":"A"}\n';

    await runPromotionApply({
      home,
      source,
      artifactSha256: await treeDigest(source),
      receiptText: firstReceipt,
    });
    await expect(
      fs.readFile(path.join(destination, "Contents", "payload"), "utf8"),
    ).resolves.toBe("exact\n");
    await expect(fs.readFile(receipt, "utf8")).resolves.toBe(firstReceipt);

    // A second, different generation, correctly digested: still refused,
    // because the destination is already there.
    const second = path.join(root, "second", "Farol Next Preview.app");
    await fs.mkdir(path.join(second, "Contents"), { recursive: true });
    await fs.writeFile(path.join(second, "Contents", "payload"), "second\n", {
      mode: 0o600,
    });

    await expect(
      runPromotionApply({
        home,
        source: second,
        artifactSha256: await treeDigest(second),
        receiptText: '{"operation":"applied","generation":"B"}\n',
      }),
    ).rejects.toThrow("PROMOTION_APPLY_REFUSED:72");

    // The first placement is exactly as it was: same bytes, same receipt.
    await expect(
      fs.readFile(path.join(destination, "Contents", "payload"), "utf8"),
    ).resolves.toBe("exact\n");
    await expect(fs.readFile(receipt, "utf8")).resolves.toBe(firstReceipt);
  });

  it("removes its destination after a post-copy digest refusal", async () => {
    const { source, home, applications } = await fixture();
    const destination = path.join(applications, "Farol Next Preview.app");
    const receipt = `${destination}.receipt.json`;

    await expect(
      runPromotionApply({
        home,
        source,
        artifactSha256: "0".repeat(64),
        receiptText: '{"operation":"applied"}\n',
      }),
    ).rejects.toThrow("PROMOTION_APPLY_REFUSED");
    await expect(fs.lstat(destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.lstat(receipt)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes its destination after receipt publication fails", async () => {
    const { source, home, applications } = await fixture();
    const destination = path.join(applications, "Farol Next Preview.app");
    const receipt = `${destination}.receipt.json`;
    const outcome = await runWithReceiptFailure({
      home,
      source,
      artifactSha256: await treeDigest(source),
    });

    expect(outcome).toEqual({ code: 75, signal: null, stderr: "" });
    await expect(fs.lstat(destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.lstat(receipt)).rejects.toMatchObject({ code: "ENOENT" });
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
