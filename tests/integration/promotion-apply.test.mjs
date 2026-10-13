import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { treeDigest } from "../../tooling/artifact-digest.mjs";
import { runPromotionApply } from "../../tooling/promotion-apply.mjs";
import {
  acquirePromotionLease,
  createPromotionLeaseTransfer,
  releasePromotionLease,
} from "../../tooling/promotion-lease.mjs";

const roots = [];
const unclosedChildren = new Set();

afterEach(async () => {
  if (unclosedChildren.size !== 0)
    throw new Error(
      `PROMOTION_FIXTURE_CHILD_CLOSE_UNCONFIRMED:${roots.join(",")}`,
    );
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
  const source = path.join(root, "source", "Farol.app");
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

async function applyWithLease(options, apply = runPromotionApply) {
  const lease = await acquirePromotionLease(
    path.join(path.dirname(options.source), "promotion-userdata"),
    "disposable-promotion-fixture",
    "promotion",
  );
  if (!lease) throw new Error("PROMOTION_LEASE_HELD");
  let originalClose;
  try {
    return await apply({
      ...options,
      lease,
      onChildStarted: (closed) => {
        originalClose = closed;
        unclosedChildren.add(closed);
        void closed.then(() => {
          unclosedChildren.delete(closed);
        });
      },
    });
  } finally {
    if (originalClose && unclosedChildren.has(originalClose))
      void originalClose.then(() => releasePromotionLease(lease));
    else await releasePromotionLease(lease);
  }
}

async function runWithNativeFault({
  home,
  source,
  artifactSha256,
  lease,
  onChildStarted,
  fault = "receipt-failure",
}) {
  const transfer = await createPromotionLeaseTransfer(lease);
  if (!(await transfer.verify())) throw new Error("PROMOTION_LEASE_LOST");
  const helperPath = path.join(process.cwd(), "tooling", "promotion-apply.py");
  const program = `
import errno
import importlib.util
import json
import os
import sys

spec = importlib.util.spec_from_file_location("farol_promotion_apply", sys.argv[1])
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

def fail_receipt(_parent_fd, _payload):
    helper.refuse(helper.EXIT_RECEIPT)

fault = sys.argv[6]
def displace():
    applications = os.path.join(sys.argv[2], "Applications")
    os.rename(os.path.join(applications, "Farol.app"),
              os.path.join(applications, "Farol.retained.app"))
    if fault.endswith("replaced"):
        replacement = os.path.join(applications, "Farol.app")
        os.mkdir(replacement, 0o755)
        with open(os.path.join(replacement, "sentinel"), "w") as stream:
            stream.write("foreign replacement")

original_copy = helper.copy_tree
original_receipt = helper.write_receipt
def copy_then_displace(source_fd, destination_fd, state, depth=0):
    original_copy(source_fd, destination_fd, state, depth)
    if depth == 0:
        displace()
def receipt_then_displace(parent_fd, payload):
    published_identity = original_receipt(parent_fd, payload)
    if fault.startswith("receipt-only-"):
        applications = os.path.join(sys.argv[2], "Applications")
        receipt = os.path.join(applications, "Farol.app.receipt.json")
        retained = os.path.join(applications, "Farol.retained.receipt.json")
        os.rename(receipt, retained)
        if fault.endswith("replaced"):
            with open(receipt, "wb") as stream:
                stream.write(payload)
        elif fault.endswith("symlink"):
            os.symlink(retained, receipt)
        elif fault.endswith("hardlink"):
            os.link(retained, receipt)
    else:
        displace()
    return published_identity

original_unlink = helper.os.unlink
def fail_after_competing_receipt(name, *, dir_fd):
    if name.startswith(".Farol.app.receipt.json."):
        os.rename("Farol.app.receipt.json", "Farol.retained.receipt.json",
                  src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
        foreign = os.open("Farol.app.receipt.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                          0o600, dir_fd=dir_fd)
        try:
            os.write(foreign, b"foreign receipt")
        finally:
            os.close(foreign)
        original_unlink(name, dir_fd=dir_fd)
        raise OSError(errno.EIO, "injected post-link failure")
    original_unlink(name, dir_fd=dir_fd)

if fault == "receipt-failure":
    helper.write_receipt = fail_receipt
elif fault == "publication-competing-receipt":
    helper.os.unlink = fail_after_competing_receipt
elif fault.startswith("after-copy-"):
    helper.copy_tree = copy_then_displace
elif fault.startswith("after-receipt-") or fault.startswith("receipt-only-"):
    helper.write_receipt = receipt_then_displace
else:
    raise RuntimeError("INVALID_FIXTURE_FAULT")
request = {
    "home": sys.argv[2],
    "source": sys.argv[3],
    "artifactSha256": sys.argv[4],
    "receiptBytes": b'{"operation":"applied"}\\n',
    "testHook": False,
    "lease": json.loads(sys.argv[5]),
}
try:
    helper.run(request)
except helper.Refusal as error:
    raise SystemExit(error.status)
raise SystemExit(0)
`;
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
      JSON.stringify({ file: lease.file, ...transfer.identity }),
      fault,
    ],
    {
      stdio: [
        "ignore",
        "pipe",
        "pipe",
        "ignore",
        "ignore",
        "ignore",
        transfer.descriptor,
      ],
    },
  );
  const stderr = [];
  const stdout = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  let failure;
  child.once("error", (error) => {
    failure = error;
  });
  const closed = new Promise((resolve) => {
    child.once("close", (code, signal) =>
      resolve({
        code,
        signal,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      }),
    );
  });
  onChildStarted?.(closed);
  const outcome = await closed;
  if (failure) throw failure;
  return outcome;
}

