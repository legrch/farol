// Real disposable macOS lease/file semantics. No app, bundle, provider or owner
// profile is exercised; packaged startup/relaunch remains a higher boundary.
// I/O errors are explicitly injected; successful completion is a fixture rename,
// not evidence of a replacement producer, receipt or recovery implementation.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquirePromotionLease,
  releasePromotionLease,
  verifyPromotionLease,
  type PromotionLeaseHandle,
} from "../../src/apps/desktop/promotion-lease";
import { withStartupPromotionLease } from "../../src/apps/desktop/startup-promotion-lease";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true });
});
async function root(): Promise<string> {
  const result = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-startup-lease-"),
  );
  roots.push(result);
  return result;
}
async function expectPromotionExcluded(userData: string): Promise<void> {
  const competing = await acquirePromotionLease(
    userData,
    "updater",
    "promotion",
  );
  try {
    expect(competing).toBeNull();
  } finally {
    if (competing) await releasePromotionLease(competing);
  }
}

describe("startup and updater use the same native exclusion", () => {
  it("lends the original native handle only within the startup boundary", async () => {
    // Retained even on failure; this is a native lock witness, not app recovery.
    const userData = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-startup-borrowed-"),
    );
    console.info("Retained startup borrowed-lease fixture:", userData);
    let borrowed: PromotionLeaseHandle | undefined;
    await withStartupPromotionLease(
      userData,
      "borrowed-startup",
      async (verify, lease) => {
        borrowed = lease;
        expect(lease.file).toBe(
          path.join(userData, "farol-next-state", "promotion.lease"),
        );
        expect(lease.record).toMatchObject({
          role: "admission",
          generation: "borrowed-startup",
          pid: process.pid,
        });
        expect(await verify()).toBe(true);
        expect(await verifyPromotionLease(lease)).toBe(true);
        expect(await verifyPromotionLease(structuredClone(lease))).toBe(false);
        await expectPromotionExcluded(userData);
        expect(await verify()).toBe(true);
      },
    );
    if (!borrowed) throw Error("startup callback did not receive its lease");
    expect(await verifyPromotionLease(borrowed)).toBe(false);
    const next = await acquirePromotionLease(
      userData,
      "successor",
      "promotion",
    );
    try {
      expect(next).not.toBeNull();
    } finally {
      if (next) await releasePromotionLease(next);
    }
  });

  it.each([
    ["nonterminal", '{"phase":"placement_intent"}\n'],
    ["completed-looking", '{"phase":"completed"}\n'],
    ["invalid", "not json\n"],
    ["empty", ""],
  ])(
    "refuses %s intent before readiness and preserves its bytes and inode",
    async (_name, bytes) => {
      const userData = await root();
      const state = path.join(userData, "farol-next-state");
      await fs.mkdir(state, { mode: 0o700 });
      const pending = path.join(state, "installed-replacement.pending");
      const marker = path.join(state, "running.json");
      await fs.writeFile(pending, bytes, { mode: 0o600 });
      await fs.writeFile(marker, "original unconfirmed runtime\n", {
        mode: 0o600,
      });
      const original = await fs.lstat(pending);
      const critical = vi.fn(async () => true);
      await expect(
        withStartupPromotionLease(userData, "candidate", critical),
      ).rejects.toThrow("STARTUP_INSTALLED_REPLACEMENT_PENDING");
      expect(critical).not.toHaveBeenCalled();
      expect(await fs.readFile(pending, "utf8")).toBe(bytes);
      const retained = await fs.lstat(pending);
      expect([retained.dev, retained.ino, retained.mode]).toEqual([
        original.dev,
        original.ino,
        original.mode,
      ]);
      expect(await fs.readFile(marker, "utf8")).toBe(
        "original unconfirmed runtime\n",
      );
      // Refusal releases only startup's acquired handle; the durable fence stays.
      const admission = await acquirePromotionLease(
        userData,
        "probe",
        "admission",
      );
      expect(admission).not.toBeNull();
      if (admission) await releasePromotionLease(admission);
    },
  );

  it.each(["symlink", "directory", "unreadable"])(
    "refuses a %s pending entry without opening or changing it",
    async (kind) => {
      const userData = await root();
      const state = path.join(userData, "farol-next-state");
      await fs.mkdir(state, { mode: 0o700 });
      const pending = path.join(state, "installed-replacement.pending");
      if (kind === "symlink") await fs.symlink("absent-intent-target", pending);
      else if (kind === "directory") await fs.mkdir(pending, { mode: 0o700 });
      else await fs.writeFile(pending, "unreadable", { mode: 0o000 });
      const original = await fs.lstat(pending);
      const critical = vi.fn(async () => true);
      await expect(
        withStartupPromotionLease(userData, "candidate", critical),
      ).rejects.toThrow("STARTUP_INSTALLED_REPLACEMENT_PENDING");
      expect(critical).not.toHaveBeenCalled();
      const retained = await fs.lstat(pending);
      expect([retained.dev, retained.ino, retained.mode]).toEqual([
        original.dev,
        original.ino,
        original.mode,
      ]);
      if (kind === "symlink")
        expect(await fs.readlink(pending)).toBe("absent-intent-target");
    },
  );

  it.each(["EIO", "EACCES", "ENOTDIR"])(
    "refuses %s filesystem observation under the same held lease",
    async (code) => {
      const userData = await root();
      const pending = path.join(
        userData,
        "farol-next-state",
        "installed-replacement.pending",
      );
      const original = fs.lstat.bind(fs);
      const fault = Object.assign(
        new Error("fixture I/O observation unknown"),
        {
          code,
        },
      );
      vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        if (args[0] === pending) {
          await expectPromotionExcluded(userData);
          throw fault;
        }
        return original(...args);
      });
      const critical = vi.fn(async () => true);
      await expect(
        withStartupPromotionLease(userData, "candidate", critical),
      ).rejects.toMatchObject({
        message: "STARTUP_INSTALLED_REPLACEMENT_UNCONFIRMED",
        cause: fault,
      });
      expect(critical).not.toHaveBeenCalled();
    },
  );

  it("keeps startup fenced after the exact disposable maintenance holder dies", async () => {
    const userData = await root();
    const state = path.join(userData, "farol-next-state");
    await fs.mkdir(state, { mode: 0o700 });
    const pending = path.join(state, "installed-replacement.pending");
    await fs.writeFile(pending, "fixture replacement outcome unknown\n", {
      mode: 0o600,
    });
    const leaseModule = new URL(
      "../../src/apps/desktop/promotion-lease.ts",
      import.meta.url,
    ).href;
    const program = `import { acquirePromotionLease } from ${JSON.stringify(leaseModule)}; const lease = await acquirePromotionLease(${JSON.stringify(userData)}, 'fixture-maintenance', 'promotion'); if (!lease) throw Error('FIXTURE_BUSY'); process.stdout.write('HELD\\n'); setInterval(() => {}, 1000);`;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", program],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const closed = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = new Promise<void>((resolve, reject) => {
        let output = "";
        child.once("error", reject);
        child.stderr.on("data", (chunk: Buffer) =>
          reject(Error(chunk.toString())),
        );
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          if (output === "HELD\n") resolve();
        });
        timer = setTimeout(() => reject(Error("FIXTURE_CHILD_TIMEOUT")), 5000);
      });
      await Promise.race([
        ready,
        closed.then(() => {
          throw Error("FIXTURE_CHILD_ENDED");
        }),
      ]);
      await expectPromotionExcluded(userData);
      expect(child.kill("SIGKILL")).toBe(true);
      expect(await closed).toEqual({ code: null, signal: "SIGKILL" });
      const critical = vi.fn(async () => true);
      await expect(
        withStartupPromotionLease(userData, "candidate", critical),
      ).rejects.toThrow("STARTUP_INSTALLED_REPLACEMENT_PENDING");
      expect(critical).not.toHaveBeenCalled();
      expect(await fs.readFile(pending, "utf8")).toBe(
        "fixture replacement outcome unknown\n",
      );
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await closed;
    }
  });

  it("rechecks newly present intent before marker publication under the original lease", async () => {
    const userData = await root();
    const state = path.join(userData, "farol-next-state");
    const pending = path.join(state, "installed-replacement.pending");
    const marker = path.join(state, "running.json");
    const publish = vi.fn();
    await expect(
      withStartupPromotionLease(userData, "candidate", async (verify) => {
        await expectPromotionExcluded(userData);
        // Same-process fixture fault injection; a conforming producer cannot
        // acquire maintenance's promotion lease while this startup holds it.
        await fs.writeFile(pending, "unknown placement result\n", {
          mode: 0o600,
        });
        if (await verify()) publish();
        return true;
      }),
    ).rejects.toThrow("STARTUP_INSTALLED_REPLACEMENT_PENDING");
    expect(publish).not.toHaveBeenCalled();
    await expect(fs.lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(pending, "utf8")).toBe(
      "unknown placement result\n",
    );
  });

  it("admits only after a disposable completed recovery durably moves pending out of the fixed slot", async () => {
    const userData = await root();
    const maintenance = await acquirePromotionLease(
      userData,
      "maintenance",
      "promotion",
    );
    expect(maintenance).not.toBeNull();
    const state = path.join(userData, "farol-next-state");
    const pending = path.join(state, "installed-replacement.pending");
    const retained = path.join(state, "fixture-completed-intent");
    const bytes = "fixture known completion, no replacement exercised\n";
    try {
      await fs.writeFile(pending, bytes, { mode: 0o600 });
      await fs.rename(pending, retained);
      const directory = await fs.open(state, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      expect(await fs.readFile(retained, "utf8")).toBe(bytes);
      await expect(fs.lstat(pending)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (maintenance) await releasePromotionLease(maintenance);
    }
    let publication = false;
    await expect(
      withStartupPromotionLease(userData, "candidate", async (verify) => {
        expect(await verify()).toBe(true);
        publication = true;
        return true;
      }),
    ).resolves.toBe(true);
    expect(publication).toBe(true);
    expect(await fs.readFile(retained, "utf8")).toBe(bytes);
  });

  it("refuses startup while promotion owns the lease without touching the original marker", async () => {
    const userData = await root();
    const promotion = await acquirePromotionLease(
      userData,
      "updater",
      "promotion",
    );
    expect(promotion).not.toBeNull();
    const marker = path.join(userData, "farol-next-state", "running.json");
    const bytes = "original synthetic unconfirmed marker\n";
    await fs.writeFile(marker, bytes, { mode: 0o600 });
    const original = await fs.lstat(marker);
    let readinessCalls = 0;
    let publicationCalls = 0;
    try {
      await expect(
        withStartupPromotionLease(userData, "candidate", async () => {
          readinessCalls += 1;
          publicationCalls += 1;
          await fs.writeFile(marker, "replaced\n");
        }),
      ).rejects.toThrow("STARTUP_PROMOTION_BUSY");
      expect(readinessCalls).toBe(0);
      expect(publicationCalls).toBe(0);
      expect(await fs.readFile(marker, "utf8")).toBe(bytes);
      const retained = await fs.lstat(marker);
      expect([retained.dev, retained.ino]).toEqual([
        original.dev,
        original.ino,
      ]);
    } finally {
      await releasePromotionLease(promotion!);
    }
  });

  it("holds exclusion across readiness and publication, then releases before ordinary admission", async () => {
    const userData = await root();
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let ready!: () => void;
    const readiness = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const marker = path.join(userData, "farol-next-state", "running.json");
    const startup = withStartupPromotionLease(
      userData,
      "candidate",
      async (verify) => {
        enter();
        await readiness;
        expect(await verify()).toBe(true);
        await fs.writeFile(marker, "current synthetic runtime obligation\n", {
          mode: 0o600,
        });
        await expectPromotionExcluded(userData);
        return true;
      },
    );
    // Always settle this exact startup before disposing its roots, even if an
    // owning assertion fails. No orphan callback or lease may survive teardown.
    try {
      await Promise.race([
        entered,
        startup.then(() => {
          throw new Error("STARTUP_SECTION_NOT_ENTERED");
        }),
      ]);
      await expectPromotionExcluded(userData);
    } finally {
      ready();
      expect(await startup).toBe(true);
    }
    const admission = await acquirePromotionLease(
      userData,
      "settings",
      "admission",
    );
    expect(admission).not.toBeNull();
    try {
      expect(await fs.readFile(marker, "utf8")).toBe(
        "current synthetic runtime obligation\n",
      );
    } finally {
      await releasePromotionLease(admission!);
    }
  });
});