describe("descriptor-bound promotion apply", () => {
  it("refuses placement when the pinned Applications parent is displaced", async () => {
    const { root, source, home, applications } = await fixture();
    const pinned = path.join(home, "Applications.pinned");
    const legacy = path.join(root, "legacy");
    await fs.mkdir(legacy, { mode: 0o700 });

    await expect(
      applyWithLease({
        home,
        source,
        artifactSha256: await treeDigest(source),
        receiptText: '{"operation":"applied"}\n',
        afterParentOpened: async () => {
          await fs.rename(applications, pinned);
          await fs.symlink(legacy, applications);
        },
      }),
    ).rejects.toThrow("PROMOTION_APPLY_REFUSED:71");

    await expect(
      fs.lstat(path.join(pinned, "Farol.app")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.lstat(path.join(pinned, "Farol.app.receipt.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.lstat(path.join(legacy, "Farol.app")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    "after-copy-missing",
    "after-copy-replaced",
    "after-receipt-missing",
    "after-receipt-replaced",
  ])(
    "never reports promotion success after named app displacement: %s",
    async (fault) => {
      const { source, home, applications } = await fixture();
      const destination = path.join(applications, "Farol.app");
      const receipt = `${destination}.receipt.json`;
      const outcome = await applyWithLease(
        {
          home,
          source,
          artifactSha256: await treeDigest(source),
          fault,
        },
        runWithNativeFault,
      );
      expect(outcome).toEqual({
        code: 71,
        signal: null,
        stderr: "",
        stdout: "",
      });
      await expect(
        fs.readFile(
          path.join(applications, "Farol.retained.app", "Contents", "payload"),
          "utf8",
        ),
      ).resolves.toBe("exact\n");
      if (fault.endsWith("replaced")) {
        await expect(
          fs.readFile(path.join(destination, "sentinel"), "utf8"),
        ).resolves.toBe("foreign replacement");
      } else {
        await expect(fs.lstat(destination)).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      if (fault.startsWith("after-receipt-")) {
        await expect(fs.readFile(receipt, "utf8")).resolves.toBe(
          '{"operation":"applied"}\n',
        );
      } else {
        await expect(fs.lstat(receipt)).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    },
  );

  it.each(["missing", "replaced", "symlink", "hardlink"])(
    "never reports promotion success after receipt-only displacement: %s",
    async (variant) => {
      const { source, home, applications } = await fixture();
      const expected = await treeDigest(source);
      const outcome = await applyWithLease(
        {
          home,
          source,
          artifactSha256: expected,
          fault: `receipt-only-${variant}`,
        },
        runWithNativeFault,
      );
      expect(outcome).toEqual({
        code: 75,
        signal: null,
        stderr: "",
        stdout: "",
      });
      expect(await treeDigest(path.join(applications, "Farol.app"))).toBe(
        expected,
      );
      await expect(
        fs.readFile(
          path.join(applications, "Farol.retained.receipt.json"),
          "utf8",
        ),
      ).resolves.toBe('{"operation":"applied"}\n');
      const receipt = path.join(applications, "Farol.app.receipt.json");
      if (variant === "missing") {
        await expect(fs.lstat(receipt)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } else if (variant === "symlink") {
        expect((await fs.lstat(receipt)).isSymbolicLink()).toBe(true);
      } else {
        await expect(fs.readFile(receipt, "utf8")).resolves.toBe(
          '{"operation":"applied"}\n',
        );
        expect((await fs.lstat(receipt)).nlink).toBe(
          variant === "hardlink" ? 2 : 1,
        );
      }
    },
  );

  it("preserves a competing receipt after its own post-link publication failure", async () => {
    const { source, home, applications } = await fixture();
    const outcome = await applyWithLease(
      {
        home,
        source,
        artifactSha256: await treeDigest(source),
        fault: "publication-competing-receipt",
      },
      runWithNativeFault,
    );
    expect(outcome).toEqual({ code: 75, signal: null, stderr: "", stdout: "" });
    await expect(
      fs.readFile(path.join(applications, "Farol.app.receipt.json"), "utf8"),
    ).resolves.toBe("foreign receipt");
    await expect(
      fs.readFile(
        path.join(applications, "Farol.retained.receipt.json"),
        "utf8",
      ),
    ).resolves.toBe('{"operation":"applied"}\n');
  });

  it("refuses an existing destination without changing it", async () => {
    const { source, home, applications } = await fixture();
    const destination = path.join(applications, "Farol.app");
    await fs.mkdir(destination);
    await fs.writeFile(path.join(destination, "sentinel"), "keep");
    await expect(
      applyWithLease({
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
  // digest and the receipt all happen inside `promotion-apply.py` under the
  // inherited original lease before its success line. The helper checks that
  // descriptor before copy and publication. What keeps a
  // second placement from landing on top of the first is the helper itself,
  // and that is what this proves against real bytes on disk.
  it("refuses a second placement into the destination a first placement made, leaving its bytes and receipt intact", async () => {
    const { root, source, home, applications } = await fixture();
    const destination = path.join(applications, "Farol.app");
    const receipt = `${destination}.receipt.json`;
    const firstReceipt = '{"operation":"applied","generation":"A"}\n';

    await applyWithLease({
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
    const second = path.join(root, "second", "Farol.app");
    await fs.mkdir(path.join(second, "Contents"), { recursive: true });
    await fs.writeFile(path.join(second, "Contents", "payload"), "second\n", {
      mode: 0o600,
    });

    await expect(
      applyWithLease({
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
    const destination = path.join(applications, "Farol.app");
    const receipt = `${destination}.receipt.json`;

    await expect(
      applyWithLease({
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
    const destination = path.join(applications, "Farol.app");
    const receipt = `${destination}.receipt.json`;
    const outcome = await applyWithLease(
      {
        home,
        source,
        artifactSha256: await treeDigest(source),
      },
      runWithNativeFault,
    );

    expect(outcome).toEqual({ code: 75, signal: null, stderr: "", stdout: "" });
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
      applyWithLease({
        home,
        source,
        artifactSha256: await treeDigest(source),
        receiptText: '{"operation":"applied"}\n',
        helperPath,
      }),
    ).rejects.toThrow("PROMOTION_HELPER_INVALID");
    await expect(
      fs.lstat(path.join(applications, "Farol.app")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlinked home before creating Applications", async () => {
    const { root, source } = await fixture();
    const actualHome = path.join(root, "actual-home-without-applications");
    const linkedHome = path.join(root, "linked-home");
    await fs.mkdir(actualHome, { mode: 0o700 });
    await fs.symlink(actualHome, linkedHome);
    await expect(
      applyWithLease({
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
